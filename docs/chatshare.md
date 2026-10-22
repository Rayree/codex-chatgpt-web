# ChatShare text bridge experiment

[简体中文](chatshare.zh-CN.md) · [Project README](../README.md)

This experiment provides a separate **Bun + Chrome CLI** to test a text round trip through a ChatShare web session that the user signs into normally. It sends text through the controlled page, reads the answer, and exposes the result through a local endpoint. It does not modify the existing Launcher or treat a ChatShare login as an official OpenAI login.

**Status: experimental implementation, not yet verified end to end on an Apple Silicon Mac with a real ChatShare seat.** Passing local tests establishes the behavior covered by those tests; it does not establish compatibility with a particular subscription, seat, or authenticated page.

## Initial scope

| Area | Scope |
| --- | --- |
| Runtime | Bun CLI from this fork, using locally installed Chrome |
| Web sign-in | The user signs in, selects a seat, and chooses a model in the dedicated window |
| Input and output | Text requests and text answers |
| Conversation history | A fresh conversation per request; callers explicitly supply the needed text context |
| Local model route | `chatshare-web-text` |
| Default endpoint | `http://127.0.0.1:3211/v1/responses` |
| Local tools, MCP, terminal, file operations | Unsupported |
| Images, attachments, audio | Unsupported |
| `previous_response_id` | Unsupported |
| Existing Launcher and Codex configuration | Not changed automatically |

`chatshare-web-text` names this experiment's local route. It does not prove which upstream model, plan, or reasoning level the service supplies. Available models, session lifetime, and allowances depend on the actual seat.

A text Responses endpoint does not establish support for a normal Codex client's tool calls, compaction, images, or complete agent workflow. Use the built-in `chat` client below to validate the text path first.

Answers are extracted from the page as plain text. Markdown markers, link destinations, code fences, and exact whitespace formatting are not guaranteed to survive. Check code content and indentation against the web page before reusing it. The browser adapter waits for the answer to finish and pass turn-ownership and stability checks before returning its text; using SSE does not relay the web generation token by token.

## Prerequisites

The target is macOS on Apple Silicon, with native ARM64 Bun and locally installed Chrome. This experiment does not require building Electron or downloading the original project's DMG.

1. Prepare the repository-pinned **Bun 1.4.0**. See the [official Bun installation documentation](https://bun.sh/docs/installation) for installation choices. Use the repository's pinned version instead of changing its lockfile to match the latest version shown on the installation page.
2. Install [Google Chrome](https://www.google.com/chrome/).
3. Open a terminal in this fork's repository root, check the runtime, and install locked dependencies:

```bash
bun --version
bun -e 'console.log(process.platform + "/" + process.arch)'
bun install --frozen-lockfile
```

On the target Mac, the first two commands should report `1.4.0` and `darwin/arm64`. These commands do not install a browser or edit your shell configuration.

## First run

### 1. Initialize local configuration

From the repository root:

```bash
bun run chatshare init
```

`init` only creates local configuration. It does not contact ChatShare or submit a model request. Default paths are:

- Configuration: `~/.codex-chatshare/config.json`
- Dedicated Chrome profile: `~/.codex-chatshare/browser`

Initialization creates a random key for the local endpoint. **This is not a ChatShare password, a ChatShare session token, or an OpenAI API key.** Do not replace it with any of those credentials.

### 2. Sign in through the dedicated window

```bash
bun run chatshare login
```

Use the normal ChatShare entry page in the Chrome window that opens. Sign in, manually select a seat you are allowed to use, enter its actual chat page, and choose the intended model. Complete any verification or service prompts through the normal website flow.

The window uses this experiment's own profile. It does not import your everyday Chrome profile or copy authentication from the original Launcher. Being signed in elsewhere does not sign this window in.

After signing in, press **Ctrl-C** in the terminal running `login` and wait for it to exit before starting the server. Do not run `login` and `serve` against the same profile simultaneously.

### 3. Inspect local readiness

```bash
bun run chatshare doctor
```

`doctor` checks local prerequisites and queries the local health endpoint when the server is running. Its output excludes cookies, prompts, and keys. `Server: not running` is expected at this step if you have not started `serve` yet. Healthy diagnostics do not prove that a real seat can send a message, expose a readable answer, or provide a particular model capability.

### 4. Start the server and prepare the chat page

```bash
bun run chatshare serve
```

Keep this terminal and its Chrome window open. If the window returns to sign-in or seat selection, complete that flow there and enter the intended chat page. Confirm the seat and visible model before submitting a request.

### 5. Send a short prompt from another terminal

Enter the same repository directory in a second terminal:

```bash
bun run chatshare chat 'Reply with exactly OK'
```

The built-in client reads the local endpoint key from configuration, so no key needs to be pasted into a command or shell history. A successful round trip means the dedicated page submits the matching prompt once, the terminal receives the answer for that request, and the request finishes normally.

Each `chat` invocation is a separate request; the client does not automatically include earlier answers. Include any necessary prior text explicitly in the new prompt. You can also read a prompt from standard input:

```bash
bun run chatshare chat --stdin < prompt.txt
```

This keeps the prompt body out of command arguments and shell history. The local `prompt.txt` file still needs to be handled appropriately.

Next, try a short Unicode prompt or a simple code-block request to check text integrity. Test sequentially. Do not switch seats, submit another message manually, or close the controlled page during an active request.

To stop, press **Ctrl-C** in the terminal running `serve`.

## Configuration and isolation

Set `CHATSHARE_HOME` to use a different experiment directory. For example, set this in both terminals:

```bash
export CHATSHARE_HOME="$HOME/.codex-chatshare-test"
```

Then use the same `init`, `login`, `serve`, and `chat` commands. All related commands must use the same directory to share the intended configuration, profile, and local key.

The normal entry URL is currently fixed to `https://chatshare.tv/`, and the chat origin is fixed to `https://chat.chatshare.tv/`. Requests cannot select arbitrary target URLs. If your seat redirects elsewhere, record only the domain without tokens and review adapter compatibility; do not remove origin checks to continue.

These fields can be adjusted in the existing `config.json`. Preserve the generated `version` and `token`, then restart the relevant processes.

| Field | Default or purpose |
| --- | --- |
| `port` | `3211`, listening on loopback only |
| `chromeExecutablePath` | Optional absolute path to the Chrome executable |
| `turnTimeoutMs` | `180000`, the deadline for a text request |
| `pollIntervalMs` | `250`, the page observation interval |
| `stableIntervalMs` | `1500`, the answer-text stability interval |
| `maxPromptChars` | `24000`, counting the complete transport prompt, including history, JSON encoding, and wrapper instructions; not a model token-context guarantee |
| `selectors` | Overrides for `composer`, `sendButton`, `stopButton`, `userMessage`, `assistantMessage`, `assistantContent`, and `errorMessage` |

Derive selector changes from the page reached through normal sign-in. Stable text alone does not prove generation has finished; changing timing settings does not repair an incorrect page binding. Do not guess seat URLs, and do not post complete redirect URLs containing one-time login tokens in public issues.

The experiment directory contains browser authentication state and local endpoint credentials. Keep it out of Git, shared cloud folders, and diagnostic attachments. This profile is separate from both the original Launcher profile and your normal Chrome profile.

## Local endpoint and credential boundaries

The default endpoint listens only on `127.0.0.1:3211` and requires the random local key. It is an experimental text interface, not a public API announced by ChatShare and not the official OpenAI API.

Prefer the built-in `chat` command for initial validation. Other clients must stay within the request format this experiment actually implements; support for some version of the Responses API does not make every field compatible.

The local endpoint accepts an omitted `store` or `store: false`, meaning it does not provide local Responses history storage. This does not enable temporary chat on the website or guarantee that ChatShare or its upstream service will not retain the conversation.

Chrome accesses the website through its own ChatShare session. The local key is only used between the local client and server. Official Codex/OpenAI tokens are not used to sign in to ChatShare or forwarded to it.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Bun missing or wrong version | Check `bun --version` and prepare the pinned version using official installation guidance |
| Chrome missing | Check the Chrome installation, `doctor` output, and generated configuration |
| Profile already in use | Stop the other experiment `login` or `serve` process first; do not delete a live profile |
| Local connection fails | Check that `serve` is running and both terminals use the same `CHATSHARE_HOME` and port |
| Local authentication fails | Confirm both sides read the same configuration; do not substitute a ChatShare password or OpenAI key |
| Browser remains on a portal or seat picker | Complete the normal flow in the controlled window and enter the actual chat page |
| Composer, send button, or answer is not found | The authenticated DOM may differ from the current adapter; collect redacted structural evidence |
| The page submitted, but the client times out | Inspect whether the page is still generating before retrying; avoid submitting the same prompt twice |
| Tools, images, or continuation IDs fail | These are outside the initial scope; validate with the text-only `chat` command |

Handle quota limits, queues, verification challenges, and expired sessions through the website's normal flow. The experiment does not bypass them.

## Reporting a real-seat test

Record the Mac architecture, Bun and Chrome versions, repository commit, command, error type, and whether the failure occurred during sign-in, seat selection, submission, or answer extraction. A screenshot with account details hidden or a carefully reviewed DOM fragment can help.

Do not attach the complete `config.json`, browser profile, cookies, Authorization headers, one-time login URLs, full HAR files, or private conversations. Safe `doctor` output does not make other attachments safe automatically.

Compatibility for a specific page can only be established after a real-seat test verifies normal sign-in, a single accepted submission, correct answer binding, completion detection, and failure cleanup. A local tool protocol and complete Codex integration require separate design and validation.
