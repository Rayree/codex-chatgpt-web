import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  ChatShareTurnTracker,
  chatShareStatusUrl,
  createChatShareBrowserController,
  isChatShareUrl,
  readChatShareDom,
  shouldBlockChatShareRequest,
  type ChatShareDomSnapshot,
  type ChatShareMessageSnapshot,
} from "../src/chatshare/browser";
import { CHATSHARE_CHAT_URL, CHATSHARE_ENTRY_URL, DEFAULT_CHATSHARE_SELECTORS, type ChatShareConfig } from "../src/chatshare/config";

const message = (role: "user" | "assistant", key: string, order: number, text: string,
  extras: Partial<ChatShareMessageSnapshot> = {}): ChatShareMessageSnapshot => ({
  role, key, order, text, complete: role === "assistant", busy: false, ...extras,
});
const snapshot = (messages: ChatShareMessageSnapshot[] = [], extras: Partial<ChatShareDomSnapshot> = {}): ChatShareDomSnapshot => ({
  messages, composerEditable: true, composerText: "", stopVisible: false, errorPresent: false, ...extras,
});

test("ChatShare origin allowlist rejects lookalikes, credentials, ports, and official login hosts", () => {
  expect(isChatShareUrl("https://chatshare.tv/")).toBeTrue();
  expect(isChatShareUrl("https://chat.chatshare.tv/c/123?handoff=secret#secret", true)).toBeTrue();
  expect(isChatShareUrl("https://chatshare.tv/", true)).toBeFalse();
  for (const url of ["https://chatgpt.com/", "https://auth.openai.com/", "https://chatshare.tv.evil.test/", "https://chatshare.tv:8443/", "http://chatshare.tv/", "https://user:secret@chatshare.tv/", "about:blank"]) {
    expect(isChatShareUrl(url)).toBeFalse();
  }
  expect(chatShareStatusUrl("https://chat.chatshare.tv/c/123?handoff=secret#secret")).toBe("https://chat.chatshare.tv/c/123");
  expect(chatShareStatusUrl("https://other.test/?token=secret")).toBe("");
});

test("verification iframes may load, while top-level escape and official account hosts remain blocked", () => {
  expect(shouldBlockChatShareRequest("https://verification.example.test/frame", false)).toBeFalse();
  expect(shouldBlockChatShareRequest("https://verification.example.test/frame", true)).toBeTrue();
  expect(shouldBlockChatShareRequest("https://chat.chatshare.tv/", true)).toBeFalse();
  expect(shouldBlockChatShareRequest("https://auth.openai.com/", false)).toBeTrue();
  expect(shouldBlockChatShareRequest("https://chatgpt.com/", false)).toBeTrue();
});

test("an old completed assistant cannot satisfy a newly submitted prompt", () => {
  const previous = [message("user", "old-user", 0, "Earlier"), message("assistant", "old-answer", 1, "Old answer")];
  const tracker = new ChatShareTurnTracker(snapshot(previous), "New prompt", 1000);
  expect(tracker.observe(snapshot(previous), 0).phase).toBe("waiting-user");
  expect(tracker.observe(snapshot([...previous, message("user", "new-user", 2, "New prompt")]), 5000).phase).toBe("waiting-answer");
  const completed = snapshot([...previous, message("user", "new-user", 2, "New prompt"), message("assistant", "new-answer", 3, "Correct answer")]);
  expect(tracker.observe(completed, 6000).phase).toBe("settling");
  expect(tracker.observe(completed, 7000)).toEqual({ phase: "complete", text: "Correct answer" });
});

test("assistant text before a matching new user turn is never accepted", () => {
  const tracker = new ChatShareTurnTracker(snapshot(), "My exact prompt", 500);
  expect(tracker.observe(snapshot([message("assistant", "stale", 0, "Old answer")]), 0).phase).toBe("waiting-user");
  expect(tracker.observe(snapshot([message("assistant", "stale", 0, "Old answer"), message("user", "u", 1, "My exact prompt")]), 5000).phase).toBe("waiting-answer");
  expect(new ChatShareTurnTracker(snapshot(), "My exact prompt", 500)
    .observe(snapshot([message("user", "u", 0, "A different prompt"), message("assistant", "a", 1, "Unrelated answer")]), 10000).phase).toBe("waiting-user");
});

test("long stable thinking and a missing stop button do not complete without turn evidence", () => {
  const tracker = new ChatShareTurnTracker(snapshot(), "Question", 500);
  const messages = [message("user", "u", 0, "Question"), message("assistant", "a", 1, "Partial answer", { complete: false })];
  expect(tracker.observe(snapshot(messages, { stopVisible: true }), 0).phase).toBe("generating");
  expect(tracker.observe(snapshot(messages), 60000).phase).toBe("generating");
  const marked = [messages[0]!, { ...messages[1]!, complete: true }];
  expect(tracker.observe(snapshot(marked, { stopVisible: true }), 120000).phase).toBe("generating");
  expect(tracker.observe(snapshot([marked[0]!, { ...marked[1]!, busy: true }]), 180000).phase).toBe("generating");
  expect(tracker.observe(snapshot(marked), 180500).phase).toBe("settling");
  expect(tracker.observe(snapshot(marked), 181000).phase).toBe("complete");
});

test("a rapid completed turn does not need a previously observed stop button", () => {
  const tracker = new ChatShareTurnTracker(snapshot(), " hello\nworld ", 500);
  const completed = snapshot([message("user", "u", 0, "hello world"), message("assistant", "a", 1, "Done")]);
  expect(tracker.observe(completed, 0).phase).toBe("settling");
  expect(tracker.observe(completed, 500)).toEqual({ phase: "complete", text: "Done" });
});

test("completion must remain stable after answer rewrites and resumed generation", () => {
  const tracker = new ChatShareTurnTracker(snapshot(), "Q", 500);
  const page = (text: string, stopVisible = false) => snapshot([message("user", "u", 0, "Q"), message("assistant", "a", 1, text)], { stopVisible });
  expect(tracker.observe(page("A"), 0).phase).toBe("settling");
  expect(tracker.observe(page("Changed"), 499).phase).toBe("settling");
  expect(tracker.observe(page("Changed", true), 600).phase).toBe("generating");
  expect(tracker.observe(page("Changed"), 1000).phase).toBe("settling");
  expect(tracker.observe(page("Changed"), 1500)).toEqual({ phase: "complete", text: "Changed" });
});

test("interfering turns, lost acknowledgement, and upstream errors fail explicitly", () => {
  const tracker = new ChatShareTurnTracker(snapshot(), "Q", 500);
  const current = snapshot([message("user", "u", 0, "Q"), message("assistant", "a", 1, "A")]);
  tracker.observe(current, 0);
  expect(() => tracker.observe(snapshot(), 100)).toThrow("disappeared or changed");
  expect(() => new ChatShareTurnTracker(snapshot(), "Q", 500).observe(snapshot([
    message("user", "u", 0, "Q"), message("assistant", "a", 1, "A"), message("user", "other", 2, "Unexpected"),
  ]), 0)).toThrow("Another user turn");
  expect(() => new ChatShareTurnTracker(snapshot(), "Q", 500).observe(snapshot([], { errorPresent: true }), 0)).toThrow("conversation error");
});

// Real browser fixtures are completely offline. Set this to a locally installed
// Chrome/Chromium binary; no authenticated profile or live seat is used.
const chrome = process.env.CHATSHARE_TEST_CHROME;
describe.skipIf(!chrome)("ChatShare DOM fixtures in Chromium", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext();
    await context.route("**/*", route => route.abort());
    page = await context.newPage();
  });
  afterAll(async () => { await browser?.close(); });
  const read = async (html: string) => {
    await page.setContent(html);
    return page.evaluate(readChatShareDom, { selectors: {
      ...DEFAULT_CHATSHARE_SELECTORS,
      userMessage: '[data-message-author-role="user"], [data-user-message-bubble]',
      assistantMessage: '[data-message-author-role="assistant"], [data-content-search-unit-key]:has([data-conversation-role="assistant"])',
      assistantContent: '.markdown, [data-markdown-text-style="assistant-message"]',
    } });
  };
  const composer = '<div id="prompt-textarea" contenteditable="true"></div>';
  test("old DOM binds user and answer, removes toolbar text, and finds sibling completion controls", async () => {
    const result = await read(`${composer}<article data-testid="conversation-turn-1"><div data-message-author-role="user"><div data-user-message-bubble>Question</div></div></article>
      <article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><p>Answer</p><pre><code>if (ok) {\n  run();\n}</code><button>Copy code</button></pre></div></div><button data-testid="copy-turn-action-button">Copy</button></article>`);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]!.text).toBe("Question");
    expect(result.messages[1]!.text).toBe("Answer\n\nif (ok) {\n  run();\n}");
    expect(result.messages[1]!.complete).toBeTrue();
    expect(result.composerEditable).toBeTrue();
  });
  test("new DOM identifies a final answer without treating thinking as final content", async () => {
    const result = await read(`${composer}<div data-turn-key="turn-1"><div data-user-message-bubble>Question</div>
      <div data-streaming-response-status style="display:none">Thinking</div>
      <div data-content-search-unit-key="final"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-markdown-text-style="assistant-message"><p>Final answer</p></div></div>
      <div class="turn-action-controls"><button aria-label="Copy">Copy</button></div></div>`);
    expect(result.messages.length).toBe(2);
    expect(result.messages[1]!.text).toBe("Final answer");
    expect(result.messages[1]!.complete).toBeTrue();
    expect(result.messages[1]!.busy).toBeFalse();
  });
  test("a sibling toolbar belongs only to the final assistant unit in a shared turn", async () => {
    const result = await read(`${composer}<div data-turn-key="turn-1"><div data-user-message-bubble>Question</div>
      <div data-content-search-unit-key="thinking"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-markdown-text-style="assistant-message">Thinking notes</div></div>
      <div data-content-search-unit-key="final"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-markdown-text-style="assistant-message">Final answer</div></div>
      <div class="turn-action-controls"><button aria-label="Copy">Copy</button></div></div>`);
    expect(result.messages.map(item => item.text)).toEqual(["Question", "Thinking notes", "Final answer"]);
    expect(result.messages[1]!.complete).toBeFalse();
    expect(result.messages[2]!.complete).toBeTrue();
  });
  test("a live thinking status prevents completion even if toolbar controls exist", async () => {
    const result = await read(`${composer}<div data-turn-key="turn-1"><div data-user-message-bubble>Q</div>
      <div data-streaming-response-status>Working</div><div data-content-search-unit-key="final"><h4 data-conversation-role="assistant"></h4><div data-markdown-text-style="assistant-message">Partial</div></div>
      <div class="turn-action-controls"><button aria-label="Copy">Copy</button></div></div>`);
    expect(result.messages[1]!.busy).toBeTrue();
    expect(new ChatShareTurnTracker(snapshot(), "Q", 500).observe(result, 10000).phase).toBe("generating");
  });
  test("an upstream error inside the assistant wrapper prevents a false partial success", async () => {
    const result = await read(`${composer}<article data-testid="conversation-turn-1"><div data-message-author-role="user">Q</div>
      <div data-message-author-role="assistant"><div class="markdown">Partial</div><div data-testid="conversation-turn-error">Service unavailable</div></div>
      <button data-testid="copy-turn-action-button">Copy</button></article>`);
    expect(result.errorPresent).toBeTrue();
    expect(() => new ChatShareTurnTracker(snapshot(), "Q", 500).observe(result, 10000)).toThrow("conversation error");
  });
  test("old assistant controls cannot complete the new answer and hidden messages are ignored", async () => {
    const result = await read(`${composer}<article data-testid="conversation-turn-old"><div data-message-author-role="assistant"><div class="markdown">Old</div></div><button data-testid="copy-turn-action-button">Copy</button></article>
      <div hidden data-message-author-role="user">Hidden</div><article data-testid="conversation-turn-new"><div data-message-author-role="user">Q</div><div data-message-author-role="assistant"><div class="markdown">Partial<button>Copy code</button></div></div></article>`);
    expect(result.messages.map(item => item.text)).toEqual(["Old", "Q", "Partial"]);
    expect(result.messages[0]!.complete).toBeTrue();
    expect(result.messages[2]!.complete).toBeFalse();
  });

  const offlineChat = `<!doctype html><html><body>
    <main id="messages"></main><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>
    <script>
      const composer = document.querySelector('textarea');
      const send = document.querySelector('[data-testid="send-button"]');
      send.addEventListener('click', () => {
        const prompt = composer.value;
        window.fixtureEvent('send:' + prompt);
        const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user'; user.textContent = prompt;
        const turn = document.createElement('article'); turn.dataset.testid = 'conversation-turn-1';
        const assistant = document.createElement('div'); assistant.dataset.messageAuthorRole = 'assistant';
        const content = document.createElement('div'); content.className = 'markdown'; content.textContent = 'Partial';
        assistant.append(content); turn.append(user, assistant); document.querySelector('main').append(turn);
        composer.value = ''; const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop'; document.body.append(stop);
        let timer;
        stop.addEventListener('click', () => { clearTimeout(timer); stop.remove(); window.fixtureEvent('stop:' + prompt); });
        if (!prompt.includes('pending')) timer = setTimeout(() => {
          content.textContent = 'Answer: ' + prompt; stop.remove();
          const copy = document.createElement('button'); copy.dataset.testid = 'copy-turn-action-button'; copy.textContent = 'Copy'; turn.append(copy);
        }, 100);
      });
    </script></body></html>`;

  const offlineController = async (turnTimeoutMs = 3000) => {
    const context = await browser.newContext();
    const events: string[] = [];
    const requests: Array<{ url: string; method: string }> = [];
    await context.exposeBinding("fixtureEvent", (_source, event: string) => { events.push(event); });
    await context.route("**/*", async route => {
      const request = route.request();
      requests.push({ url: request.url(), method: request.method() });
      if (request.url() === CHATSHARE_ENTRY_URL) {
        await route.fulfill({ contentType: "text/html", body: "<h1>Select a seat manually</h1>" });
      } else if (request.url() === CHATSHARE_CHAT_URL) {
        await route.fulfill({ contentType: "text/html", body: offlineChat });
      } else if (request.url() === "https://verification.example.test/frame") {
        await route.fulfill({ contentType: "text/html", body: "<p>Manual verification placeholder</p>" });
      } else {
        await route.abort();
      }
    });
    const config: ChatShareConfig = {
      port: 3211, token: "offline-test-key", profileDir: "/unused-offline-fixture",
      turnTimeoutMs, pollIntervalMs: 20, stableIntervalMs: 50, maxPromptChars: 24000,
      selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
    };
    const controller = await createChatShareBrowserController(config, context);
    return { controller, page: context.pages()[0]!, events, requests };
  };

  test("production turn path requires manual entry and starts fresh once per request", async () => {
    const fixture = await offlineController();
    try {
      expect((await fixture.controller.status()).state).toBe("entry");
      await expect(fixture.controller.runText("Not entered", {})).rejects.toThrow("Select a seat manually");
      expect(fixture.requests).toEqual([{ url: CHATSHARE_ENTRY_URL, method: "GET" }]);
      await fixture.page.goto(CHATSHARE_CHAT_URL);
      const deltas: string[] = [];
      expect(await fixture.controller.runText("First", { onTextDelta: text => deltas.push(text) })).toBe("Answer: First");
      expect(deltas).toEqual(["Answer: First"]);
      expect(await fixture.controller.runText("Second", {})).toBe("Answer: Second");
      expect(fixture.events).toEqual(["send:First", "send:Second"]);
      const state = await fixture.page.evaluate(readChatShareDom, { selectors: { ...DEFAULT_CHATSHARE_SELECTORS } });
      expect(state.messages.filter(item => item.role === "user").map(item => item.text)).toEqual(["Second"]);
      expect(fixture.requests.every(request => request.method === "GET")).toBeTrue();
    } finally { await fixture.controller.close(); }
  });

  test("production navigation guard permits an inert external frame but blocks leaving ChatShare", async () => {
    const fixture = await offlineController();
    try {
      await fixture.page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.src = "https://verification.example.test/frame";
        document.body.append(frame);
      });
      await fixture.page.frameLocator("iframe").locator("p").waitFor();
      expect(await fixture.page.frameLocator("iframe").locator("p").textContent()).toBe("Manual verification placeholder");
      let failure: unknown;
      try { await fixture.page.goto("https://elsewhere.example.test/"); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(fixture.requests.some(request => request.url === "https://elsewhere.example.test/")).toBeFalse();
    } finally { await fixture.controller.close(); }
  });

  test("production cancellation stops once without resending and the next request is fresh", async () => {
    const fixture = await offlineController();
    try {
      await fixture.page.goto(CHATSHARE_CHAT_URL);
      const abort = new AbortController();
      const running = fixture.controller.runText("pending cancellation", { signal: abort.signal });
      // Attach the rejection handler before aborting so no rejected task leaks.
      const outcome = running.then(answer => ({ answer, error: undefined }), (error: Error) => ({ answer: undefined, error }));
      await fixture.page.waitForSelector('[data-testid="stop-button"]');
      abort.abort();
      const result = await outcome;
      expect(result.error?.message).toContain("cancelled");
      expect(fixture.events).toEqual(["send:pending cancellation", "stop:pending cancellation"]);
      expect(await fixture.controller.runText("After cancellation", {})).toBe("Answer: After cancellation");
      expect(fixture.events.filter(event => event.startsWith("send:"))).toEqual(["send:pending cancellation", "send:After cancellation"]);
    } finally { await fixture.controller.close(); }
  });

  test("production timeout rejects partial text and never retries submission", async () => {
    const fixture = await offlineController(2000);
    try {
      await fixture.page.goto(CHATSHARE_CHAT_URL);
      const deltas: string[] = [];
      let failure: unknown;
      try { await fixture.controller.runText("pending timeout", { onTextDelta: text => deltas.push(text) }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("timeout");
      expect(deltas).toEqual([]);
      expect(fixture.events).toEqual(["send:pending timeout", "stop:pending timeout"]);
    } finally { await fixture.controller.close(); }
  });
});
