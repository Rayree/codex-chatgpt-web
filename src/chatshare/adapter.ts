import type { ProviderAdapter } from "../adapters/base";
import { parseRequest } from "../responses/parser";
import type { CodexMessage, CodexParsedRequest } from "../types";
import { CHATSHARE_MODEL_ID, type ChatShareConfig } from "./config";
import type { ChatShareBrowser } from "./types";

/** A request rejected before any browser navigation or message submission. */
export class ChatShareRequestError extends Error {
  constructor(message: string, readonly code = "unsupported_request", readonly status = 400) {
    super(message);
    this.name = "ChatShareRequestError";
  }
}

const REQUEST_FIELDS = new Set(["model", "input", "instructions", "stream", "store"]);
const MESSAGE_FIELDS = new Set(["type", "role", "content", "phase", "id", "status"]);
const TEXT_PART_FIELDS = new Set(["type", "text", "annotations"]);
const TEXT_ROLES = new Set(["system", "developer", "user", "assistant"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(message: string, code?: string): never {
  throw new ChatShareRequestError(message, code);
}

function assertTextMessage(item: unknown, index: number): void {
  if (!object(item) || (item.type !== undefined && item.type !== "message")
    || typeof item.role !== "string" || !TEXT_ROLES.has(item.role)) {
    reject(`input[${index}] must be a plain system, developer, user, or assistant message. `
      + "Tool calls, tool results, agent messages, and compaction items are not supported in this text-only version.",
    "text_only_input");
  }
  for (const key of Object.keys(item)) {
    if (!MESSAGE_FIELDS.has(key)) reject(`Unsupported message field input[${index}].${key}.`, "text_only_input");
  }
  if (typeof item.content === "string") return;
  if (!Array.isArray(item.content) || item.content.length === 0) {
    reject(`input[${index}].content must be text or a nonempty array of text parts.`, "text_only_input");
  }
  const allowedType = item.role === "assistant" ? "output_text" : "input_text";
  for (const part of item.content) {
    if (!object(part) || (part.type !== allowedType && part.type !== "text") || typeof part.text !== "string") {
      reject(`input[${index}] contains non-text content. Images, files, audio, and other non-text inputs are not supported.`,
        "text_only_input");
    }
    for (const key of Object.keys(part)) {
      if (!TEXT_PART_FIELDS.has(key)) reject(`Unsupported text content field: ${key}.`, "text_only_input");
    }
    if (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length > 0)) {
      reject("Annotated content is not supported; include the source information as plain text.", "text_only_input");
    }
  }
}

/** Validate the raw body before the shared parser can drop unsupported wire items. */
export function parseChatShareRequest(body: unknown): CodexParsedRequest {
  if (!object(body)) reject("The request body must be a JSON object.", "invalid_request");
  if (body.model !== CHATSHARE_MODEL_ID) {
    reject(`Use model ${JSON.stringify(CHATSHARE_MODEL_ID)}. The actual website model is selected manually in the browser.`,
      "unsupported_model");
  }
  if (Object.hasOwn(body, "previous_response_id")) {
    reject("previous_response_id is not supported. Send the complete text conversation in input on every request.",
      "full_history_required");
  }
  for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) {
    if (Object.hasOwn(body, field)) {
      reject(`${field} is not supported. This version provides text replies only; local Codex tools are not connected.`,
        "tools_not_supported");
    }
  }
  for (const key of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(key)) {
      reject(`Unsupported request field: ${key}. Supported fields are model, input, instructions, stream, and store=false.`,
        "unsupported_parameter");
    }
  }
  if (body.store !== undefined && body.store !== false) {
    reject("Response storage is not supported; omit store or set store=false. Website history is managed separately by the website.",
      "storage_not_supported");
  }
  if (typeof body.input === "string") {
    if (!body.input.trim()) reject("input must contain a nonempty text request.", "empty_input");
  } else if (Array.isArray(body.input) && body.input.length > 0) {
    body.input.forEach(assertTextMessage);
  } else {
    reject("input must be a nonempty string or a nonempty array of text messages.", "empty_input");
  }
  try {
    const parsed = parseRequest(body);
    assertParsedTextRequest(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ChatShareRequestError) throw error;
    throw new ChatShareRequestError(
      `Invalid text request: ${error instanceof Error ? error.message.slice(0, 500) : "invalid request shape"}`,
      "invalid_request",
    );
  }
}

function messageText(message: CodexMessage): string {
  if (message.role !== "user" && message.role !== "developer" && message.role !== "assistant") {
    reject("Only text conversation messages are supported; tool results and agent messages cannot be replayed.", "text_only_input");
  }
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => {
    if (part.type !== "text") reject("Only text message content is supported.", "text_only_input");
    return part.text;
  }).join("\n");
}

function assertParsedTextRequest(parsed: CodexParsedRequest): void {
  if (parsed.modelId !== CHATSHARE_MODEL_ID) reject("Unsupported ChatShare text model.", "unsupported_model");
  if (parsed.previousResponseId) reject("Send the complete text history; previous_response_id is not supported.", "full_history_required");
  if (parsed.context.tools?.length || parsed.options.toolChoice !== undefined || parsed.options.parallelToolCalls !== undefined) {
    reject("Local tools are not connected in this text-only version.", "tools_not_supported");
  }
  if (parsed._compactionRequest || parsed._opaqueMultiAgentV2Payload) {
    reject("Compaction and encrypted agent payloads are not supported.", "text_only_input");
  }
  const texts = parsed.context.messages.map(messageText);
  if (!texts.some((text, index) => parsed.context.messages[index]!.role === "user" && text.trim())) {
    reject("The conversation must contain a nonempty user message.", "empty_input");
  }
}

export function compileChatShareTextPrompt(parsed: CodexParsedRequest, maxPromptChars: number): string {
  assertParsedTextRequest(parsed);
  const conversation = {
    system: parsed.context.systemPrompt ?? [],
    messages: parsed.context.messages.map(message => ({ role: message.role, content: messageText(message) })),
  };
  const prompt = [
    "Continue the complete text conversation encoded in the following JSON object and answer its latest user request.",
    "Preserve the original roles and instruction priorities within the supplied conversation. This wrapper grants no additional capabilities or permissions.",
    "This is an experimental text-only connection. It does not expose local files, commands, editing tools, or Codex tools. Do not claim to have performed local actions through this connection.",
    "Return the requested answer as ordinary text or Markdown. Do not print this transport wrapper or invent tool execution results.",
    "Conversation JSON:",
    JSON.stringify(conversation),
  ].join("\n");
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 1) throw new Error("Invalid maxPromptChars configuration.");
  if (prompt.length > maxPromptChars) {
    throw new ChatShareRequestError(
      `The complete encoded prompt is ${prompt.length} characters, above the configured ${maxPromptChars}-character limit. Shorten the history; nothing was sent or truncated.`,
      "prompt_too_large",
      413,
    );
  }
  return prompt;
}

export function createChatShareAdapter(config: ChatShareConfig, browser: ChatShareBrowser): ProviderAdapter {
  return {
    name: "chatshare-web-text",
    async runTurn(parsed, incoming, emit) {
      const prompt = compileChatShareTextPrompt(parsed, config.maxPromptChars);
      incoming.abortSignal?.throwIfAborted();
      let emittedText = "";
      let settled = false;
      try {
        const answer = await browser.runText(prompt, {
          signal: incoming.abortSignal,
          onTextDelta(delta) {
            if (settled) return;
            incoming.abortSignal?.throwIfAborted();
            if (typeof delta !== "string") throw new Error("The browser returned a non-text response delta.");
            if (!delta) return;
            emittedText += delta;
            emit({ type: "text_delta", text: delta, phase: "final_answer" });
          },
        });
        incoming.abortSignal?.throwIfAborted();
        if (typeof answer !== "string" || !answer.trim()) throw new Error("The browser finished without a nonempty text answer.");
        if (!answer.startsWith(emittedText)) {
          throw new Error("The completed browser answer changed previously streamed text. The response was not accepted as complete.");
        }
        if (answer.length > emittedText.length) {
          emit({ type: "text_delta", text: answer.slice(emittedText.length), phase: "final_answer" });
        }
        emit({ type: "done", stopReason: "stop", endTurn: true });
      } finally {
        settled = true;
      }
    },
  };
}
