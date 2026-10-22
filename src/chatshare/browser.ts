import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  CHATSHARE_CHAT_URL,
  CHATSHARE_ENTRY_URL,
  findChromeExecutable,
  type ChatShareConfig,
  type ChatShareSelectors,
} from "./config";
import type { BrowserStatus, ChatShareBrowser } from "./types";

export class ChatShareBrowserError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ChatShareBrowserError";
  }
}

export function isChatShareUrl(value: string, chatOnly = false): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password
      && (url.origin === new URL(CHATSHARE_CHAT_URL).origin
        || (!chatOnly && url.origin === new URL(CHATSHARE_ENTRY_URL).origin));
  } catch {
    return false;
  }
}

/** Status responses must not disclose handoff tokens in query strings or fragments. */
export function chatShareStatusUrl(value: string): string {
  if (!isChatShareUrl(value)) return "";
  const url = new URL(value);
  return url.origin + url.pathname;
}

export interface ChatShareMessageSnapshot {
  key: string;
  role: "user" | "assistant";
  order: number;
  text: string;
  complete: boolean;
  busy: boolean;
}

export interface ChatShareDomSnapshot {
  messages: ChatShareMessageSnapshot[];
  composerEditable: boolean;
  composerText: string;
  stopVisible: boolean;
  errorPresent: boolean;
}

/**
 * A self-contained, read-only page callback, also exercised against offline HTML.
 * Selectors are CSS data, never JavaScript; page text is never evaluated as code.
 */
export function readChatShareDom(options: { selectors: ChatShareSelectors }): ChatShareDomSnapshot {
  const { selectors } = options;
  const visible = (element: Element): boolean => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const select = (selector: string, root: ParentNode = document): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(selector));
  // The combined old/new selectors may match a role wrapper and its nested bubble.
  const outermost = (elements: HTMLElement[]): HTMLElement[] => elements.filter(element =>
    !elements.some(other => other !== element && other.contains(element)));
  const users = outermost(select(selectors.userMessage)).filter(visible);
  const assistants = outermost(select(selectors.assistantMessage)).filter(visible);
  const all = [...users.map(element => ({ element, role: "user" as const })),
    ...assistants.map(element => ({ element, role: "assistant" as const }))]
    .sort((left, right) => left.element === right.element ? 0
      : left.element.compareDocumentPosition(right.element) & 4 ? -1 : 1);
  const ignored = "script, style, template, noscript, button, input, textarea, select, svg, [data-streaming-response-status], [data-testid^='cot-v5']";
  const blocks = new Set(["P", "DIV", "SECTION", "ARTICLE", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "TABLE", "TR"]);
  const textFrom = (root: HTMLElement): string => {
    const read = (node: Node): string => {
      if (node.nodeType === 3) return node.nodeValue ?? "";
      if (!(node instanceof HTMLElement)) return "";
      if (node.matches(ignored) || !visible(node)) return "";
      if (node.tagName === "BR") return "\n";
      const text = Array.from(node.childNodes).map(read).join("");
      return blocks.has(node.tagName) ? `\n${text}\n` : text;
    };
    return read(root).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  const identity = (element: HTMLElement, role: string, index: number): string => {
    const attributes = ["data-message-id", "data-content-search-unit-key", "data-turn-key", "data-testid", "id"];
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value) return `${role}:${attribute}:${value}`;
    }
    const turn = element.closest("[data-turn-key], [data-testid^='conversation-turn-']");
    const turnKey = turn?.getAttribute("data-turn-key") ?? turn?.getAttribute("data-testid");
    return turnKey ? `${role}:turn:${turnKey}` : `${role}:position:${index}`;
  };
  const completionSelector = [
    'button[data-testid="copy-turn-action-button"]',
    'button[data-testid="good-response-turn-action-button"]',
    'button[data-testid="bad-response-turn-action-button"]',
    'button[data-testid="regenerate-response-button"]',
    'button[aria-label="Regenerate response"]',
    '.turn-action-controls button[aria-label="Copy"]',
    '.turn-action-controls button[aria-label="复制"]',
    '.turn-action-controls button[aria-label="重新生成回答"]',
    'button[aria-label="复制"][data-chatshare-copy="1"]',
    'button[aria-label="重新生成回复"]',
    'button[aria-label="评价回复"]',
    'button[aria-label="朗读"]',
  ].join(", ");
  const streamingSelector = '[data-is-streaming="true"], [aria-busy="true"], [data-streaming-response-status], .result-streaming, [data-talvt-turn-state]:not([data-talvt-turn-state="complete"])';
  const messages = all.map(({ element, role }, order): ChatShareMessageSnapshot => {
    let text: string;
    let complete = false;
    let busy = false;
    if (role === "user") {
      text = textFrom(element);
    } else {
      const content = outermost([
        ...(element.matches(selectors.assistantContent) ? [element] : []),
        ...select(selectors.assistantContent, element),
      ]).filter(candidate => visible(candidate)
        && !candidate.closest("[data-streaming-response-status], [data-testid^='cot-v5']"));
      text = content.map(textFrom).filter(Boolean).join("\n\n");
      // In newer renderers, the final toolbar is a sibling of the answer unit.
      // Never borrow a different assistant's toolbar from the whole conversation.
      const turn = element.closest<HTMLElement>("[data-turn-key], [data-turn-id-container], [data-testid^='conversation-turn-'], [data-talvt-turn-state], article");
      const scope = turn ?? element.parentElement ?? element;
      const scopedAssistants = assistants.filter(candidate => scope.contains(candidate));
      const isLastInScope = scopedAssistants.at(-1) === element;
      const completionActions = isLastInScope ? select(completionSelector, scope).filter(action =>
        visible(action) && !action.closest("pre, code")
        && (element.contains(action) || Boolean(element.compareDocumentPosition(action) & 4))) : [];
      const turnState = element.closest<HTMLElement>("[data-talvt-turn-state]")?.getAttribute("data-talvt-turn-state");
      complete = element.getAttribute("data-message-status") === "complete"
        || turnState === "complete"
        || completionActions.length > 0;
      busy = select(streamingSelector, scope).some(visible)
        || (element.matches(streamingSelector) && visible(element))
        || (turnState !== undefined && turnState !== "complete");
    }
    return { key: identity(element, role, order), role, order, text, complete, busy };
  });
  const composer = select(selectors.composer).find(visible);
  const composerEditable = Boolean(composer
    && composer.getAttribute("aria-disabled") !== "true"
    && !composer.hasAttribute("disabled")
    && !composer.hasAttribute("readonly")
    && (composer.isContentEditable || composer.tagName === "TEXTAREA" || composer.tagName === "INPUT"));
  const composerText = composer && (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT")
    ? (composer as HTMLInputElement).value : composer ? textFrom(composer) : "";
  return {
    messages,
    composerEditable,
    composerText,
    stopVisible: select(selectors.stopButton).some(visible),
    // Upstream turn errors can be nested inside an assistant wrapper. Excluding
    // that whole wrapper would turn a failed partial answer into false success.
    errorPresent: select(selectors.errorMessage).some(element => visible(element) && !element.closest("pre, code")),
  };
}

export function normalizedChatSharePrompt(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export type ChatShareTurnObservation = {
  phase: "waiting-user" | "waiting-answer" | "generating" | "settling" | "complete";
  text?: string;
};

/** A completed answer must belong to the newly acknowledged user turn. */
export class ChatShareTurnTracker {
  private readonly previousKeys: Set<string>;
  private readonly expectedPrompt: string;
  private candidateText = "";
  private candidateKey = "";
  private completeSince: number | undefined;
  public userAcknowledged = false;

  constructor(baseline: ChatShareDomSnapshot, prompt: string, private readonly stableIntervalMs: number) {
    this.previousKeys = new Set(baseline.messages.map(message => message.key));
    this.expectedPrompt = normalizedChatSharePrompt(prompt);
  }

  observe(snapshot: ChatShareDomSnapshot, now: number): ChatShareTurnObservation {
    if (snapshot.errorPresent) {
      throw new ChatShareBrowserError("page_error", "ChatShare displayed a conversation error. Inspect the browser; this request was not retried.");
    }
    const added = snapshot.messages.filter(message => !this.previousKeys.has(message.key));
    const newUsers = added.filter(message => message.role === "user");
    if (newUsers.length > 1) {
      throw new ChatShareBrowserError("ambiguous_turn", "Another user turn appeared during this request. The bridge will not guess which answer belongs to it.");
    }
    const user = newUsers[0];
    if (!user || normalizedChatSharePrompt(user.text) !== this.expectedPrompt) {
      this.completeSince = undefined;
      if (this.userAcknowledged) {
        throw new ChatShareBrowserError("turn_changed", "The submitted user turn disappeared or changed. This request was not retried.");
      }
      return { phase: "waiting-user" };
    }
    this.userAcknowledged = true;
    const assistant = added.filter(message => message.role === "assistant" && message.order > user.order).at(-1);
    if (!assistant || !assistant.text.trim()) {
      this.completeSince = undefined;
      return { phase: "waiting-answer" };
    }
    // Text stability alone is never completion evidence: long thinking pauses and
    // interrupted connections can leave a partial paragraph unchanged indefinitely.
    if (snapshot.stopVisible || assistant.busy || !assistant.complete || !snapshot.composerEditable) {
      this.completeSince = undefined;
      this.candidateText = assistant.text;
      this.candidateKey = assistant.key;
      return { phase: "generating" };
    }
    if (this.candidateKey !== assistant.key || this.candidateText !== assistant.text || this.completeSince === undefined) {
      this.candidateKey = assistant.key;
      this.candidateText = assistant.text;
      this.completeSince = now;
    }
    if (now - this.completeSince < this.stableIntervalMs) return { phase: "settling" };
    return { phase: "complete", text: assistant.text };
  }
}

function cancelled(): ChatShareBrowserError {
  return new ChatShareBrowserError("cancelled", "ChatShare request cancelled. It will not be resent; the next request starts a fresh chat.");
}

function checkDeadline(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
  if (Date.now() >= deadline) {
    throw new ChatShareBrowserError("timeout", "ChatShare did not produce a verified completed answer before the timeout. It will not be resent.");
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function firstVisible(page: Page, selector: string): Promise<Locator | undefined> {
  const candidates = page.locator(selector);
  for (let index = 0, count = await candidates.count(); index < count; index++) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return undefined;
}

function officialAccountHost(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com")
      || ["chat.openai.com", "auth.openai.com", "auth0.openai.com"].includes(host);
  } catch { return true; }
}

export function shouldBlockChatShareRequest(url: string, topLevelNavigation: boolean): boolean {
  return (topLevelNavigation && !isChatShareUrl(url)) || officialAccountHost(url);
}

export async function openChatShareBrowser(config: ChatShareConfig): Promise<ChatShareBrowser & { openEntry(): Promise<void> }> {
  const executablePath = await findChromeExecutable(config);
  if (!executablePath) {
    throw new ChatShareBrowserError("chrome_missing", "Google Chrome was not found. Install Chrome, or set chromeExecutablePath in the ChatShare config.");
  }
  await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      executablePath,
      headless: false,
      chromiumSandbox: true,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
  } catch {
    throw new ChatShareBrowserError("launch_failed", "Could not launch the isolated ChatShare browser. Check Chrome is installed and that no other process is using this ChatShare profile.");
  }
  return createChatShareBrowserController(config, context);
}

/** @internal The controller is exported so offline fixtures use the production turn path. */
export async function createChatShareBrowserController(
  config: ChatShareConfig,
  context: BrowserContext,
): Promise<ChatShareBrowser & { openEntry(): Promise<void> }> {
  let closed = false;
  let busy = false;
  let page: Page;
  context.on("close", () => { closed = true; });
  try {
    // Top-level pages/popups must stay on ChatShare. Third-party frames (including
    // normal user-facing verification) and CDN assets may load normally. No
    // verification is solved automatically. Official account hosts stay blocked.
    await context.route("**/*", async route => {
      const request = route.request();
      const topLevelNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      if (shouldBlockChatShareRequest(request.url(), topLevelNavigation)) {
        await route.abort("blockedbyclient");
      } else {
        await route.fallback();
      }
    });
    page = context.pages()[0] ?? await context.newPage();
    for (const extra of context.pages()) if (extra !== page) await extra.close();
    page.setDefaultTimeout(5000);
  } catch {
    await context.close().catch(() => {});
    throw new ChatShareBrowserError("initialization_failed", "Could not initialize the isolated ChatShare browser.");
  }

  const ensurePage = (chatOnly = false): void => {
    if (closed || page.isClosed()) throw new ChatShareBrowserError("browser_closed", "The ChatShare browser is closed. Restart the bridge.");
    if (!isChatShareUrl(page.url(), chatOnly)) {
      throw new ChatShareBrowserError("wrong_origin", chatOnly
        ? "Select a seat manually at the ChatShare entry page first. Only chat.chatshare.tv can be used for requests."
        : "The browser is outside the allowed ChatShare origins. Open the entry page again.");
    }
  };
  const snapshot = async (): Promise<ChatShareDomSnapshot> => {
    ensurePage(true);
    try { return await page.evaluate(readChatShareDom, { selectors: config.selectors }); }
    catch {
      ensurePage(true);
      throw new ChatShareBrowserError("dom_unavailable", "Could not read the ChatShare page. Check the configured CSS selectors and the browser page; this request was not retried.");
    }
  };
  const stopOnce = async (prompt: string): Promise<void> => {
    if (closed || page.isClosed() || !isChatShareUrl(page.url(), true)) return;
    try {
      const users = (await snapshot()).messages.filter(message => message.role === "user");
      if (users.length !== 1 || normalizedChatSharePrompt(users[0]!.text) !== normalizedChatSharePrompt(prompt)) return;
      const button = await firstVisible(page, config.selectors.stopButton);
      if (button) await button.click({ timeout: 1500, noWaitAfter: true });
    } catch { /* Cancellation cannot safely retry or turn into another submission. */ }
  };
  const openEntry = async (): Promise<void> => {
    if (busy) throw new ChatShareBrowserError("busy", "Wait for or cancel the active request before opening the entry page.");
    if (closed || page.isClosed()) throw new ChatShareBrowserError("browser_closed", "The ChatShare browser is closed. Restart the bridge.");
    try {
      await page.goto(CHATSHARE_ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      ensurePage();
    } catch (error) {
      if (error instanceof ChatShareBrowserError) throw error;
      throw new ChatShareBrowserError("entry_unavailable", "Could not load the ChatShare entry page. Check your network and try opening it again.");
    }
  };

  const browser: ChatShareBrowser & { openEntry(): Promise<void> } = {
    openEntry,
    async status(): Promise<BrowserStatus> {
      const url = chatShareStatusUrl(page.url());
      if (closed || page.isClosed()) return { state: "closed", url, message: "The isolated ChatShare browser is closed." };
      if (busy) return { state: "busy", url, message: "A ChatShare request is in progress." };
      if (!isChatShareUrl(page.url())) return { state: "unavailable", url, message: "Open the ChatShare entry page again." };
      if (!isChatShareUrl(page.url(), true)) return { state: "entry", url, message: "Choose a Free, Plus, or Pro seat manually in this browser window." };
      try {
        const state = await snapshot();
        return state.composerEditable && !state.errorPresent && !state.stopVisible
          ? { state: "ready", url, message: "ChatShare is ready. Each request will start a fresh chat." }
          : { state: "unavailable", url, message: "ChatShare is not ready. Inspect the browser for a busy seat, expired session, page error, or changed selectors." };
      } catch {
        return { state: "unavailable", url, message: "Could not read the ChatShare page. Inspect the browser and configured selectors." };
      }
    },
    async runText(prompt, options): Promise<string> {
      if (!prompt.trim() || prompt.length > config.maxPromptChars) {
        throw new ChatShareBrowserError("invalid_prompt", `Prompt must contain text and be at most ${config.maxPromptChars} characters.`);
      }
      if (busy) throw new ChatShareBrowserError("busy", "Only one ChatShare request can run at a time.");
      const signal = options.signal;
      const deadline = Date.now() + config.turnTimeoutMs;
      checkDeadline(deadline, signal);
      ensurePage(true);
      busy = true;
      let attemptedSubmission = false;
      try {
        // Reload the chat root instead of depending on a previous conversation.
        // The adapter supplies the complete message history once in this prompt.
        await page.goto(CHATSHARE_CHAT_URL, { waitUntil: "domcontentloaded", timeout: Math.min(15000, config.turnTimeoutMs) });
        checkDeadline(deadline, signal);
        ensurePage(true);
        const freshDeadline = Math.min(deadline, Date.now() + 15000);
        let emptySince: number | undefined;
        while (true) {
          checkDeadline(deadline, signal);
          ensurePage(true);
          const fresh = await snapshot();
          if (new URL(page.url()).pathname !== "/" || fresh.messages.length > 0) {
            throw new ChatShareBrowserError("fresh_chat_failed", "The ChatShare root did not open an empty conversation. No prompt was submitted; open a new chat manually and check compatibility.");
          }
          if (fresh.errorPresent || fresh.stopVisible) {
            emptySince = undefined;
            await page.goto(CHATSHARE_CHAT_URL, {
              waitUntil: "domcontentloaded",
              timeout: Math.min(15000, Math.max(1000, deadline - Date.now())),
            });
            await delay(config.pollIntervalMs, signal);
            continue;
          }
          if (fresh.composerEditable && !fresh.composerText.trim()) {
            emptySince ??= Date.now();
            if (Date.now() - emptySince >= Math.min(config.stableIntervalMs, 2000)) break;
          } else {
            emptySince = undefined;
          }
          if (Date.now() >= freshDeadline) {
            throw new ChatShareBrowserError("not_ready", "An empty, editable ChatShare conversation was not available. Select a seat manually or update the page selectors. No prompt was submitted.");
          }
          await delay(config.pollIntervalMs, signal);
        }
        const composer = await firstVisible(page, config.selectors.composer);
        if (!composer) throw new ChatShareBrowserError("composer_missing", "The ChatShare composer was not found. No prompt was submitted.");
        checkDeadline(deadline, signal);
        ensurePage(true);
        await composer.fill(prompt, { timeout: Math.min(5000, Math.max(1, deadline - Date.now())) });
        checkDeadline(deadline, signal);
        const baseline = await snapshot();
        if (baseline.messages.length || baseline.stopVisible || baseline.errorPresent
          || normalizedChatSharePrompt(baseline.composerText) !== normalizedChatSharePrompt(prompt)) {
          throw new ChatShareBrowserError("pre_submit_changed", "The empty conversation or prepared prompt changed before submission. No send action was attempted.");
        }
        const send = await firstVisible(page, config.selectors.sendButton);
        if (!send || !await send.isEnabled()) {
          throw new ChatShareBrowserError("send_unavailable", "The ChatShare send button is unavailable. No send action was attempted; inspect the browser and selectors.");
        }
        const tracker = new ChatShareTurnTracker(baseline, prompt, config.stableIntervalMs);
        checkDeadline(deadline, signal);
        ensurePage(true);
        attemptedSubmission = true;
        // Exactly one submission attempt. Never fall back to Enter or retry a
        // click after an uncertain result: the server may have accepted it.
        await send.click({ timeout: Math.min(5000, Math.max(1, deadline - Date.now())), noWaitAfter: true });
        const acknowledgeDeadline = Math.min(deadline, Date.now() + 20000);
        let conversationPath: string | undefined;
        const conversationPathKind = (path: string): "local" | "canonical" | "other" => {
          const match = path.match(/^\/c\/([^/]+)$/);
          if (!match) return "other";
          let slug: string;
          try {
            slug = decodeURIComponent(match[1]!);
          } catch {
            return "other";
          }
          return slug.startsWith("local-chatgpt:") ? "local" : "canonical";
        };
        while (true) {
          checkDeadline(deadline, signal);
          ensurePage(true);
          const path = new URL(page.url()).pathname;
          if (path !== "/") {
            if (!conversationPath) {
              conversationPath = path;
            } else if (
              conversationPathKind(conversationPath) === "local"
              && conversationPathKind(path) === "canonical"
            ) {
              // ChatShare creates a temporary local-chatgpt conversation first,
              // then redirects to the canonical conversation with a different UUID.
              conversationPath = path;
            } else if (path !== conversationPath) {
              throw new ChatShareBrowserError("conversation_changed", "The browser switched conversations during this request. It will not be resent.");
            }
          } else if (conversationPath) {
            throw new ChatShareBrowserError("conversation_changed", "The conversation closed during this request. It will not be resent.");
          }
          const observed = tracker.observe(await snapshot(), Date.now());
          if (observed.phase === "complete") {
            checkDeadline(deadline, signal);
            const answer = observed.text!;
            // Buffer until verified completion. A single append is prefix-safe
            // even when the upstream page rewrites paragraphs while thinking.
            options.onTextDelta?.(answer);
            return answer;
          }
          if (!tracker.userAcknowledged && Date.now() >= acknowledgeDeadline) {
            throw new ChatShareBrowserError("submission_unconfirmed", "Could not match a new user turn to the submitted prompt. It may have been accepted; inspect the browser. It will not be resent.");
          }
          await delay(config.pollIntervalMs, signal);
        }
      } catch (error) {
        if (attemptedSubmission) await stopOnce(prompt);
        if (signal?.aborted) throw cancelled();
        if (error instanceof ChatShareBrowserError) throw error;
        if (Date.now() >= deadline) checkDeadline(deadline, signal);
        throw new ChatShareBrowserError("browser_action_failed", attemptedSubmission
          ? "The browser action failed after a send attempt. Inspect the browser; this request will not be resent."
          : "The browser action failed before sending. Inspect the browser and page selectors.");
      } finally {
        busy = false;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await context.close();
    },
  };
  try {
    await openEntry();
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}
