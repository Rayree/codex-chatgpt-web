import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  ChatShareBrowserError,
  ChatShareTurnTracker,
  chatShareStatusUrl,
  createChatShareBrowserController,
  isChatShareBridgeDraft,
  isChatShareUrl,
  openChatShareChannelPool,
  readChatShareDom,
  seatAuthorizationRequiresReentry,
  shouldBlockChatShareRequest,
  type ChatShareDomSnapshot,
  type ChatShareMessageSnapshot,
} from "../src/chatshare/browser";
import { CHATSHARE_CHAT_URL, CHATSHARE_ENTRY_URL, DEFAULT_CHATSHARE_SELECTORS, type ChatShareConfig } from "../src/chatshare/config";
import { ChatShareChannelPool } from "../src/chatshare/pool";
import type { ChatShareBrowser, ChatShareSeat } from "../src/chatshare/types";

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

test("long folded user bubbles still acknowledge the exact submitted prompt", () => {
  const prompt = "P".repeat(2400);
  const tracker = new ChatShareTurnTracker(snapshot(), prompt, 50);
  const folded = snapshot([message("user", "u", 0, `${prompt.slice(0, 1570)}显示更多`)]);
  expect(tracker.observe(folded, 0).phase).toBe("waiting-answer");
  expect(tracker.userAcknowledged).toBeTrue();
});

test("re-entry clears only an exact bridge draft and preserves a real user draft", () => {
  const bridgeDrafts = new Set(["bridge prompt"]);
  expect(isChatShareBridgeDraft("bridge\n prompt", bridgeDrafts)).toBeTrue();
  expect(isChatShareBridgeDraft("a user draft", bridgeDrafts)).toBeFalse();
});

test("seat authorization state requires re-entry without treating generic page words as expiry", () => {
  expect(seatAuthorizationRequiresReentry(snapshot([], {}))).toBeFalse();
  expect(seatAuthorizationRequiresReentry(snapshot([], { seatAuthorizationInvalid: true }))).toBeTrue();
});

test.each(["before", "after"] as const)("a browser action timeout %s a send attempt preserves the pool retry boundary", async phase => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  let pool: ChatShareChannelPool | undefined;
  let draft = "";
  let sendCalls = 0;
  let proCalls = 0;
  const deltas: string[] = [];
  const failAfterDeadline = () => {
    clock.mockReturnValue(1001);
    // Playwright action errors are not ChatShareBrowserError instances.
    throw new Error("Browser action exceeded its timeout");
  };
  const composer = {
    isVisible: async () => true,
    fill: async (text: string) => {
      if (phase === "before") failAfterDeadline();
      draft = text;
    },
  };
  const send = {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => { sendCalls++; failAfterDeadline(); },
  };
  const page = {
    url: () => CHATSHARE_CHAT_URL,
    isClosed: () => false,
    setDefaultTimeout() {},
    goto: async () => { draft = ""; },
    evaluate: async () => snapshot([], { composerText: draft }),
    locator: (selector: string) => {
      const target = selector === DEFAULT_CHATSHARE_SELECTORS.composer ? composer
        : selector === DEFAULT_CHATSHARE_SELECTORS.sendButton ? send : undefined;
      return { count: async () => target ? 1 : 0, nth: () => target };
    },
  } as unknown as Page;
  const context = { on() {}, route: async () => {} } as unknown as BrowserContext;
  try {
    const controller = await createChatShareBrowserController({
      port: 3211, token: "offline-test-key", profileDir: "/unused-offline-fixture",
      turnTimeoutMs: 1000, pollIntervalMs: 1, stableIntervalMs: 0, maxPromptChars: 24000,
      selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
    }, context, { page, ownsContext: false, initialOpen: false, seat: "plus" });
    pool = new ChatShareChannelPool({
      plus: controller,
      pro: {
        status: async () => ({ state: "ready", url: CHATSHARE_CHAT_URL, message: "ready", seat: "pro" }),
        runText: async () => { proCalls++; return "Pro answer"; },
        close: async () => {},
      },
    });
    const pending = pool.runText("Only send once", { onTextDelta: text => deltas.push(text) });
    if (phase === "after") {
      await expect(pending).rejects.toMatchObject({ code: "timeout", submission: "unknown" });
      expect(sendCalls).toBe(1);
      expect(proCalls).toBe(0);
    } else {
      expect(await pending).toBe("Pro answer");
      expect(sendCalls).toBe(0);
      expect(proCalls).toBe(1);
    }
    expect(deltas).toEqual([]);
  } finally {
    clock.mockRestore();
    await pool?.close();
  }
});

test.each(["before-send", "before-poll", "delayed-ack", "after-poll", "no-ack", "foreign", "ambiguous", "stop-error"] as const)(
  "cancellation verifies the submitted turn and attempts Stop at most once (%s)", async phase => {
    const abort = new AbortController();
    const events: string[] = [];
    const deltas: string[] = [];
    let draft = "";
    let submitted = false;
    let postSendReads = 0;
    let proCalls = 0;
    const composer = {
      isVisible: async () => true,
      fill: async (text: string) => { draft = text; if (phase === "before-send") abort.abort(); },
    };
    const send = {
      isVisible: async () => true, isEnabled: async () => true,
      click: async () => {
        submitted = true;
        events.push("send");
        if (phase !== "after-poll") abort.abort();
      },
    };
    const stop = {
      isVisible: async () => submitted,
      click: async () => {
        events.push("stop");
        if (phase === "stop-error") throw new Error("Stop click acknowledgement failed");
      },
    };
    const page = {
      url: () => CHATSHARE_CHAT_URL, isClosed: () => false, setDefaultTimeout() {},
      goto: async () => { draft = ""; submitted = false; },
      evaluate: async () => {
        if (!submitted) return snapshot([], { composerText: draft });
        postSendReads++;
        if (phase === "after-poll" && postSendReads === 1) abort.abort();
        if (phase === "no-ack" || (phase === "delayed-ack" && postSendReads === 1)) {
          return snapshot([], { stopVisible: true });
        }
        const users = [message("user", "new-user", 0, phase === "foreign" ? "Someone else's prompt" : "Only send once")];
        if (phase === "ambiguous") users.push(message("user", "other-user", 1, "Another turn"));
        return snapshot(users, { stopVisible: true });
      },
      locator: (selector: string) => {
        const target = selector === DEFAULT_CHATSHARE_SELECTORS.composer ? composer
          : selector === DEFAULT_CHATSHARE_SELECTORS.sendButton ? send
          : selector === DEFAULT_CHATSHARE_SELECTORS.stopButton ? stop : undefined;
        return { count: async () => target ? 1 : 0, nth: () => target };
      },
    } as unknown as Page;
    const context = { on() {}, route: async () => {} } as unknown as BrowserContext;
    const controller = await createChatShareBrowserController({
      port: 3211, token: "offline-test-key", profileDir: "/unused-offline-fixture",
      turnTimeoutMs: 3000, pollIntervalMs: 5, stableIntervalMs: 0, maxPromptChars: 24000,
      selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
    }, context, { page, ownsContext: false, initialOpen: false, seat: "plus" });
    const pool = new ChatShareChannelPool({
      plus: controller,
      pro: {
        status: async () => ({ state: "ready", url: CHATSHARE_CHAT_URL, message: "ready", seat: "pro" }),
        runText: async () => { proCalls++; return "Must not resend"; },
        close: async () => {},
      },
    });
    try {
      await expect(pool.runText("Only send once", { signal: abort.signal, onTextDelta: text => deltas.push(text) }))
        .rejects.toMatchObject({ code: "cancelled", submission: phase === "before-send" ? "none" : "unknown" });
      const canStop = ["before-poll", "delayed-ack", "after-poll", "stop-error"].includes(phase);
      expect(events).toEqual(phase === "before-send" ? [] : canStop ? ["send", "stop"] : ["send"]);
      expect(proCalls).toBe(0);
      expect(deltas).toEqual([]);
    } finally { await pool.close(); }
  },
);

async function seatEntryFixture(seat: ChatShareSeat, offeredModel = "GPT-6 Astra", turnTimeoutMs = 10000) {
  let url = CHATSHARE_ENTRY_URL;
  let pickerSeen!: () => void;
  let modelSeen!: () => void;
  const pickerChecked = new Promise<void>(resolve => { pickerSeen = resolve; });
  const modelChecked = new Promise<void>(resolve => { modelSeen = resolve; });
  let reopened!: () => void;
  const pickerReopened = new Promise<void>(resolve => { reopened = resolve; });
  let loadingSeen!: () => void;
  let composerSeen!: () => void;
  let menuDismissed!: () => void;
  const loadingChecked = new Promise<void>(resolve => { loadingSeen = resolve; });
  const composerChecked = new Promise<void>(resolve => { composerSeen = resolve; });
  const menuClosed = new Promise<void>(resolve => { menuDismissed = resolve; });
  const ready = { picker: false, model: false, profileLoading: false, composerEditable: true };
  const menu = { visible: false, modelReadyOnOpen: false, hidesComposer: false };
  const clicks: string[] = [];
  const one = (target: unknown) => ({ count: async () => 1, nth: () => target });
  const picker = {
    isVisible: async () => ready.picker,
    isEnabled: async () => true,
    press: async (key: string) => {
      expect(key).toBe("Escape");
      clicks.push("escape");
      menu.visible = false;
      menuDismissed();
    },
    click: async () => {
      clicks.push("picker");
      menu.visible = !menu.visible;
      if (menu.visible && menu.modelReadyOnOpen) ready.model = true;
      if (clicks.filter(click => click === "picker").length === 2) reopened();
    },
  };
  const page = {
    url: () => url,
    isClosed: () => false,
    setDefaultTimeout() {},
    goto: async (target: string) => { url = target; },
    // An editable composer must not make an unconfigured seat ready.
    evaluate: async () => { composerSeen(); return snapshot([], { composerEditable: ready.composerEditable && !(menu.visible && menu.hidesComposer) }); },
    getByText: (name: RegExp) => ({ first: () => ({ isVisible: async () => {
      loadingSeen();
      return ready.profileLoading && name.test("正在加载个人资料");
    } }) }),
    locator: (selector: string) => {
      if (selector === "button") return { filter: ({ hasText }: { hasText: RegExp }) => {
        expect(hasText.test(`进入 ${seat === "plus" ? "Plus" : "Pro"}`)).toBeTrue();
        return one({ isVisible: async () => true, click: async () => { clicks.push(seat); url = CHATSHARE_CHAT_URL; } });
      } };
      if (selector === 'button[aria-label="选择 ChatGPT 模型"]') return {
        count: async () => { pickerSeen(); return ready.picker ? 1 : 0; },
        nth: () => picker,
      };
      if (selector === '[role="menu"], [role="menuitemradio"]') return one({ isVisible: async () => menu.visible });
      throw new Error(`Unexpected locator: ${selector}`);
    },
    getByRole: (role: string, { name }: { name: RegExp }) => ({ first: () => {
      if (role === "menuitemradio") return {
        isVisible: async () => { modelSeen(); return menu.visible && ready.model && name.test(offeredModel); },
        isEnabled: async () => true,
        click: async () => { clicks.push(offeredModel); },
      };
      if (role === "menuitem") return {
        isVisible: async () => name.test(seat === "plus" ? "Instant" : "Extra High"),
        click: async () => { clicks.push(seat === "plus" ? "none" : "max"); menu.visible = false; },
      };
      throw new Error(`Unexpected role: ${role}`);
    } }),
  } as unknown as Page;
  const context = { on() {}, route: async () => {} } as unknown as BrowserContext;
  const controller = await createChatShareBrowserController({
    port: 3211, token: "offline-test-key", profileDir: "/unused-offline-fixture",
    turnTimeoutMs, pollIntervalMs: 1, stableIntervalMs: 0, maxPromptChars: 24000,
    selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
  }, context, { page, ownsContext: false, initialOpen: false, seat });
  return { controller, page, ready, menu, clicks, pickerChecked, modelChecked, pickerReopened, loadingChecked, composerChecked, menuClosed };
}

test.each(["plus", "pro"] as const)("seat entry waits for the delayed %s picker and GPT-6 menu before becoming ready", async seat => {
  const fixture = await seatEntryFixture(seat);
  let settled = false;
  const outcome = fixture.controller.openSeat(seat).then(
    () => { settled = true; return undefined; },
    error => { settled = true; return error; },
  );
  try {
    await fixture.pickerChecked;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBeFalse();
    expect(await fixture.controller.status()).toMatchObject({ state: "entry", healthy: false });
    // Direct callers must also be refused until the model is configured.
    await expect(fixture.controller.runText("Do not send during setup", {})).rejects.toMatchObject({ code: "not_ready", submission: "none" });
    fixture.ready.picker = true;
    await fixture.modelChecked;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBeFalse();
    expect((await fixture.controller.status()).state).toBe("entry");
    fixture.ready.model = true;
    expect(await outcome).toBe(undefined);
    expect(fixture.clicks).toEqual([seat, "picker", "GPT-6 Astra", seat === "plus" ? "none" : "max"]);
    expect(await fixture.controller.status()).toMatchObject({ state: "ready", seat, actualModel: "GPT-6", healthy: true });
  } finally {
    fixture.ready.picker = true;
    fixture.ready.model = true;
    await fixture.controller.close();
    await outcome;
  }
});

test.each(["plus", "pro"] as const)("seat entry reopens the %s menu closed by profile loading and selects only GPT-6", async seat => {
  const fixture = await seatEntryFixture(seat, "GPT-6", 3000);
  fixture.ready.picker = true;
  const outcome = fixture.controller.openSeat(seat).then(() => undefined, error => error);
  try {
    await fixture.modelChecked;
    // Loading dismisses the first menu. Its data is available on the next open.
    fixture.menu.visible = false;
    fixture.menu.modelReadyOnOpen = true;
    expect(await fixture.controller.status()).toMatchObject({ state: "entry", healthy: false });
    expect(await outcome).toBe(undefined);
    expect(fixture.clicks).toEqual([seat, "picker", "picker", "GPT-6", seat === "plus" ? "none" : "max"]);
    expect(await fixture.controller.status()).toMatchObject({ state: "ready", seat, actualModel: "GPT-6", healthy: true });
  } finally { await fixture.controller.close(); await outcome; }
});

test("seat entry leaves an open menu alone while its model options load", async () => {
  const fixture = await seatEntryFixture("plus", "GPT-6", 3000);
  fixture.ready.picker = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.modelChecked;
    // Exceed the reopening interval: an open loading menu must not be toggled.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(fixture.clicks).toEqual(["plus", "picker"]);
    expect((await fixture.controller.status()).state).toBe("entry");
    fixture.ready.model = true;
    expect(await outcome).toBe(undefined);
    expect(fixture.clicks).toEqual(["plus", "picker", "GPT-6", "none"]);
  } finally { await fixture.controller.close(); await outcome; }
});

test("seat entry reopening preserves the original deadline and never selects another model", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const fixture = await seatEntryFixture("plus", "GPT-5.6 Sol", 1500);
  fixture.ready.picker = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.modelChecked;
    fixture.menu.visible = false;
    fixture.menu.modelReadyOnOpen = true;
    clock.mockReturnValue(1001);
    await Promise.race([
      fixture.pickerReopened,
      outcome.then(() => { throw new Error("Setup ended before the menu reopened"); }),
    ]);
    clock.mockReturnValue(1501);
    expect(await outcome).toMatchObject({ code: "model_unavailable", submission: "none" });
    expect(fixture.clicks).toEqual(["plus", "picker", "picker"]);
    expect(await fixture.controller.status()).toMatchObject({ state: "entry", healthy: false });
    expect((await fixture.controller.status()).actualModel).toBe(undefined);
  } finally { clock.mockRestore(); await fixture.controller.close(); await outcome; }
});

test("closing a channel after reopening its model menu stops setup without selecting a model", async () => {
  const fixture = await seatEntryFixture("plus", "GPT-6", 3000);
  fixture.ready.picker = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.modelChecked;
    fixture.menu.visible = false;
    await Promise.race([
      fixture.pickerReopened,
      outcome.then(() => { throw new Error("Setup ended before the menu reopened"); }),
    ]);
    await fixture.controller.close();
    const error = await outcome;
    expect(error).toBeInstanceOf(ChatShareBrowserError);
    expect(["cancelled", "browser_closed"]).toContain(error.code);
    expect(fixture.clicks).toEqual(["plus", "picker", "picker"]);
    expect((await fixture.controller.status()).state).toBe("closed");
  } finally { await fixture.controller.close(); await outcome; }
});

test("seat entry waits for profile loading and an editable composer before opening the picker", async () => {
  const fixture = await seatEntryFixture("plus");
  fixture.ready.picker = true;
  fixture.ready.model = true;
  fixture.ready.profileLoading = true;
  fixture.ready.composerEditable = false;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.loadingChecked;
    expect(fixture.clicks).toEqual(["plus"]);
    fixture.ready.profileLoading = false;
    await fixture.composerChecked;
    expect(fixture.clicks).toEqual(["plus"]);
    fixture.ready.composerEditable = true;
    expect(await outcome).toBe(undefined);
    expect(fixture.clicks).toEqual(["plus", "picker", "GPT-6 Astra", "none"]);
  } finally { await fixture.controller.close(); await outcome; }
});

test("seat entry refreshes an open stale menu and still selects only GPT-6", async () => {
  const fixture = await seatEntryFixture("plus", "GPT-6");
  fixture.ready.picker = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.modelChecked;
    // The menu stays visible but only a new open reads the hydrated model data.
    fixture.menu.modelReadyOnOpen = true;
    expect(await outcome).toBe(undefined);
    expect(fixture.clicks).toEqual(["plus", "picker", "escape", "picker", "GPT-6", "none"]);
    expect(await fixture.controller.status()).toMatchObject({ state: "ready", actualModel: "GPT-6", healthy: true });
  } finally { await fixture.controller.close(); await outcome; }
}, 15_000);

test("seat entry can select GPT-6 while a modal menu hides the composer", async () => {
  const fixture = await seatEntryFixture("plus", "GPT-6");
  fixture.ready.picker = true;
  fixture.menu.hidesComposer = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.modelChecked;
    fixture.ready.model = true;
    expect(await outcome).toBe(undefined);
    expect(fixture.clicks).toEqual(["plus", "picker", "GPT-6", "none"]);
    expect(await fixture.controller.status()).toMatchObject({ state: "ready", actualModel: "GPT-6", healthy: true });
  } finally { await fixture.controller.close(); await outcome; }
});

test.each(["deadline", "shutdown"] as const)("seat entry stale-menu refresh respects %s without selecting another model", async reason => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const fixture = await seatEntryFixture("plus", "GPT-5.6 Sol", 5000);
  fixture.ready.picker = true;
  fixture.ready.model = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.modelChecked;
    clock.mockReturnValue(3001);
    await fixture.menuClosed;
    if (reason === "shutdown") await fixture.controller.close();
    else clock.mockReturnValue(5001);
    const error = await outcome;
    expect(error).toBeInstanceOf(ChatShareBrowserError);
    if (reason === "deadline") expect(error).toMatchObject({ code: "model_unavailable", submission: "none" });
    else expect(["cancelled", "browser_closed"]).toContain(error.code);
    expect(fixture.clicks).toEqual(["plus", "picker", "escape"]);
    expect((await fixture.controller.status()).actualModel).toBe(undefined);
  } finally { clock.mockRestore(); await fixture.controller.close(); await outcome; }
});

test.each(["deadline", "shutdown"] as const)("seat entry profile loading respects %s without opening a menu", async reason => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const fixture = await seatEntryFixture("plus");
  fixture.ready.picker = true;
  fixture.ready.profileLoading = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await fixture.loadingChecked;
    if (reason === "shutdown") await fixture.controller.close();
    else clock.mockReturnValue(10001);
    const error = await outcome;
    expect(error).toBeInstanceOf(ChatShareBrowserError);
    if (reason === "deadline") expect(error).toMatchObject({ code: "model_picker_missing", submission: "none" });
    else expect(["cancelled", "browser_closed"]).toContain(error.code);
    expect(fixture.clicks).toEqual(["plus"]);
  } finally { clock.mockRestore(); await fixture.controller.close(); await outcome; }
});

test.each(["ready", "failed"] as const)("channel startup gates Pro page creation on Plus setup (%s)", async result => {
  const plus = await seatEntryFixture("plus");
  const pro = await seatEntryFixture("pro");
  plus.ready.picker = true;
  pro.ready.picker = true;
  let proPages = 0;
  let contextClosed = false;
  const context = {
    on() {}, route: async () => {}, pages: () => [plus.page],
    newPage: async () => { proPages++; return pro.page; },
    close: async () => { contextClosed = true; },
  } as unknown as BrowserContext;
  const profileDir = await mkdtemp(join(tmpdir(), "chatshare-startup-"));
  const executablePath = join(profileDir, "offline-chrome");
  await writeFile(executablePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const launch = spyOn(chromium, "launchPersistentContext").mockReturnValue(Promise.resolve(context));
  let pool: ChatShareBrowser | undefined;
  const outcome = openChatShareChannelPool({
    port: 3211, token: "offline-test-key", chromeExecutablePath: executablePath, profileDir,
    turnTimeoutMs: 1000, pollIntervalMs: 1, stableIntervalMs: 0, maxPromptChars: 24000,
    selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
  }).then(value => { pool = value; return undefined; }, error => error);
  try {
    await Promise.race([
      plus.modelChecked,
      outcome.then(() => { throw new Error("Startup ended before Plus reached model setup"); }),
    ]);
    expect(proPages).toBe(0);
    expect(pro.clicks).toEqual([]);
    if (result === "ready") {
      plus.ready.model = true;
      expect(await outcome).toBe(undefined);
      expect(proPages).toBe(1);
      const status = await pool!.status();
      expect(status.channels?.plus).toMatchObject({ state: "ready", actualModel: "GPT-6" });
      expect(status.channels?.pro?.state).toBe("entry");
    } else {
      expect(await outcome).toMatchObject({ code: "model_unavailable" });
      expect(proPages).toBe(0);
      expect(contextClosed).toBeTrue();
    }
  } finally {
    plus.ready.model = true;
    pro.ready.model = true;
    await outcome;
    await pool?.close();
    await plus.controller.close();
    await pro.controller.close();
    launch.mockRestore();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test.each(["picker", "model"] as const)("seat entry times out safely when the required %s never appears", async stage => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const fixture = await seatEntryFixture("plus", "GPT-5.6 Sol");
  fixture.ready.picker = stage === "model";
  fixture.ready.model = true;
  const outcome = fixture.controller.openSeat("plus").then(() => undefined, error => error);
  try {
    await (stage === "picker" ? fixture.pickerChecked : fixture.modelChecked);
    clock.mockReturnValue(10001);
    expect(await outcome).toMatchObject({ code: stage === "picker" ? "model_picker_missing" : "model_unavailable", submission: "none" });
    expect(fixture.clicks).toEqual(stage === "picker" ? ["plus"] : ["plus", "picker"]);
    expect(await fixture.controller.status()).toMatchObject({ state: "entry", healthy: false });
    expect((await fixture.controller.status()).actualModel).toBe(undefined);
  } finally {
    clock.mockRestore();
    await fixture.controller.close();
    await outcome;
  }
});

test.each(["picker", "model"] as const)("closing a channel cancels its pending %s readiness wait", async stage => {
  const fixture = await seatEntryFixture("pro");
  fixture.ready.picker = stage === "model";
  const outcome = fixture.controller.openSeat("pro").then(() => undefined, error => error);
  try {
    await (stage === "picker" ? fixture.pickerChecked : fixture.modelChecked);
    await fixture.controller.close();
    const error = await outcome;
    expect(error).toBeInstanceOf(ChatShareBrowserError);
    expect(["cancelled", "browser_closed"]).toContain(error.code);
    expect(fixture.clicks).toEqual(stage === "picker" ? ["pro"] : ["pro", "picker"]);
    expect((await fixture.controller.status()).state).toBe("closed");
  } finally { await fixture.controller.close(); await outcome; }
});

// Real browser fixtures are completely offline. Set this to a locally installed
// Chrome/Chromium binary; no authenticated profile or live seat is used.
const chrome = process.env.CHATSHARE_TEST_CHROME;
describe.skipIf(!chrome)("ChatShare DOM fixtures in Chromium", () => {
  let browser: Browser;
  let page: Page;
  // Cold Chrome startup can exceed Bun's default five-second hook timeout.
  beforeAll(async function launchOfflineChromium() {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext();
    await context.route("**/*", route => route.abort());
    page = await context.newPage();
  }, 60_000);
  // Browser teardown has its own budget; a test's timeout does not cover hooks.
  afterAll(async function closeOfflineChromium() { await browser?.close(); }, 60_000);
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
  test("the idle renewal warning is not treated as a conversation error", async () => {
    const result = await read(`${composer}<aside id="cs-idle-warning" role="alert">无操作约 10 分钟</aside>`);
    expect(result.errorPresent).toBeFalse();
  });
  test("seat expiry detection ignores matching words in the composer draft", async () => {
    const result = await read(`<textarea id="prompt-textarea">当前席位授权已失效，请重试</textarea>`);
    expect(result.seatAuthorizationInvalid).toBeFalse();
  });
  test("old assistant controls cannot complete the new answer and hidden messages are ignored", async () => {
    const result = await read(`${composer}<article data-testid="conversation-turn-old"><div data-message-author-role="assistant"><div class="markdown">Old</div></div><button data-testid="copy-turn-action-button">Copy</button></article>
      <div hidden data-message-author-role="user">Hidden</div><article data-testid="conversation-turn-new"><div data-message-author-role="user">Q</div><div data-message-author-role="assistant"><div class="markdown">Partial<button>Copy code</button></div></div></article>`);
    expect(result.messages.map(item => item.text)).toEqual(["Old", "Q", "Partial"]);
    expect(result.messages[0]!.complete).toBeTrue();
    expect(result.messages[2]!.complete).toBeFalse();
  });

  test.each(["delayed", "rerendered", "stale", "profile-loading"] as const)("production seat entry waits for profile loading and the GPT-6 menu (%s)", async menuState => {
    const context = await browser.newContext();
    await context.route("**/*", async route => {
      if (route.request().url() === CHATSHARE_ENTRY_URL) {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><body>
          <button onclick="location.href='${CHATSHARE_CHAT_URL}'">进入 Plus</button>
        </body></html>` });
      } else if (route.request().url() === CHATSHARE_CHAT_URL) {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><body>
          <p id="profile">正在加载个人资料</p>
          <section id="chat" hidden>
            <textarea id="prompt-textarea"></textarea>
            <button id="picker" aria-label="选择 ChatGPT 模型" aria-expanded="false">Choose a model</button>
            <div id="menu" role="menu" hidden>
              <button role="menuitemradio" aria-checked="false">GPT-5.6 Sol</button>
              <button role="menuitemradio" aria-checked="false">GPT-6 Astra</button>
              <button role="menuitem">Instant</button>
            </div>
          </section>
          <script>
            window.selectionClicks = [];
            let picker = document.querySelector('#picker');
            const menu = document.querySelector('#menu');
            let opens = 0;
            if (${menuState === "profile-loading"}) document.querySelector('#chat').hidden = false;
            setTimeout(() => {
              document.querySelector('#profile').remove();
              document.querySelector('#chat').hidden = false;
            }, 100);
            const openMenu = () => {
              if (document.querySelector('#profile')) window.selectionClicks.push('premature-picker');
              window.selectionClicks.push('picker');
              picker.setAttribute('aria-expanded', 'true');
              document.querySelector('#prompt-textarea').setAttribute('aria-hidden', 'true');
              if (${menuState === "rerendered" || menuState === "stale"} && ++opens === 1) {
                const model = menu.querySelectorAll('[role="menuitemradio"]')[1];
                model.hidden = true;
                menu.hidden = false;
                if (${menuState === "rerendered"}) setTimeout(() => {
                  menu.hidden = true;
                  model.hidden = false;
                  const replacement = picker.cloneNode(true);
                  replacement.setAttribute('aria-expanded', 'false');
                  picker.replaceWith(replacement);
                  picker = replacement;
                  picker.addEventListener('click', openMenu);
                  document.querySelector('#prompt-textarea').removeAttribute('aria-hidden');
                }, 100);
              } else {
                menu.querySelectorAll('[role="menuitemradio"]')[1].hidden = false;
                setTimeout(() => { menu.hidden = false; }, 100);
              }
            };
            picker.addEventListener('click', openMenu);
            document.addEventListener('keydown', event => {
              if (event.key === 'Escape' && !menu.hidden) {
                window.selectionClicks.push('escape');
                menu.hidden = true;
                picker.setAttribute('aria-expanded', 'false');
                document.querySelector('#prompt-textarea').removeAttribute('aria-hidden');
              }
            });
            document.querySelectorAll('[role="menuitemradio"]').forEach(model => {
              model.addEventListener('click', () => {
                window.selectionClicks.push(model.textContent);
                model.setAttribute('aria-checked', 'true');
                picker.textContent = model.textContent;
              });
            });
            document.querySelector('[role="menuitem"]').addEventListener('click', () => {
              window.selectionClicks.push('Instant');
              menu.hidden = true;
              picker.setAttribute('aria-expanded', 'false');
              document.querySelector('#prompt-textarea').removeAttribute('aria-hidden');
            });
          </script>
        </body></html>` });
      } else {
        await route.abort();
      }
    });
    const controller = await createChatShareBrowserController({
      port: 3211, token: "offline-test-key", profileDir: "/unused-offline-fixture",
      turnTimeoutMs: menuState === "stale" ? 8000 : 3000, pollIntervalMs: 20, stableIntervalMs: 50, maxPromptChars: 24000,
      // Fail a missing seat label before the test harness timeout.
      seatWaitTimeoutMs: 3000, seatPollIntervalMs: 20,
      selectors: { ...DEFAULT_CHATSHARE_SELECTORS },
    }, context);
    try {
      await controller.openSeat("plus");
      expect(await controller.status()).toMatchObject({ state: "ready", seat: "plus", actualModel: "GPT-6", healthy: true });
      expect(await context.pages()[0]!.evaluate(() =>
        (window as unknown as { selectionClicks: string[] }).selectionClicks,
      )).toEqual(menuState === "rerendered"
        ? ["picker", "picker", "GPT-6 Astra", "Instant"]
        : menuState === "stale" ? ["picker", "escape", "picker", "GPT-6 Astra", "Instant"]
          : ["picker", "GPT-6 Astra", "Instant"]);
      expect(await context.pages()[0]!.locator('#picker').textContent()).toBe("GPT-6 Astra");
    } finally { await controller.close(); }
  }, 15_000); // Allow context setup and cleanup beyond the seat/model deadlines.

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
      // The click may already have been accepted. A timeout is therefore
      // submission-uncertain and must not press Stop or cause a resend.
      expect(fixture.events).toEqual(["send:pending timeout"]);
    } finally { await fixture.controller.close(); }
  });

});
