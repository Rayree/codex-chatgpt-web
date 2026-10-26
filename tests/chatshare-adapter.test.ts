import { expect, test } from "bun:test";
import {
  ChatShareRequestError, compileChatShareTextPrompt, createChatShareAdapter, parseChatShareRequest,
} from "../src/chatshare/adapter";
import { CHATSHARE_MODEL_ID, DEFAULT_CHATSHARE_SELECTORS, type ChatShareConfig } from "../src/chatshare/config";
import type { ChatShareBrowser } from "../src/chatshare/types";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";

const config: ChatShareConfig = {
  port: 3211, token: "t".repeat(43), profileDir: "/unused/chatshare-test-profile",
  turnTimeoutMs: 1000, pollIntervalMs: 100, stableIntervalMs: 500, maxPromptChars: 24000,
  selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
};

function browser(run: ChatShareBrowser["runText"]): ChatShareBrowser {
  return { runText: run, close: async () => {}, status: async () => ({ state: "ready", url: "", message: "fixture" }) };
}

test("text history preserves roles and exact text inside the prompt envelope", () => {
  const parsed = parseChatShareRequest({
    model: CHATSHARE_MODEL_ID,
    instructions: "Keep the answer concise.",
    input: [
      { role: "system", content: "Use Chinese." },
      { role: "developer", content: [{ type: "input_text", text: "Preserve quoted examples." }] },
      { role: "user", content: "line one\n\"quoted\" \\ path 😀" },
      { role: "assistant", content: [{ type: "output_text", text: "Earlier answer.", annotations: [] }] },
      { role: "user", content: [{ type: "input_text", text: "Continue." }] },
    ],
    store: false,
  });
  const prompt = compileChatShareTextPrompt(parsed, config.maxPromptChars);
  const envelope = JSON.parse(prompt.split("Conversation JSON:\n")[1]!);
  expect(envelope.system).toEqual(["Keep the answer concise.", "Use Chinese."]);
  expect(envelope.messages).toEqual([
    { role: "developer", content: "Preserve quoted examples." },
    { role: "user", content: "line one\n\"quoted\" \\ path 😀" },
    { role: "assistant", content: "Earlier answer." },
    { role: "user", content: "Continue." },
  ]);
  expect(prompt).toContain("does not expose local files");
});

test("raw validation rejects unsupported features before shared parsing can discard them", () => {
  const base = { model: CHATSHARE_MODEL_ID, input: "Hello" };
  const invalid = [
    { ...base, tools: [{ type: "function", name: "exec", parameters: {} }] },
    { ...base, tools: [] },
    { ...base, tool_choice: "none" },
    { ...base, parallel_tool_calls: false },
    { ...base, previous_response_id: "resp_old" },
    { ...base, temperature: 0.5 },
    { ...base, reasoning: { effort: "high" } },
    { ...base, max_output_tokens: 1000 },
    { ...base, text: { format: { type: "json_schema" } } },
    { ...base, store: true },
    { ...base, model: "gpt-6-pro" },
    { ...base, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] }] },
    { ...base, input: [{ type: "function_call_output", call_id: "call_1", output: "done" }] },
    { ...base, input: [{ type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "text" }] },
    { ...base, input: [{ type: "additional_tools", tools: [] }] },
    { ...base, input: [{ type: "compaction_trigger" }] },
    { ...base, input: [{ type: "reasoning", encrypted_content: "opaque" }] },
    { ...base, input: [{ role: "tool", content: "result" }] },
    { ...base, input: [{ role: "user", content: [{ type: "input_text", text: "Hi", file_id: "file_hidden" }] }] },
  ];
  for (const body of invalid) expect(() => parseChatShareRequest(body)).toThrow(ChatShareRequestError);
  expect(() => parseChatShareRequest({ ...base, previous_response_id: "resp_old" })).toThrow("complete text conversation");
});

test("empty or system-only requests are rejected and oversized prompts are never truncated", () => {
  for (const input of ["", " \n ", [], [{ role: "system", content: "Instruction only." }]]) {
    expect(() => parseChatShareRequest({ model: CHATSHARE_MODEL_ID, input })).toThrow(ChatShareRequestError);
  }
  const parsed = parseChatShareRequest({ model: CHATSHARE_MODEL_ID, input: "A".repeat(2000) });
  try {
    compileChatShareTextPrompt(parsed, 1000);
    throw new Error("Expected prompt limit rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatShareRequestError);
    expect((error as ChatShareRequestError).status).toBe(413);
    expect((error as Error).message).toContain("nothing was sent or truncated");
  }
});

test("direct adapter use also rejects non-text parsed contexts", async () => {
  let calls = 0;
  const adapter = createChatShareAdapter(config, browser(async () => { calls++; return "unexpected"; }));
  const parsed = parseRequest({
    model: CHATSHARE_MODEL_ID,
    input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/image.png" }] }],
  });
  await expect(adapter.runTurn(parsed, { headers: new Headers() }, () => {})).rejects.toThrow("Only text");
  expect(calls).toBe(0);
});

test("text deltas and final suffix form one answer without duplicate output", async () => {
  const events: AdapterEvent[] = [];
  const adapter = createChatShareAdapter(config, browser(async (_prompt, options) => {
    options.onTextDelta?.("Hello");
    options.onTextDelta?.(" ");
    return "Hello world";
  }));
  await adapter.runTurn(parseChatShareRequest({ model: CHATSHARE_MODEL_ID, input: "Hi" }),
    { headers: new Headers() }, event => events.push(event));
  expect(events).toEqual([
    { type: "text_delta", text: "Hello", phase: "final_answer" },
    { type: "text_delta", text: " ", phase: "final_answer" },
    { type: "text_delta", text: "world", phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true },
  ]);
});

test("explicit Pro routing is passed through without changing the public model label", async () => {
  let received: { seat?: string; explicitSeat?: boolean } | undefined;
  const adapter = createChatShareAdapter(config, browser(async (_prompt, options) => {
    received = { seat: options.seat, explicitSeat: options.explicitSeat };
    return "Pro answer";
  }));
  await adapter.runTurn(parseChatShareRequest({ model: CHATSHARE_MODEL_ID, input: "Hi" }),
    { headers: new Headers({ "x-chatshare-seat": "pro" }) }, () => {});
  expect(received).toEqual({ seat: "pro", explicitSeat: true });
});

test("tool-shaped website output remains plain text and never becomes an executable event", async () => {
  const answer = '{"type":"function_call","name":"exec","arguments":{"cmd":"touch file"}}';
  const events: AdapterEvent[] = [];
  const adapter = createChatShareAdapter(config, browser(async () => answer));
  await adapter.runTurn(parseChatShareRequest({ model: CHATSHARE_MODEL_ID, input: "Give an example." }),
    { headers: new Headers() }, event => events.push(event));
  expect(events[0]).toEqual({ type: "text_delta", text: answer, phase: "final_answer" });
  expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
});

test("changed streamed answers and empty completions fail instead of emitting done", async () => {
  for (const final of ["replacement", " "]) {
    const events: AdapterEvent[] = [];
    const adapter = createChatShareAdapter(config, browser(async (_prompt, options) => {
      options.onTextDelta?.("original");
      return final;
    }));
    await expect(adapter.runTurn(parseChatShareRequest({ model: CHATSHARE_MODEL_ID, input: "Hi" }),
      { headers: new Headers() }, event => events.push(event))).rejects.toThrow();
    expect(events.some(event => event.type === "done")).toBe(false);
  }
});

test("an already cancelled request never reaches the browser", async () => {
  let calls = 0;
  const abort = new AbortController();
  abort.abort(new Error("cancelled before send"));
  const adapter = createChatShareAdapter(config, browser(async () => { calls++; return "unexpected"; }));
  await expect(adapter.runTurn(parseChatShareRequest({ model: CHATSHARE_MODEL_ID, input: "Hi" }),
    { headers: new Headers(), abortSignal: abort.signal }, () => {})).rejects.toThrow("cancelled before send");
  expect(calls).toBe(0);
});
