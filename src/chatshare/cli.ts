#!/usr/bin/env bun
import { arch, platform } from "node:os";
import {
  CHATSHARE_MODEL_ID,
  chatSharePaths,
  findChromeExecutable,
  initializeChatShareConfig,
  loadChatShareConfig,
  type ChatShareConfig,
} from "./config";
import type { ChatShareBrowser } from "./types";

const HELP = `ChatShare experimental text bridge

  bun run chatshare init           Create a private, isolated configuration
  bun run chatshare login          Open ChatShare; choose a seat manually
  bun run chatshare doctor         Check local runtime/config/browser/server
  bun run chatshare serve          Start Chrome and the local Responses server
  bun run chatshare chat "message"  Send one text request to the running server
  bun run chatshare chat --stdin   Read a text request from standard input

Configuration: ~/.codex-chatshare (override with CHATSHARE_HOME)
Model label: ${CHATSHARE_MODEL_ID}; actual model is controlled by the website.
Text only: tools, images, and previous_response_id are not supported yet.
No changes are made to the original launcher or to Codex settings.
`;

function localUrl(config: ChatShareConfig, path: string): string {
  return `http://127.0.0.1:${config.port}${path}`;
}

export function extractResponseText(body: unknown): string {
  if (body === null || typeof body !== "object") throw new Error("The local server returned an invalid response.");
  const result = body as Record<string, unknown>;
  if (result.error && typeof result.error === "object") {
    const detail = (result.error as Record<string, unknown>).message;
    throw new Error(typeof detail === "string" ? detail : "The local text request failed.");
  }
  if (result.status !== "completed") throw new Error("The webpage did not complete this response. Check the browser before sending again.");
  const output = result.output;
  if (!Array.isArray(output)) throw new Error("The local server returned no message output.");
  const text: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && typeof part === "object" && part.type === "output_text" && typeof part.text === "string") text.push(part.text);
    }
  }
  if (!text.length) throw new Error("The local server returned no assistant text.");
  return text.join("\n");
}

async function sendChat(config: ChatShareConfig, prompt: string): Promise<void> {
  if (!prompt.trim()) throw new Error("Enter a non-empty text message.");
  if (prompt.length > config.maxPromptChars) throw new Error(`Message exceeds the configured ${config.maxPromptChars} character limit.`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, config.turnTimeoutMs + 15000);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const response = await fetch(localUrl(config, "/v1/responses"), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CHATSHARE_MODEL_ID, input: prompt, stream: false, store: false }),
      redirect: "error",
      signal: controller.signal,
    });
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error(`Local server returned HTTP ${response.status} without a JSON response.`); }
    if (!response.ok) {
      const detail = body && typeof body === "object" ? (body as { error?: { message?: unknown } }).error?.message : undefined;
      throw new Error(typeof detail === "string" ? detail : `Local server returned HTTP ${response.status}.`);
    }
    console.log(extractResponseText(body));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Text request cancelled or timed out. It has not been resubmitted; inspect the webpage before retrying.");
    if (error instanceof TypeError) throw new Error("Cannot reach the local ChatShare server. Run 'bun run chatshare serve' in another terminal.");
    throw error;
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function doctor(config: ChatShareConfig): Promise<number> {
  const chrome = await findChromeExecutable(config);
  console.log(`Runtime: Bun ${Bun.version} / ${platform()} ${arch()}`);
  console.log(`Configuration: ${chatSharePaths().configFile}`);
  console.log(`Isolated browser profile: ${config.profileDir}`);
  console.log(`Chrome: ${chrome ?? "not found (install Chrome or set chromeExecutablePath in config.json)"}`);
  console.log(`Local API: ${localUrl(config, "/v1")}`);
  console.log(`Capability: text only; model label ${CHATSHARE_MODEL_ID}`);
  try {
    const response = await fetch(localUrl(config, "/healthz"), {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      console.log(`Server: HTTP ${response.status}; check for another process on this port or a mismatched configuration.`);
      return 1;
    }
    const data = await response.json() as { service?: string; status?: string; browser?: { state?: string; message?: string } };
    if (data.service !== "chatshare-web-experimental" || data.status !== "ok") {
      console.log("Server: a different service answered on this port. Check the configured port before sending text.");
      return 1;
    }
    console.log(`Server: reachable${data.browser?.state ? `; browser ${data.browser.state}` : ""}`);
    if (data.browser?.message) console.log(`Browser: ${data.browser.message}`);
  } catch {
    console.log("Server: not running; start it with 'bun run chatshare serve'.");
  }
  return chrome ? 0 : 1;
}

async function waitForShutdown(browser: ChatShareBrowser): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopped = false;
    let checking = false;
    const finish = (error?: Error) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (error) reject(error);
      else resolve();
    };
    const onSignal = () => finish();
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { if ((await browser.status()).state === "closed") finish(); }
      catch { finish(new Error("Browser status could not be checked. The bridge has stopped; inspect the browser before restarting.")); }
      finally { checking = false; }
    }, 1000);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (!["init", "login", "doctor", "serve", "chat"].includes(command)) {
    throw new Error(`Unknown ChatShare command: ${command}. Run 'bun run chatshare --help'.`);
  }
  if (command !== "chat" && rest.length) throw new Error(`The ${command} command does not accept arguments. Configure settings in config.json.`);
  if (command === "init") {
    const { config, configFile, created } = await initializeChatShareConfig();
    console.log(`${created ? "Created" : "Using existing"} configuration: ${configFile}`);
    console.log(`Private browser profile: ${config.profileDir}`);
    console.log("The local API key stays in that private configuration file. Next: bun run chatshare login");
    return 0;
  }
  const config = await loadChatShareConfig();
  if (command === "doctor") return doctor(config);
  if (command === "chat") {
    if (rest.length !== 1) throw new Error('Usage: bun run chatshare chat "message" (or chat --stdin)');
    const prompt = rest[0] === "--stdin" ? await Bun.stdin.text() : rest[0]!;
    await sendChat(config, prompt);
    return 0;
  }
  const { openChatShareBrowser } = await import("./browser");
  const browser = await openChatShareBrowser(config);
  let server: { stop(): Promise<void> } | undefined;
  try {
    if (command === "login") {
      await browser.openEntry();
      console.log("Choose an available seat using the normal ChatShare webpage, then confirm the chat composer is usable.");
      console.log("Press Ctrl-C here to close Chrome and save this isolated browser session. Next: bun run chatshare serve");
    } else {
      const { startChatShareServer } = await import("./server");
      const running = await startChatShareServer(config, browser);
      server = running;
      console.log(`ChatShare text bridge: http://127.0.0.1:${running.port}/v1`);
      console.log("In Chrome, enter ChatShare normally and select a seat/model if requested. Keep this browser open.");
      console.log('In a second terminal: bun run chatshare chat "Please reply OK"');
      console.log("Each request opens a fresh conversation with the supplied text history. Only one request can run at a time.");
      console.log("Press Ctrl-C to stop. Tools and images are not supported in this experimental version.");
    }
    await waitForShutdown(browser);
  } finally {
    try { await server?.stop(); } finally { await browser.close(); }
  }
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    console.error(`ChatShare: ${error instanceof Error ? error.message : "Unexpected error"}`);
    process.exitCode = 1;
  }
}
