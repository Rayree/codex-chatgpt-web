import { timingSafeEqual } from "node:crypto";
import { bridgeToResponsesSSE, buildResponseJSON } from "../bridge";
import { AsyncEventQueue } from "../event-queue";
import { readJsonRequestBody } from "../http-body";
import type { AdapterEvent } from "../types";
import { CHATSHARE_MODEL_ID, type ChatShareConfig } from "./config";
import { ChatShareRequestError, compileChatShareTextPrompt, createChatShareAdapter, parseChatShareRequest } from "./adapter";
import { ChatShareBrowserError } from "./browser";
import type { ChatShareBrowser } from "./types";

interface ActiveRequest {
  abort: AbortController;
  settled: Promise<void>;
}

export interface ChatShareRequestHandler {
  fetch(request: Request): Promise<Response>;
  stop(): Promise<void>;
}

function errorResponse(status: number, code: string, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { type, code, message, retryable: false } }, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function authorized(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function localRequest(request: Request, port: number): boolean {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port || "80") !== port
    || url.username || url.password) return false;
  const host = request.headers.get("host");
  return host === null || host === `127.0.0.1:${port}` || (port === 80 && host === "127.0.0.1");
}

function failureEvent(error: unknown, signal: AbortSignal): Extract<AdapterEvent, { type: "error" }> {
  const cause = signal.aborted ? signal.reason : error;
  if (cause instanceof ChatShareRequestError) {
    return {
      type: "error", status: cause.status, errorType: cause.status >= 500 ? "server_error" : "invalid_request_error",
      code: cause.code, message: cause.message, retryable: false,
    };
  }
  if (cause instanceof ChatShareBrowserError) {
    return {
      type: "error", status: cause.code === "timeout" ? 504 : 502, errorType: "server_error",
      code: `chatshare_${cause.code}`, message: cause.message, retryable: false,
    };
  }
  return {
    type: "error",
    status: signal.aborted ? 499 : 502,
    errorType: signal.aborted ? "client_closed_request" : "server_error",
    code: signal.aborted ? "client_cancelled" : "chatshare_browser_error",
    message: signal.aborted ? "Client cancelled request; no automatic resend was attempted."
      : "The ChatShare browser request failed. Inspect the browser before trying again; no automatic resend was attempted.",
    retryable: false,
  };
}

/** Independent text-only routes: never fall through to the official Codex backend. */
export function createChatShareRequestHandler(
  config: ChatShareConfig,
  browser: ChatShareBrowser,
  options: { port?: () => number } = {},
): ChatShareRequestHandler {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(config.token)) throw new Error("ChatShare requires a valid random local bearer token.");
  const adapter = createChatShareAdapter(config, browser);
  let active: ActiveRequest | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const busy = () => errorResponse(409, "chatshare_busy", "A browser request is already running. Wait for it to settle; this request was not queued or sent.");

  return {
    async fetch(request) {
      if (!localRequest(request, options.port?.() ?? config.port)) {
        return errorResponse(403, "invalid_host", "Only the configured 127.0.0.1 host and port are accepted.");
      }
      if (request.headers.has("origin")) {
        return errorResponse(403, "origin_rejected", "Browser-originated requests are not accepted. Use the local CLI or a non-browser HTTP client.");
      }
      if (!authorized(request, config.token)) {
        return errorResponse(401, "invalid_api_key", "A valid local bearer token is required.", "authentication_error");
      }
      if (stopped) return errorResponse(503, "server_stopped", "The ChatShare bridge is stopping.", "server_error");
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        let browserState;
        try { browserState = await browser.status(); }
        catch { browserState = { state: "unavailable", url: "", message: "Browser status is unavailable." }; }
        return Response.json({
          status: "ok", service: "chatshare-web-experimental", mode: "text-only", model: CHATSHARE_MODEL_ID,
          busy: active !== undefined, browser: browserState,
        }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{
          id: CHATSHARE_MODEL_ID, object: "model", created: 0, owned_by: "chatshare-web-experimental",
          capabilities: {
            input_modalities: ["text"], output_modalities: ["text"], tools: false,
            previous_response_id: false, usage: false, model_selection: "manual_in_browser",
          },
        }] }, { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname !== "/v1/responses") {
        return errorResponse(404, "route_not_found", "Supported routes: GET /healthz, GET /v1/models, POST /v1/responses.");
      }
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST /v1/responses.");
      if (active) return busy();
      if (request.signal.aborted) return errorResponse(499, "client_cancelled", "Client cancelled request before submission.");
      if ((request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
        return errorResponse(415, "unsupported_media_type", "Content-Type must be application/json.");
      }
      let parsed;
      try {
        parsed = parseChatShareRequest(await readJsonRequestBody(request));
        compileChatShareTextPrompt(parsed, config.maxPromptChars);
      } catch (error) {
        return error instanceof ChatShareRequestError
          ? errorResponse(error.status, error.code, error.message)
          : errorResponse(400, "invalid_json", "The request body could not be read as a supported JSON request.");
      }
      // Reading a request body yields; reserve the browser only after a second busy/shutdown check.
      if (stopped) return errorResponse(503, "server_stopped", "The ChatShare bridge is stopping.", "server_error");
      if (active) return busy();
      if (request.signal.aborted) return errorResponse(499, "client_cancelled", "Client cancelled request before submission.");
      const abort = new AbortController();
      let settle!: () => void;
      const task: ActiveRequest = { abort, settled: new Promise<void>(resolve => { settle = resolve; }) };
      active = task;
      const queue = new AsyncEventQueue<AdapterEvent>();
      const onClientAbort = () => abort.abort(new ChatShareRequestError(
        "Client cancelled request; no automatic resend was attempted.", "client_cancelled", 499,
      ));
      request.signal.addEventListener("abort", onClientAbort, { once: true });
      const timeout = setTimeout(() => abort.abort(new ChatShareRequestError(
        "The browser request timed out. Inspect the browser before trying again; no automatic resend was attempted.",
        "chatshare_timeout", 504,
      )), config.turnTimeoutMs);
      let terminalFailure: Extract<AdapterEvent, { type: "error" }> | undefined;
      const run = async () => {
        try {
          await adapter.runTurn(parsed, { headers: request.headers, abortSignal: abort.signal }, event => queue.push(event));
        } catch (error) {
          terminalFailure = failureEvent(error, abort.signal);
        } finally {
          clearTimeout(timeout);
          request.signal.removeEventListener("abort", onClientAbort);
          queue.close();
          if (active === task) active = undefined;
          settle();
        }
      };
      if (parsed.stream) {
        // Keep the terminal failure outside the bounded queue so an overflowing queue
        // can still report failure without throwing again while handling the error.
        const events = (async function* () {
          yield* queue;
          if (terminalFailure) yield terminalFailure;
        })();
        const stream = bridgeToResponsesSSE(events, CHATSHARE_MODEL_ID, undefined, undefined, undefined,
          onClientAbort, 2_000, {
            hideThinkingSummary: true,
            stallTimeoutSec: Math.ceil(config.turnTimeoutMs / 1_000) + 10,
            // The website supplies no reliable token meter. Do not present bridge placeholder zeros as measurements.
            onCompletedResponse(response) { response.usage = null; },
          });
        void run();
        return new Response(stream, { headers: {
          "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive",
          "x-accel-buffering": "no", "x-chatshare-usage": "unavailable", "x-content-type-options": "nosniff",
        } });
      }
      const collected = queue.collect();
      void run();
      const events = await collected;
      if (terminalFailure) events.push(terminalFailure);
      const response = buildResponseJSON(events, CHATSHARE_MODEL_ID, { hideThinkingSummary: true });
      response.usage = null;
      return Response.json(response, {
        status: terminalFailure?.status ?? 200,
        headers: { "cache-control": "no-store", "x-chatshare-usage": "unavailable", "x-content-type-options": "nosniff" },
      });
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      const pending = active;
      pending?.abort.abort(new ChatShareRequestError("The ChatShare bridge is shutting down.", "server_stopped", 503));
      stopping = (async () => {
        await browser.close();
        await pending?.settled;
      })();
      return stopping;
    },
  };
}

export function startChatShareServer(config: ChatShareConfig, browser: ChatShareBrowser): { port: number; stop(): Promise<void> } {
  let port = config.port;
  const handler = createChatShareRequestHandler(config, browser, { port: () => port });
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: request => handler.fetch(request) });
  port = server.port!;
  let stopping: Promise<void> | undefined;
  return {
    port,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        server.stop(true);
        await handler.stop();
      })();
      return stopping;
    },
  };
}
