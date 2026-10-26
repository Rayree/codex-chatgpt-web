import { randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CHATSHARE_MODEL_ID = "chatshare-web-text";
export const CHATSHARE_ENTRY_URL = "https://chatshare.tv/";
export const CHATSHARE_CHAT_URL = "https://chat.chatshare.tv/";
export const DEFAULT_CHATSHARE_SEAT_SETUP_TIMEOUT_MS = 120000;

export interface ChatShareSelectors {
  composer: string;
  sendButton: string;
  stopButton: string;
  userMessage: string;
  assistantMessage: string;
  assistantContent: string;
  errorMessage: string;
}

export interface ChatShareConfig {
  port: number;
  token: string;
  profileDir: string;
  chromeExecutablePath?: string;
  turnTimeoutMs: number;
  pollIntervalMs: number;
  stableIntervalMs: number;
  maxPromptChars: number;
  /** How often a full seat page is checked while capacity is unavailable. */
  seatPollIntervalMs?: number;
  /** Maximum wait for a seat button; zero means keep waiting for capacity. */
  seatWaitTimeoutMs?: number;
  /** Deadline after selecting a seat for navigation, profile and model setup. */
  seatSetupTimeoutMs?: number;
  /** Foreground scroll interval used for idle seat renewal. */
  heartbeatIntervalMs?: number;
  /** Stop renewing a channel after this much demand-free time. */
  heartbeatIdleLimitMs?: number;
  selectors: ChatShareSelectors;
}

export const DEFAULT_CHATSHARE_SELECTORS: Readonly<ChatShareSelectors> = {
  composer: '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"], div.ProseMirror[contenteditable="true"]',
  sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送"][type="submit"]',
  stopButton: 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="停止"], button[aria-label="Stop"]',
  userMessage: '[data-message-author-role="user"], [data-user-message-bubble], [data-content-search-unit-key$=":user"]',
  assistantMessage: '[data-message-author-role="assistant"], [data-content-search-unit-key]:has([data-conversation-role="assistant"]), [data-content-search-unit-key$=":assistant"]',
  assistantContent: '.markdown, [data-markdown-text-style="assistant-message"]',
  // ChatShare's idle-renewal notice is an aside#cs-idle-warning[role=alert], not
  // a conversation error. Keep generic alerts out of the default selector and
  // explicitly exclude that known notice when a caller supplies a broad one.
  errorMessage: '[data-testid="conversation-turn-error"], [data-testid="error-message"], [role="alert"]:not(#cs-idle-warning)',
};

export function chatSharePaths(env: NodeJS.ProcessEnv = process.env): { home: string; configFile: string; profileDir: string } {
  const override = env.CHATSHARE_HOME?.trim();
  const home = override ? resolve(override) : join(homedir(), ".codex-chatshare");
  return { home, configFile: join(home, "config.json"), profileDir: join(home, "browser") };
}

function integerSetting(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`ChatShare config: ${name} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

/** All URLs and the isolated profile path are derived here, never from request bodies. */
export function parseChatShareConfig(raw: unknown, profileDir: string): ChatShareConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ChatShare config must be a JSON object.");
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set(["version", "port", "token", "chromeExecutablePath", "turnTimeoutMs", "pollIntervalMs", "stableIntervalMs", "maxPromptChars", "seatPollIntervalMs", "seatWaitTimeoutMs", "seatSetupTimeoutMs", "heartbeatIntervalMs", "heartbeatIdleLimitMs", "selectors"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`ChatShare config: unknown field ${key}.`);
  }
  if (input.version !== 1) throw new Error("ChatShare config: unsupported version; expected version 1.");
  if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(input.token)) {
    throw new Error("ChatShare config: token must contain 32–128 URL-safe characters. Run init with a new CHATSHARE_HOME to create one.");
  }
  let chromeExecutablePath: string | undefined;
  if (input.chromeExecutablePath !== undefined) {
    if (typeof input.chromeExecutablePath !== "string" || !isAbsolute(input.chromeExecutablePath)) {
      throw new Error("ChatShare config: chromeExecutablePath must be an absolute path.");
    }
    chromeExecutablePath = input.chromeExecutablePath;
  }
  const selectors: ChatShareSelectors = { ...DEFAULT_CHATSHARE_SELECTORS };
  if (input.selectors !== undefined) {
    if (input.selectors === null || typeof input.selectors !== "object" || Array.isArray(input.selectors)) {
      throw new Error("ChatShare config: selectors must be an object.");
    }
    for (const [name, value] of Object.entries(input.selectors)) {
      if (!Object.hasOwn(DEFAULT_CHATSHARE_SELECTORS, name) || typeof value !== "string" || !value.trim() || value.length > 2048) {
        throw new Error(`ChatShare config: invalid selector ${name}.`);
      }
      selectors[name as keyof ChatShareSelectors] = value;
    }
  }
  const pollIntervalMs = integerSetting(input.pollIntervalMs, 250, "pollIntervalMs", 100, 5000);
  const stableIntervalMs = integerSetting(input.stableIntervalMs, 1500, "stableIntervalMs", 500, 10000);
  const seatPollIntervalMs = integerSetting(input.seatPollIntervalMs, 5000, "seatPollIntervalMs", 250, 60000);
  const seatWaitTimeoutMs = integerSetting(input.seatWaitTimeoutMs, 0, "seatWaitTimeoutMs", 0, 86400000);
  const seatSetupTimeoutMs = integerSetting(input.seatSetupTimeoutMs, DEFAULT_CHATSHARE_SEAT_SETUP_TIMEOUT_MS, "seatSetupTimeoutMs", 1000, 600000);
  const heartbeatIntervalMs = integerSetting(input.heartbeatIntervalMs, 240000, "heartbeatIntervalMs", 1000, 3600000);
  const heartbeatIdleLimitMs = integerSetting(input.heartbeatIdleLimitMs, 600000, "heartbeatIdleLimitMs", 1000, 86400000);
  return {
    port: integerSetting(input.port, 3211, "port", 1024, 65535),
    token: input.token,
    profileDir,
    chromeExecutablePath,
    turnTimeoutMs: integerSetting(input.turnTimeoutMs, 180000, "turnTimeoutMs", 10000, 1800000),
    pollIntervalMs,
    stableIntervalMs,
    seatPollIntervalMs,
    seatWaitTimeoutMs,
    seatSetupTimeoutMs,
    heartbeatIntervalMs,
    heartbeatIdleLimitMs,
    maxPromptChars: integerSetting(input.maxPromptChars, 24000, "maxPromptChars", 1000, 100000),
    selectors,
  };
}

export async function initializeChatShareConfig(env: NodeJS.ProcessEnv = process.env): Promise<{ config: ChatShareConfig; created: boolean; configFile: string }> {
  const paths = chatSharePaths(env);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const initial = JSON.stringify({ version: 1, port: 3211, token: randomBytes(32).toString("base64url") }, null, 2) + "\n";
  let created = false;
  try {
    const file = await open(paths.configFile, "wx", 0o600);
    try {
      await file.writeFile(initial, "utf8");
      created = true;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const config = await loadChatShareConfig(env);
  await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
  return { config, created, configFile: paths.configFile };
}

export async function loadChatShareConfig(env: NodeJS.ProcessEnv = process.env): Promise<ChatShareConfig> {
  const paths = chatSharePaths(env);
  let data: string;
  try {
    const info = await stat(paths.configFile);
    if (!info.isFile() || info.size > 32768) throw new Error("ChatShare config must be a regular file smaller than 32 KiB.");
    if (platform() !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`ChatShare config contains a local access key; restrict its permissions with chmod 600 '${paths.configFile.replaceAll("'", "'\\''")}'.`);
    }
    data = await readFile(paths.configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("ChatShare is not initialized. Run: bun run chatshare init");
    }
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(data); } catch { throw new Error("ChatShare config is not valid JSON."); }
  return parseChatShareConfig(raw, paths.profileDir);
}

export async function findChromeExecutable(config: Pick<ChatShareConfig, "chromeExecutablePath">): Promise<string | undefined> {
  const candidates = config.chromeExecutablePath ? [config.chromeExecutablePath] : platform() === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ] : platform() === "win32" ? [
    join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA ?? homedir(), "Google/Chrome/Application/chrome.exe"),
  ] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed browser. */ }
  }
  return undefined;
}
