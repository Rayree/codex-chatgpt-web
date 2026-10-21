export interface BrowserStatus {
  state: "entry" | "ready" | "busy" | "closed" | "unavailable";
  url: string;
  message: string;
}

export interface ChatShareBrowser {
  runText(
    prompt: string,
    options: { signal?: AbortSignal; onTextDelta?: (text: string) => void },
  ): Promise<string>;
  close(): Promise<void>;
  status(): Promise<BrowserStatus>;
}
