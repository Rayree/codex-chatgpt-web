import { afterEach, expect, test } from "bun:test";
import { CHATSHARE_MODEL_ID, DEFAULT_CHATSHARE_SELECTORS, type ChatShareConfig } from "../src/chatshare/config";
import { createChatShareRequestHandler, startChatShareServer, type ChatShareRequestHandler } from "../src/chatshare/server";
import type { ChatShareBrowser } from "../src/chatshare/types";
import { ChatShareBrowserError } from "../src/chatshare/browser";

const config: ChatShareConfig = {
  port: 3211, token: "s".repeat(43), profileDir: "/unused/chatshare-test-profile",
  turnTimeoutMs: 1000, pollIntervalMs: 100, stableIntervalMs: 500, maxPromptChars: 24000,
  selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
};

const handlers: ChatShareRequestHandler[] = [];
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(handler => handler.stop()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(run?: ChatShareBrowser["runText"], overrides: Partial<ChatShareConfig> = {}) {
  const calls: string[] = [];
  let closes = 0;
  const browser: ChatShareBrowser = {
    async runText(prompt, options) { calls.push(prompt); return run ? run(prompt, options) : "fixture answer"; },
    async close() { closes++; },
    async status() { return { state: "ready", url: "https://chat.chatshare.tv/", message: "fixture browser" }; },
  };
  const handler = createChatShareRequestHandler({ ...config, ...overrides }, browser);
  handlers.push(handler);
  return { handler, browser, calls, closeCount: () => closes };
}

function request(body: unknown = { model: CHATSHARE_MODEL_ID, input: "Hello" }, options: {
  path?: string; method?: string; headers?: Record<string, string>; signal?: AbortSignal; url?: string;
} = {}): Request {
  const method = options.method ?? "POST";
  return new Request(options.url ?? `http://127.0.0.1:${config.port}${options.path ?? "/v1/responses"}`, {
    method,
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", ...options.headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    signal: options.signal,
  });
}

function outputText(response: any): string {
  return response.output.flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("");
}

function sseEvents(text: string): any[] {
  return text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
}

test("local routes require the bearer token and reject Origin and wrong Host", async () => {
  const { handler, calls } = fixture();
  for (const path of ["/healthz", "/v1/models"]) {
    const response = await handler.fetch(request(undefined, { path, method: "GET", headers: { authorization: "" } }));
    expect(response.status).toBe(401);
  }
  const rejectedHeaders: Record<string, string>[] = [
    { origin: "https://example.com" },
    { origin: "http://127.0.0.1:3211" },
    { host: "127.0.0.1.evil.example:3211" },
    { host: "127.0.0.1:3212" },
    { host: "localhost:3211" },
  ];
  for (const headers of rejectedHeaders) expect((await handler.fetch(request(undefined, { headers }))).status).toBe(403);
  expect((await handler.fetch(request(undefined, { url: "http://evil.example:3211/v1/responses" }))).status).toBe(403);
  expect(calls).toHaveLength(0);
  const health = await handler.fetch(request(undefined, { path: "/healthz", method: "GET" }));
  expect(health.status).toBe(200);
  expect(await health.text()).not.toContain(config.token);
});

test("model catalogue advertises the text-only bridge without an official-model claim", async () => {
  const { handler, calls } = fixture();
  const response = await handler.fetch(request(undefined, { path: "/v1/models", method: "GET" }));
  const payload = await response.json() as any;
  expect(payload.data).toHaveLength(1);
  expect(payload.data[0].id).toBe(CHATSHARE_MODEL_ID);
  expect(payload.data[0].capabilities).toEqual({
    input_modalities: ["text"], output_modalities: ["text"], tools: false,
    previous_response_id: false, usage: false, model_selection: "manual_in_browser",
  });
  expect(calls).toHaveLength(0);
});

test("complete text histories produce non-streaming Responses output with unavailable usage", async () => {
  const { handler, calls } = fixture();
  const response = await handler.fetch(request({
    model: CHATSHARE_MODEL_ID, instructions: "Use Chinese.", store: false,
    input: [{ role: "user", content: "First question" }, { role: "assistant", content: "First reply" }, { role: "user", content: "Second question" }],
  }));
  expect(response.status).toBe(200);
  const payload = await response.json() as any;
  expect(payload.status).toBe("completed");
  expect(payload.model).toBe(CHATSHARE_MODEL_ID);
  expect(outputText(payload)).toBe("fixture answer");
  expect(payload.usage).toBeNull();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("First question");
  expect(calls[0]).toContain("Second question");
});

test("unsupported modalities, tool history and continuation fail before browser execution", async () => {
  const { handler, calls } = fixture();
  const bad = [
    { model: CHATSHARE_MODEL_ID, input: "Hello", previous_response_id: "resp_previous" },
    { model: CHATSHARE_MODEL_ID, input: "Hello", tools: [] },
    { model: CHATSHARE_MODEL_ID, input: [{ type: "function_call_output", call_id: "call", output: "result" }] },
    { model: CHATSHARE_MODEL_ID, input: [{ role: "user", content: [{ type: "input_file", file_id: "file" }] }] },
    { model: "gpt-6-pro", input: "Hello" },
  ];
  for (const body of bad) {
    const response = await handler.fetch(request(body));
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.retryable).toBe(false);
  }
  const overLimit = await handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "x".repeat(config.maxPromptChars) }));
  expect(overLimit.status).toBe(413);
  expect(calls).toHaveLength(0);
});

test("SSE output carries incremental text and a single accepted final result", async () => {
  const { handler } = fixture(async (_prompt, options) => {
    options.onTextDelta?.("你好");
    return "你好，世界";
  });
  const response = await handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "Hello", stream: true }));
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const events = sseEvents(await response.text());
  expect(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("")).toBe("你好，世界");
  const completed = events.filter(event => event.type === "response.completed");
  expect(completed).toHaveLength(1);
  expect(outputText(completed[0].response)).toBe("你好，世界");
  expect(completed[0].response.usage).toBeNull();
});

test("a partial browser failure is failed, non-retryable, and never reissued", async () => {
  for (const stream of [false, true]) {
    const { handler, calls } = fixture(async (_prompt, options) => {
      options.onTextDelta?.("partial");
      throw new ChatShareBrowserError("not_ready", "Select a seat manually in the browser.");
    });
    const response = await handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "Hello", stream }));
    if (stream) {
      const events = sseEvents(await response.text());
      expect(events.some(event => event.type === "response.completed")).toBe(false);
      expect(events.find(event => event.type === "response.failed").response.error.message).toContain("Select a seat");
    } else {
      expect(response.status).toBe(502);
      const payload = await response.json() as any;
      expect(payload.status).toBe("failed");
      expect(payload.retryable).toBe(false);
    }
    expect(calls).toHaveLength(1);
  }
});

test("unexpected browser exceptions never expose prompt or handoff-token call logs", async () => {
  const privateText = "private prompt and https://chat.chatshare.tv/?token=private-token";
  for (const stream of [false, true]) {
    const { handler, calls } = fixture(async () => { throw new Error(privateText); });
    const response = await handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "Hello", stream }));
    const body = await response.text();
    expect(body).not.toContain(privateText);
    expect(body).not.toContain("private-token");
    expect(body).toContain("Inspect the browser");
    expect(calls).toHaveLength(1);
  }
});

test("busy browser requests fail with 409 instead of queueing another submission", async () => {
  const entered = deferred<void>();
  const answer = deferred<string>();
  const { handler, calls } = fixture(async (_prompt, options) => {
    options.signal?.addEventListener("abort", () => answer.reject(options.signal!.reason), { once: true });
    entered.resolve();
    return answer.promise;
  });
  const first = handler.fetch(request());
  await entered.promise;
  const second = await handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "Second" }));
  expect(second.status).toBe(409);
  expect(calls).toHaveLength(1);
  answer.resolve("first answer");
  expect((await first).status).toBe(200);
  const health = await handler.fetch(request(undefined, { method: "GET", path: "/healthz" }));
  expect((await health.json() as any).busy).toBe(false);
});

test("a prepared Plus/Pro pool permits one request per channel", async () => {
  const entered: string[] = [];
  const release = deferred<void>();
  const browser: ChatShareBrowser = {
    async runText(prompt) { entered.push(prompt); await release.promise; return prompt; },
    async close() {},
    async status() {
      return {
        state: "ready", url: "https://chat.chatshare.tv/", message: "pool", healthy: true,
        channels: {
          plus: { state: "ready", url: "", message: "plus", seat: "plus" },
          pro: { state: "ready", url: "", message: "pro", seat: "pro" },
        },
      };
    },
  };
  const handler = createChatShareRequestHandler(config, browser);
  handlers.push(handler);
  const first = handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "first" }));
  const second = handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "second" }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(entered).toHaveLength(2);
  expect(entered.some(value => value.includes("first"))).toBeTrue();
  expect(entered.some(value => value.includes("second"))).toBeTrue();
  release.resolve();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
});

test("client cancellation keeps the browser reserved until physical work settles", async () => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const release = deferred<void>();
  const { handler, calls } = fixture(async (_prompt, options) => {
    options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await release.promise;
    options.signal?.throwIfAborted();
    return "unexpected";
  }, { turnTimeoutMs: 10000 });
  const controller = new AbortController();
  const pending = handler.fetch(request(undefined, { signal: controller.signal }));
  await entered.promise;
  controller.abort();
  await aborted.promise;
  const blocked = await handler.fetch(request());
  expect(blocked.status).toBe(409);
  release.resolve();
  expect((await pending).status).toBe(499);
  expect(calls).toHaveLength(1);
});

test("cancelling the SSE reader aborts the browser without resubmission", async () => {
  const aborted = deferred<void>();
  const { handler, calls } = fixture(async (_prompt, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => { aborted.resolve(); reject(options.signal!.reason); }, { once: true });
  }));
  const response = await handler.fetch(request({ model: CHATSHARE_MODEL_ID, input: "Hello", stream: true }));
  await response.body!.cancel();
  await aborted.promise;
  expect(calls).toHaveLength(1);
});

test("deadline cancellation returns a failed timeout and does not retry", async () => {
  const { handler, calls } = fixture(async (_prompt, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
  }), { turnTimeoutMs: 20 });
  const response = await handler.fetch(request());
  expect(response.status).toBe(504);
  expect((await response.json() as any).status).toBe("failed");
  expect(calls).toHaveLength(1);
});

test("shutdown aborts active work, closes once, and refuses later requests", async () => {
  const entered = deferred<void>();
  const { handler, closeCount } = fixture(async (_prompt, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    entered.resolve();
  }));
  const pending = handler.fetch(request());
  await entered.promise;
  await handler.stop();
  await handler.stop();
  expect((await pending).status).toBe(503);
  expect(closeCount()).toBe(1);
  expect((await handler.fetch(request())).status).toBe(503);
});

test("the standalone server serves only its loopback authenticated route", async () => {
  const { browser } = fixture();
  const server = startChatShareServer({ ...config, port: 0 }, browser);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: CHATSHARE_MODEL_ID, input: "Actual local socket request" }),
    });
    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("fixture answer");
  } finally { await server.stop(); }
});
