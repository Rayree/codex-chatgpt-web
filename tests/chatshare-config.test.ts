import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractResponseText } from "../src/chatshare/cli";
import { chatSharePaths, initializeChatShareConfig, loadChatShareConfig, parseChatShareConfig } from "../src/chatshare/config";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "chatshare-config-"));
  temporaryDirectories.push(result);
  return result;
}

test("init creates isolated owner-only configuration and preserves its key on repeated runs", async () => {
  const root = await home();
  const env = { CHATSHARE_HOME: join(root, "private") };
  const first = await initializeChatShareConfig(env);
  const second = await initializeChatShareConfig(env);
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(first.config.token).toHaveLength(43);
  expect(first.config.token).toBe(second.config.token);
  expect(first.config.profileDir).toBe(join(root, "private/browser"));
  expect((JSON.parse(await readFile(first.configFile, "utf8")) as { token: string }).token).toBe(first.config.token);
  if (process.platform !== "win32") {
    expect((await stat(first.configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(first.config.profileDir)).mode & 0o777).toBe(0o700);
  }
});

test("configuration validation rejects unsafe and unsupported settings", () => {
  const valid = { version: 1, token: "a".repeat(43) };
  expect(() => parseChatShareConfig({ ...valid, token: "secret" }, "/profile")).toThrow("token");
  expect(() => parseChatShareConfig({ ...valid, port: 0 }, "/profile")).toThrow("port");
  expect(() => parseChatShareConfig({ ...valid, chatUrl: "https://other.example" }, "/profile")).toThrow("unknown field");
  expect(() => parseChatShareConfig({ ...valid, profileDir: "/another/profile" }, "/profile")).toThrow("unknown field");
  expect(() => parseChatShareConfig({ ...valid, selectors: { toString: "x" } }, "/profile")).toThrow("invalid selector");
  expect(() => parseChatShareConfig({ ...valid, selectors: { composer: "" } }, "/profile")).toThrow("invalid selector");
  expect(() => parseChatShareConfig({ ...valid, chromeExecutablePath: "relative/chrome" }, "/profile")).toThrow("absolute path");
  expect(parseChatShareConfig({ ...valid, selectors: { composer: "#editor" } }, "/profile").selectors.composer).toBe("#editor");
  const prepared = parseChatShareConfig(valid, "/profile");
  expect(prepared.seatPollIntervalMs).toBe(5000);
  expect(prepared.heartbeatIntervalMs).toBe(240000);
  expect(prepared.heartbeatIdleLimitMs).toBe(600000);
});

test("load rejects broadly readable key files and reports missing configuration clearly", async () => {
  const env = { CHATSHARE_HOME: await home() };
  await expect(loadChatShareConfig(env)).rejects.toThrow("not initialized");
  const initialized = await initializeChatShareConfig(env);
  if (process.platform !== "win32") {
    await chmod(initialized.configFile, 0o644);
    await expect(loadChatShareConfig(env)).rejects.toThrow("chmod 600");
  }
});

test("CHATSHARE_HOME controls only the experiment's paths", () => {
  const paths = chatSharePaths({ CHATSHARE_HOME: "./chatshare-test-data" });
  expect(paths.home).toBe(resolve("./chatshare-test-data"));
  expect(paths.configFile).toBe(join(paths.home, "config.json"));
  expect(paths.profileDir).toBe(join(paths.home, "browser"));
});

test("CLI accepts completed assistant text but never treats failed or partial output as success", () => {
  expect(extractResponseText({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] })).toBe("OK");
  expect(() => extractResponseText({ status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }] })).toThrow("did not complete");
  expect(() => extractResponseText({ status: "failed", error: { message: "Seat unavailable" } })).toThrow("Seat unavailable");
  expect(() => extractResponseText({ status: "completed", output: [] })).toThrow("no assistant text");
});

test("CLI init and help do not disclose the local API key", async () => {
  const directory = await home();
  const env = { ...process.env, CHATSHARE_HOME: directory };
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/chatshare/cli.ts"), "init"], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const config = await loadChatShareConfig(env);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Created configuration");
  expect(stdout + stderr).not.toContain(config.token);
});
