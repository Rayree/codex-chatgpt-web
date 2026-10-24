import { expect, test } from "bun:test";
import { ChatShareBrowserError } from "../src/chatshare/browser";
import { ChatShareChannelPool } from "../src/chatshare/pool";
import type { ChatShareBrowser, ChatShareRunOptions, ChatShareSeat } from "../src/chatshare/types";

function channel(seat: ChatShareSeat, run: (prompt: string, options: ChatShareRunOptions) => Promise<string> | string,
  status: ChatShareBrowser["status"] = async () => ({ state: "ready", url: `https://${seat}`, message: "ready", seat, actualModel: "GPT-6", reasoningEffort: seat === "pro" ? "max" : "none", healthy: true })) {
  return { runText: async (prompt, options) => run(prompt, options), status, close: async () => {} } satisfies ChatShareBrowser;
}

test("ordinary requests use Plus first and two channels can run in parallel", async () => {
  const entered: string[] = [];
  const release = { plus: Promise.resolve("plus answer"), pro: Promise.resolve("pro answer") };
  const pool = new ChatShareChannelPool({
    plus: channel("plus", async () => { entered.push("plus"); return release.plus; }),
    pro: channel("pro", async () => { entered.push("pro"); return release.pro; }),
  });
  const [first, second] = await Promise.all([pool.runText("one", {}), pool.runText("two", {})]);
  expect(new Set([first, second])).toEqual(new Set(["plus answer", "pro answer"]));
  expect(entered).toEqual(["plus", "pro"]);
  await pool.close();
});

test("a single channel remains serial and does not send the second request", async () => {
  let calls = 0;
  let release!: () => void;
  const firstDone = new Promise<string>(resolve => { release = () => resolve("first"); });
  const pool = new ChatShareChannelPool({ plus: channel("plus", async () => { calls++; return firstDone; }) }, { waitIntervalMs: 5 });
  const first = pool.runText("one", {});
  await new Promise(resolve => setTimeout(resolve, 15));
  const second = pool.runText("two", {});
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toBe(1);
  release();
  expect(await first).toBe("first");
  // The second request is allowed only after the first reservation is released.
  expect(await second).toBe("first");
  expect(calls).toBe(2);
  await pool.close();
});

test("a full channel is polled and cancellation before acquisition sends nothing", async () => {
  let polls = 0;
  let calls = 0;
  const pool = new ChatShareChannelPool({
    plus: channel("plus", async () => { calls++; return "answer"; }, async () => {
      polls++;
      return polls < 3 ? { state: "entry", url: "", message: "full", seat: "plus" } : { state: "ready", url: "", message: "ready", seat: "plus" };
    }),
  }, { waitIntervalMs: 5 });
  const abort = new AbortController();
  const pending = pool.runText("cancel", { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
  await pool.close();
});

test("only a confirmed pre-submit failure may switch to Pro, while uncertain submission is terminal", async () => {
  let proCalls = 0;
  const preSubmit = new ChatShareChannelPool({
    plus: channel("plus", async () => { throw new ChatShareBrowserError("not_ready", "not sent", "none"); }),
    pro: channel("pro", async () => { proCalls++; return "pro"; }),
  });
  expect(await preSubmit.runText("retry", {})).toBe("pro");
  expect(proCalls).toBe(1);
  await preSubmit.close();

  const uncertain = new ChatShareChannelPool({
    plus: channel("plus", async () => { throw new ChatShareBrowserError("timeout", "may be sent", "unknown"); }),
    pro: channel("pro", async () => { proCalls++; return "must not run"; }),
  });
  await expect(uncertain.runText("once", {})).rejects.toThrow("may be sent");
  expect(proCalls).toBe(1);
  await uncertain.close();
});

test("an explicit Pro request never downgrades", async () => {
  let plusCalls = 0;
  const pool = new ChatShareChannelPool({
    plus: channel("plus", async () => { plusCalls++; return "wrong"; }),
    pro: channel("pro", async (_prompt, options) => { expect(options.seat).toBe("pro"); expect(options.explicitSeat).toBeTrue(); return "pro"; }),
  });
  expect(await pool.runText("pro", { seat: "pro", explicitSeat: true })).toBe("pro");
  expect(plusCalls).toBe(0);
  await pool.close();
});
