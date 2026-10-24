import { ChatShareBrowserError } from "./browser";
import type { BrowserStatus, ChatShareBrowser, ChatShareRunOptions, ChatShareSeat } from "./types";

export interface ChatShareChannelPoolOptions {
  /** Poll interval while all suitable channels are busy or still entering. */
  waitIntervalMs?: number;
  /** Maximum number of pre-submit attempts across channel changes. */
  maxAttempts?: number;
}

/**
 * Routes ordinary text to Plus first and uses Pro for overflow. A request that
 * names Pro is pinned to Pro. The pool never retries an operation after a send
 * click unless the browser proved that no submission was attempted.
 */
export class ChatShareChannelPool implements ChatShareBrowser {
  private readonly channels: Partial<Record<ChatShareSeat, ChatShareBrowser>>;
  private readonly reserved = new Set<ChatShareSeat>();
  private readonly waitIntervalMs: number;
  private readonly maxAttempts: number;
  private closed = false;

  constructor(
    channels: Partial<Record<ChatShareSeat, ChatShareBrowser>>,
    options: ChatShareChannelPoolOptions = {},
  ) {
    this.channels = channels;
    this.waitIntervalMs = options.waitIntervalMs ?? 100;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  private candidates(options: ChatShareRunOptions): ChatShareSeat[] {
    if (options.seat === "pro" || options.explicitSeat) return [options.seat ?? "pro"];
    if (options.seat === "plus") return ["plus", "pro"];
    return ["plus", "pro"];
  }

  private async wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ChatShareBrowserError("cancelled", "ChatShare request cancelled while waiting for a channel.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, this.waitIntervalMs);
      const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new ChatShareBrowserError("cancelled", "ChatShare request cancelled while waiting for a channel.")); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async acquire(candidates: ChatShareSeat[], signal?: AbortSignal): Promise<{ seat: ChatShareSeat; browser: ChatShareBrowser }> {
    while (!this.closed) {
      if (signal?.aborted) throw new ChatShareBrowserError("cancelled", "ChatShare request cancelled while waiting for a channel.");
      for (const seat of candidates) {
        const browser = this.channels[seat];
        if (!browser || this.reserved.has(seat)) continue;
        let status: BrowserStatus;
        try { status = await browser.status(); }
        catch { continue; }
        if (signal?.aborted) throw new ChatShareBrowserError("cancelled", "ChatShare request cancelled while waiting for a channel.");
        if (status.state !== "ready") continue;
        this.reserved.add(seat);
        return { seat, browser };
      }
      await this.wait(signal);
    }
    throw new ChatShareBrowserError("browser_closed", "The ChatShare channel pool is closed.");
  }

  async runText(prompt: string, options: ChatShareRunOptions): Promise<string> {
    if (this.closed) throw new ChatShareBrowserError("browser_closed", "The ChatShare channel pool is closed.");
    const candidates = this.candidates(options);
    let attempts = 0;
    let lastError: unknown;
    while (attempts < this.maxAttempts) {
      attempts++;
      const { seat, browser } = await this.acquire(candidates, options.signal);
      try {
        return await browser.runText(prompt, { ...options, seat, explicitSeat: options.explicitSeat ?? options.seat === "pro" });
      } catch (error) {
        lastError = error;
        // A browser can only authorize a retry when it explicitly reports that
        // no click/send action happened. Timeouts, 502s, seat loss and uncertain
        // acknowledgements remain terminal and are never resent.
        const retryable = error instanceof ChatShareBrowserError && error.submission === "none";
        if (!retryable) throw error;
        if (options.explicitSeat || options.seat === "pro") throw error;
      } finally {
        this.reserved.delete(seat);
      }
      if (candidates.length > 1) {
        const index = candidates.indexOf(seat);
        if (index >= 0) candidates.push(candidates.splice(index, 1)[0]!);
      }
      // Try the next suitable channel on the next loop. If both are unavailable,
      // acquire waits for capacity rather than queueing or dropping the request.
    }
    if (lastError instanceof Error) throw lastError;
    throw new ChatShareBrowserError("channel_unavailable", "No ChatShare channel was available; the request was not sent.");
  }

  async status(): Promise<BrowserStatus> {
    const channels: Partial<Record<ChatShareSeat, BrowserStatus>> = {};
    await Promise.all((Object.keys(this.channels) as ChatShareSeat[]).map(async seat => {
      const browser = this.channels[seat];
      if (!browser) return;
      try { channels[seat] = await browser.status(); }
      catch { channels[seat] = { state: "unavailable", url: "", message: `${seat} channel status is unavailable.`, seat }; }
    }));
    const values = Object.values(channels).filter((value): value is BrowserStatus => Boolean(value));
    const ready = values.find(value => value.state === "ready");
    const busy = values.find(value => value.state === "busy");
    return {
      state: this.closed ? "closed" : ready ? "ready" : busy ? "busy" : values.some(value => value.state === "entry") ? "entry" : "unavailable",
      url: ready?.url ?? busy?.url ?? values[0]?.url ?? "",
      message: this.closed ? "The ChatShare channel pool is closed."
        : ready ? `ChatShare ${ready.seat ?? "channel"} is ready; Plus is preferred for ordinary requests.`
        : busy ? "All available ChatShare channels are busy."
        : "ChatShare channels are entering, full, or unavailable; requests wait without resubmission.",
      seat: ready?.seat,
      actualModel: ready?.actualModel,
      reasoningEffort: ready?.reasoningEffort,
      healthy: Boolean(ready?.healthy),
      channels,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(Object.values(this.channels).filter(Boolean).map(browser => browser!.close()));
  }
}
