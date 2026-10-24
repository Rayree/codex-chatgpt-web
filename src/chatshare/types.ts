export type ChatShareSeat = "plus" | "pro";
export type ChatShareReasoningEffort = "none" | "max";

export interface BrowserStatus {
  state: "entry" | "ready" | "busy" | "closed" | "unavailable";
  url: string;
  message: string;
  /** The actual ChatShare seat selected in the browser, when known. */
  seat?: ChatShareSeat;
  /** ChatShare's visible model label, never an official API model claim. */
  actualModel?: "GPT-6";
  reasoningEffort?: ChatShareReasoningEffort;
  healthy?: boolean;
  channels?: Partial<Record<ChatShareSeat, BrowserStatus>>;
}

export interface ChatShareRunOptions {
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  /** Ordinary requests leave this unset and prefer Plus before Pro. */
  seat?: ChatShareSeat;
  /** An explicit Pro request is never downgraded to Plus. */
  explicitSeat?: boolean;
}

export interface ChatShareBrowser {
  runText(
    prompt: string,
    options: ChatShareRunOptions,
  ): Promise<string>;
  close(): Promise<void>;
  status(): Promise<BrowserStatus>;
}
