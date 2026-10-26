# ChatShare 文本接入实验

[English](chatshare.md) · [项目首页](../README.zh-CN.md)

这个实验提供独立的 **Bun + Chrome 命令行入口**，用于验证通过用户正常登录的 ChatShare 网页发送文本、读取回答，再通过本地接口返回结果的链路。它不会修改原 Launcher，也不会把 ChatShare 登录当作 OpenAI 官方登录。

**当前状态：实验实现，尚未在 macOS Apple Silicon 真机和真实 ChatShare 席位上完成端到端验证。** 本地测试通过只能说明被测试的程序行为成立，不能说明某个套餐、席位或登录后的页面已经兼容。

## 第一版范围

| 项目 | 当前范围 |
| --- | --- |
| 运行方式 | 从这个 fork 的源码运行 Bun CLI，使用本机 Chrome |
| 网页登录 | 用户在专用浏览器窗口中正常登录、选择席位和模型 |
| 输入和输出 | 文本请求与文本回答 |
| 对话历史 | 每次请求打开新对话；调用方显式提供所需文本上下文 |
| 本地路由名 | `chatshare-web-text` |
| 默认接口 | `http://127.0.0.1:3211/v1/responses` |
| 本地工具、MCP、终端、文件操作 | 不支持 |
| 图片、附件、音频 | 不支持 |
| `previous_response_id` | 不支持 |
| 原 Launcher 与 Codex 配置 | 不自动修改 |

服务启动时会在同一个隔离 profile 中准备 Plus 和 Pro 两个前台通道。普通请求优先 Plus，Plus 忙或已确认未提交失败时才使用 Pro；显式 Pro 请求通过本地请求头 `x-chatshare-seat: pro` 发送，绝不会降级。Pro 满员时只轮询入口容量，不自动填写邮箱或预约。健康接口会分别报告两个通道、实际 GPT-6 标签和网页显示的思考档位（Plus 为即时/`none`，Pro 为 Extra High/`max`）。

通道空闲时约每四分钟进行一次真实前台滚动，连续约十分钟没有业务需求后停止续期；滚动不会修改草稿或发送消息。关闭服务会停止后台轮询、保活和两个浏览器通道。

`chatshare-web-text` 是这个实验的本地路由名称，不是对服务商实际提供的模型、套餐或思考等级的证明。网页里可用的模型、登录有效期和额度取决于你的实际席位。

提供一个文本 Responses 接口，不代表常规 Codex 客户端的工具调用、会话压缩、图片或完整代理工作流已经可用。请先使用下面的内置 `chat` 客户端验证纯文本通道。

回答从网页提取为纯文本，不能保证保留 Markdown 标记、链接地址、代码围栏或精确空白格式。需要复用代码时，请对照网页检查缩进和内容。浏览器适配器会等待回答完成并通过归属与稳定性检查后，再返回正文；即使客户端使用 SSE，也不会逐 token 转发网页生成过程。

## 准备环境

目标环境是 macOS Apple Silicon，使用原生 ARM64 Bun 和本机 Chrome。本实验不需要构建 Electron 应用，也不需要下载原项目的 DMG。

1. 准备仓库声明的 Bun **1.4.0**。安装选项参见 [Bun 官方安装说明](https://bun.sh/docs/installation)。使用与仓库匹配的版本，不要仅因为安装页展示了更新版本就改动仓库锁文件。
2. 安装 [Google Chrome](https://www.google.com/chrome/)。
3. 在终端进入这个 fork 的仓库根目录，检查环境并安装锁定依赖：

```bash
bun --version
bun -e 'console.log(process.platform + "/" + process.arch)'
bun install --frozen-lockfile
```

在目标 Mac 上，前两项应分别显示 `1.4.0` 和 `darwin/arm64`。这些命令不安装浏览器，也不修改你的 shell 配置。

## 第一次运行

### 1. 创建本地配置

在仓库根目录执行：

```bash
bun run chatshare init
```

`init` 只初始化本地配置，不访问 ChatShare，也不发送模型请求。默认使用：

- 配置：`~/.codex-chatshare/config.json`
- 独立 Chrome profile：`~/.codex-chatshare/browser`

初始化生成的随机本地密钥用于保护本机接口。**它不是 ChatShare 密码、登录令牌，也不是 OpenAI API key。** 不需要把 ChatShare 凭证或官方 OpenAI token 填进它的位置。

### 2. 在专用窗口中正常登录

```bash
bun run chatshare login
```

在打开的 Chrome 窗口中，从 ChatShare 的正常入口登录，手动选择你有权限使用的席位，进入实际聊天页，并选择目标模型。遇到验证码、席位选择或服务商提示时，在网页中正常完成。

这个窗口使用实验自己的 profile；它不会导入你的日常 Chrome profile，也不会从原 Launcher 复制登录状态。在普通 Chrome 中已经登录，不代表专用窗口也已登录。

登录完成后，在运行 `login` 的终端按 **Ctrl-C**，等待进程结束，再启动服务。不要同时让 `login` 和 `serve` 占用同一个 profile。

### 3. 查看本地诊断

```bash
bun run chatshare doctor
```

`doctor` 用于检查实验的本地运行条件，并在服务已运行时查询本地健康接口。其输出不包含 Cookie、提示词或密钥。此步骤尚未启动服务时，显示 `Server: not running` 是预期结果。诊断正常不等于已经验证真实席位的发送、回复读取或模型能力。

### 4. 启动服务并准备聊天页

```bash
bun run chatshare serve
```

保持这个终端和它打开的 Chrome 窗口运行。服务会自动尝试进入 Plus 和 Pro；遇到登录、验证码或需要用户确认的网页步骤时，按网页正常完成即可。Pro 暂时满员会继续轮询容量，普通请求仍可使用 Plus。

### 5. 在另一个终端发送短文本

进入同一个仓库目录，执行：

```bash
bun run chatshare chat '请只回复OK'
```

内置客户端从本地配置读取接口密钥；不需要把密钥复制到命令行或 shell 历史。成功标准是：专用网页中只出现对应的一次发送，终端收到属于这次请求的回答，并且请求正常结束。

每次 `chat` 调用是独立请求，客户端不会自动带上前一次回答。需要前文时，将必要文本明确包含在新请求中。也可以从标准输入读取提示词：

```bash
bun run chatshare chat --stdin < prompt.txt
```

这样提示词正文也不会作为命令参数写入 shell 历史；`prompt.txt` 仍是需要自行保管的本地文件。

随后可以用一段短中文或简单代码块提示验证文本完整性。先串行测试；上一条请求结束前，不要切换席位、手动发送另一条消息或关闭受控页面。

结束时，在运行 `serve` 的终端按 **Ctrl-C**。

## 配置与数据隔离

`CHATSHARE_HOME` 可以覆盖默认实验目录。例如，先在两个终端中都设置：

```bash
export CHATSHARE_HOME="$HOME/.codex-chatshare-test"
```

然后执行同样的 `init`、`login`、`serve` 和 `chat` 命令。所有相关命令必须使用相同目录，才能读取同一配置、profile 和本地密钥。

目前正常登录入口固定为 `https://chatshare.tv/`，聊天站点固定为 `https://chat.chatshare.tv/`。请求不能指定任意目标网址。如果席位实际跳到其他域名，应先记录不含令牌的域名并检查适配范围，不能通过删掉来源检查来让它继续运行。

可在已有 `config.json` 中调整下列字段；保留初始化生成的 `version` 和 `token`，修改后重启相关进程。

| 字段 | 默认值或用途 |
| --- | --- |
| `port` | `3211`，只监听本机 |
| `chromeExecutablePath` | 可选；Chrome 可执行文件的绝对路径 |
| `turnTimeoutMs` | `180000`，单次文本请求超时 |
| `seatSetupTimeoutMs` | `120000`，点击席位后，导航、个人资料与输入框就绪、GPT-6 配置共用的超时；范围为 `1000`–`600000` 毫秒 |
| `pollIntervalMs` | `250`，页面观察间隔 |
| `stableIntervalMs` | `1500`，回答文本稳定观察间隔 |
| `maxPromptChars` | `24000`，完整传输提示词的字符上限，包含上下文、JSON 编码和封装说明；不是模型 token 上下文承诺 |
| `seatPollIntervalMs` | `5000`，席位满员时的容量轮询间隔 |
| `seatWaitTimeoutMs` | `0` 表示持续等待；可设为正数限制等待席位按钮可用的时间 |
| `heartbeatIntervalMs` | `240000`，前台滚动保活间隔 |
| `heartbeatIdleLimitMs` | `600000`，无业务需求后停止保活的时长 |
| `selectors` | 可覆写 `composer`、`sendButton`、`stopButton`、`userMessage`、`assistantMessage`、`assistantContent`、`errorMessage` |

旧配置未填写 `seatSetupTimeoutMs` 时会自动使用两分钟默认值；隔离 profile 加载较慢时，可在允许范围内增大此值。等待席位容量由 `seatWaitTimeoutMs` 控制，文本请求由 `turnTimeoutMs` 控制。Plus 完成准备后才开始准备 Pro；准备超时不会发送提示词，频道保持不可用，GPT-6 仍是硬性要求。

选择器应依据正常登录后实际观察到的页面调整。文本暂时稳定并不能独自证明生成已经完成；扩大超时或缩短稳定间隔也不能修复错误的页面绑定。不要猜测席位地址，不要将包含一次性登录令牌的完整跳转 URL 发到公开 issue。

实验目录包含登录状态及本地接口凭据。不要将它加入 Git、云盘共享或诊断附件。原 Launcher 的 profile、普通 Chrome 的 profile 和这个实验 profile 相互独立。

## 本地接口与凭据边界

默认接口只监听本机 `127.0.0.1:3211`，使用随机本地密钥鉴权。它是实验提供的文本接口，不是 ChatShare 宣布开放的 API，也不是官方 OpenAI API。

内置 `chat` 命令是首选验证客户端。其他客户端需要自行满足这个实验实际实现的请求范围；不能因为它们支持某种 Responses API 就推定所有字段都兼容。

本地接口只接受省略 `store` 或设置 `store: false`，表示不提供本地 Responses 历史存储；这不会替你开启网站的临时聊天，也不能保证 ChatShare 或上游网站不保存对话。

浏览器通过自己的 ChatShare 会话访问网页。本地接口密钥只在本地客户端与服务之间使用；官方 Codex/OpenAI token 不会被拿来登录 ChatShare 或转发到 ChatShare。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 找不到 Bun 或版本不符 | 检查 `bun --version`，按官方说明准备仓库要求的版本 |
| 找不到 Chrome | 确认 Chrome 已安装；检查 `doctor` 输出与生成的配置 |
| profile 正被使用 | 先结束该实验的另一个 `login` 或 `serve` 进程；不要删除仍在使用的 profile |
| 本地接口连接失败 | 确认 `serve` 仍在运行，客户端使用相同的 `CHATSHARE_HOME` 和端口 |
| 本地鉴权失败 | 确认服务端和内置客户端读取同一配置；不要用 ChatShare 密码或 OpenAI key 替代本地密钥 |
| 浏览器停留在门户、登录或选席位页 | `serve` 会自动尝试 Plus/Pro；登录或验证码仍需按网页正常完成 |
| 找不到输入框、发送按钮或回答 | 可能是登录后的 DOM 与当前适配不同；提供脱敏的结构证据，不能仅通过更换域名认定修复 |
| 网页已发送，终端却超时或报错 | 先查看网页是否仍在生成；点击发送后的超时、502、席位失效都按可能已提交处理，桥接不会停止或重发 |
| 代码工具、图片或续接 ID 报错 | 这些功能不在第一版范围内，先使用纯文本 `chat` 命令 |

遇到额度不足、服务商排队、验证码或会话失效，按网页给出的正常流程处理。实验不会绕过这些限制。

## 实账号验证时应记录什么

报告运行结果时，请记录 Mac 架构、Bun/Chrome 版本、提交版本、使用的子命令、错误类型，以及错误发生在登录、席位选择、发送还是读取回答阶段。可以提供隐藏账户信息的截图或经过检查的 DOM 片段。

不要提交 `config.json` 全文、浏览器 profile、Cookie、Authorization 请求头、一次性登录地址、完整 HAR 或私人对话。`doctor` 的安全输出不能代替对其他附件的检查。

后续只有在真实席位上验证了正常登录、准确提交、回答归属、完成检测和异常收尾，才能确认对应页面的文本接入可用。工具协议与完整 Codex 集成需要单独设计和验证。
