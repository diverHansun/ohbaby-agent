# Terminal 目标与职责

> 模块设计的第一份文档，说明内置终端为什么存在、做什么、刻意不做什么。后续的 architecture、dfd-interface、non-functional、test 都不得引入超出本文 Duties 的职责。
>
> 状态：已确认。第 ①–③ 项（第一版范围、agent 不碰用户终端、终端常驻与画面恢复）于 2026-11-02 确认；第 ④–⑦ 项（模块归属、传输与鉴权、安全边界、依赖与降级）于 2026-11-03 确认。

## 一句话存在意义

让用户不离开 ohbaby 的 web 界面，就能在右侧面板里打开当前 workspace 的真实 shell，像在系统终端里一样跑 `npm run dev`、`git status` 这类命令。

## 背景

- 终端真正运行的部分（PTY 和 shell 进程）在 `ohbaby serve` 所在的机器上，浏览器只负责显示和传递按键。web 端和以后的 app 端差别只在中间的传输方式，所以本批先在 web 端做，app 端以后复用。
- 右侧面板的页面登记表（`apps/ohbaby-web/src/ui/side-panel/side-pages.ts`）在注释中把终端列为计划中的页面，新增一种页面只需登记一条。终端页面登记为 `sessionScoped: false`，即不随主会话切换而重置。
- 参考项目：ZCode、deepseek-harness、opencode、pi-web 都有给人用的终端；kimi-code、minimax-code 没有。下文的取舍会注明参考来源。

## Design Goals（设计目标）

- **G1 够日常用**：跑开发服务器、敲 git、看日志这类日常操作要顺手。判断标准是“不做这个功能，用户会不会觉得终端不能用”；只影响精致程度的功能留到以后。
- **G2 环境和系统终端一致**：终端里能找到的命令、看到的颜色和编码，应和用户在 macOS 终端里看到的一样，不因 `ohbaby serve` 的启动方式而缺 PATH 或乱码。
- **G3 不误杀正在运行的程序**：关闭终端时，如果里面还有程序在跑，要先提醒用户；空闲终端则直接关闭，不打扰。
- **G4 资源有上限**：终端数量、滚动历史和单次输入都有明确上限，避免开了又忘的终端无限占用进程和内存。
- **G5 和 agent 的 shell 工具分开**：给人用的终端是一套独立能力，不复用、不改动 `ohbaby-agent` 的 shell 工具。三个参考项目都这样分开。

## Duties（职责）

- **D1 打开终端**：右侧面板顶部 `+` 菜单里的 Terminal，以及面板没有 tab 时入口页里的 Terminal，点了都是新建一个终端，成功后打开并选中新 tab；失败才提示原因。不显示“正在创建”、转圈或占位 tab。一个 tab 就是一个终端，没有“选择接回哪个终端”的列表（参考 Codex、Cursor、Claude app 的右侧面板）。
- **D2 多终端与上限**：可以同时开多个终端，整个 `ohbaby serve` 最多 16 个，不分 workspace。正在创建、正在关闭或清理失败的终端也占名额；创建前先预留，创建失败完成清理后释放（2026-11-04 审查确认）。达到上限时拒绝新建并提示“已经开了 16 个终端，关掉不用的再试”，不自动关闭旧终端（opencode 普通 PTY 路径清理的是超出保留上限的已退出终端，不能将其理解为淘汰运行中的终端）。上限按全局计算，是因为终端管理器整个 serve 只有一个；如果按 workspace 计算，开多个项目时总数没有上限，切走的项目里的终端也容易被遗忘（2026-11-03 审查后由“每个 workspace 8 个”改为此规则）。
- **D3 工作目录**：新终端的初始目录是当前 workspace 目录。没有打开 workspace 时，在用户主目录打开：macOS / Linux 为 `$HOME`，Windows 为 `%USERPROFILE%`，与 macOS 终端、Ghostty、Windows Terminal 新开窗口时的默认目录一致；服务端统一用 Node 的 `os.homedir()` 取得。之后用户可以随意 `cd` 到任何目录，不做限制（2026-11-04 确认）。
- **D4 选择 shell**：
  - macOS / Linux：依次尝试 `$SHELL`、zsh、bash、sh，用第一个可执行的（参考 ZCode）。
  - Windows：依次尝试 pwsh、powershell、cmd。
  - POSIX shell 以登录模式（`-l`）启动，让它读取 `~/.zprofile` 等配置，保证 Homebrew、nvm 装的命令能找到（参考 opencode、pi-web）。
- **D5 终端环境变量**：设置 `TERM=xterm-256color`、`COLORTERM=truecolor`；系统没有 UTF-8 语言环境时补上一个（参考 ZCode、pi-web）。
- **D6 显示与交互**：
  - 颜色正确，vim、htop 等全屏程序可用。
  - 配色取自网页现有的颜色 token，与页面一致。网页目前只有浅色主题，以后加入深色主题时终端随之变化。
  - 终端铺满 tab 的内容区，上方不加小标题栏（参考 Claude app、Codex；Cursor 的小标题与 tab 标题重复）。字体用现有的 `--font-mono`。
  - 面板宽度变化时自动重新排版。
  - 选中后 Cmd+C 复制，Cmd+V 粘贴。
  - 输出里的 http(s) 链接可以点击，在新的浏览器标签页打开。
- **D7 关闭终端**：
  - 点 tab 上的 `x` 关闭终端。确认关闭后保留原画面，关闭按钮暂时不可重复点击，不额外显示“正在关闭”或转圈；借鉴 deepseek-harness，清理完成后才删除服务端记录、释放名额并返回成功，浏览器随后移除 tab。重复关闭和 serve 停止等待同一个关闭任务。清理失败时保留记录并提示失败，允许重试，刷新后也能找回（见 D9、F1b）。正常关闭必须真正结束应清理的进程、释放资源和名额，保留记录只是失败时的补救（2026-11-04 审查确认）。
  - 如果 shell 下面还有任何子进程（前台、后台都算，例如 `npm run dev &`），先弹出轻量确认，例如“终端里还有程序在运行（node），关闭会把它一起结束。[取消] [关闭]”。没有子进程的空闲终端直接关闭。判断依据是进程表，与强制结束时记录子孙进程用的是同一份结果（2026-11-03 审查后由“只看前台程序”改为此规则，因为只看前台会漏掉后台任务）。
  - 确认关闭后先发挂断信号，让 shell 带着它启动的程序一起退出；2 秒后，这个终端会话里仍未退出的进程（不只是 shell）全部强制结束。只给 shell 发强制结束不够：node-pty 的 `kill()` 只发给 shell 本身，忽略挂断信号的子程序会留在后台继续占端口。用 `setsid` 等方式主动脱离终端、且在首次检查时已不属于该终端的进程不在此列。`nohup` 只是忽略挂断信号，不保证脱离终端；仍属于该终端时，主动关闭会清理它。
  - Windows 上没有同样的进程表查询，node-pty 也不支持信号，直接结束终端，不弹确认。
- **D8 资源上限**：每个终端在服务端保留 1000 行滚动历史；每条输入消息的完整 JSON 编码后最多 64 KiB（65,536 字节）。借鉴 deepseek-harness，按实际 UTF-8 字节数检查消息大小；浏览器自动把长粘贴拆成符合上限的小块，保持字符完整并按原顺序发送。自动拆分是 ohbaby 的体验要求，dsh 的对应代码在输入超限时会报错（2026-11-04 审查确认）。
- **D9 终端常驻与接回**：
  - 终端在服务端常驻，刷新网页、关闭面板、切换 tab 都不会结束它。只有三种情况会结束：用户手动关闭、shell 自己退出、`ohbaby serve` 停止。不采用 Codex 断线即杀、pi-web 无人连接 120 秒后回收的做法，避免刷新网页就杀掉正在运行的 dev server。
  - **终端 tab 由服务端决定**：网页加载时、窗口重新获得焦点时，向服务端查询仍保留的终端（包括正在关闭和清理失败的记录），补齐缺少的终端 tab；已有标签不重复添加，不改变正在看的页面、输入焦点或面板开关。没有选中标签时选中第一个终端，但不自动展开收起的面板。已经显示退出码的 tab（shell 自己退出，见 F7），同步时不再改写为“终端已结束”。刷新网页后终端 tab 自动回来，不需要列表或其他接回入口。D50 规定右侧面板刷新后只记住开关和宽度、不恢复任何 tab（见[子代理生命周期讨论记录](../problem-lists/2026-10-26-subagent-lifecycle/improve-1/00-discussion.md)）；终端 tab 由服务端的终端列表重建，不违反 D50。
  - **tab 标题**：终端图标 + 目录名，例如 `cocobot`；在主目录打开的终端显示 `~`（标题由服务端算好放在终端信息的 `title` 里，浏览器不知道主目录在哪）；与 macOS 终端、Ghostty 的窗口标题一致；鼠标悬停时提示完整路径和 shell 名（参考 Codex）。不写 shell 名：几乎每个终端都是 `zsh`，区分不了，面板最窄只有 320px，标题越短越不容易被截断；“这是终端”由图标表达。同一目录开多个终端时标题相同，按位置区分，第一版不加编号。tab 里会出现所有 workspace 的终端，标上目录名就不会搞混。切换 workspace 时终端 tab 保留，看标题就知道属于哪个项目（2026-11-04 由 `shell 名 · 目录名` 改为此规则）。
  - 接回时恢复画面内容，包括全屏程序的备用屏幕和滚动历史。做法是服务端维护一份屏幕快照（参考 deepseek-harness）；不采用 pi-web、opencode 普通 PTY 路径重放原始输出尾部的做法（opencode 的 GUI 持久终端路径也使用快照），因为截取的尾部可能从控制码中间开始，导致乱码。已知局限：快照不包含 SGR 鼠标编码（`?1006`）和光标隐藏（`?25l`）两种模式，接回后这两项可能与断开前不同（2026-11-03 用 `@xterm/headless` 6.0.0 和 `addon-serialize` 0.14.0 实测）。
- **D10 传输与鉴权**：
  - 新建、列出、关闭这类管理操作走 REST，沿用现有 token。只有新建会用到 `x-ohbaby-directory`（可选，见 D3）；列出和关闭按 id 操作全部 workspace 的终端，忽略这个头。
  - 按键、输出、尺寸变化这类数据流，每个终端走一条 WebSocket。不复用 SSE，因为按键需要双向通道，大量终端输出也不应混入会话事件流（参考 Codex、ZCode、deepseek-harness）。
  - WebSocket 只用五种消息：浏览器发往服务端的输入、尺寸变化，服务端发往浏览器的快照、实时输出、退出。
  - 浏览器 WebSocket 不能自定义请求头，token 改放在 WebSocket 子协议（`Sec-WebSocket-Protocol`）里（参考 kimi-code），编码成 base64url，避免 `--auth-token` 指定的 token 含有子协议不允许的字符。不放进 URL，避免被日志和浏览历史记录。
  - 浏览器拿不到握手失败时的 HTTP 状态码，只能看到 1006。所以 token 错误、终端不存在这类需要页面提示的情况，先完成握手，再用专门的关闭码告诉浏览器原因。
  - 终端的 WebSocket 握手检查 Origin：没有 Origin（命令行等非浏览器客户端）时放行；有 Origin 时，主机名必须是本机名，否则拒绝。ohbaby 用 token 不用 cookie，其他网页本来拿不到 token，这道检查是给风险最高的入口多加一层防护，以防 token 将来从别处泄漏（参考 kimi-code；2026-11-03 审查后由“不做 Origin 检查”改为此规则）。
  - 同一终端可以在多个页面同时打开，各页面都能看到输出、都能输入；尺寸以最后一次调整为准。
- **D11 安全边界**：终端是一个不经审批的 shell，能连上终端就能在本机执行任意命令，因此：
  - **只在本机地址开放**：`ohbaby serve` 监听非 loopback 地址时，终端整体关闭：REST 返回 403 `TERMINAL_LOOPBACK_ONLY`，WebSocket 握手直接拒绝。这与 `DIRECTORY_BROWSER_LOOPBACK_ONLY` 的先例一致。非 loopback 模式下 ohbaby 本身就不提供网页界面（`static-assets.ts` 返回 403），所以这条限制只体现在接口上，不需要页面提示。
  - **沿用现有 token 鉴权**：终端接口与其他接口共用 `isAuthorizedDaemonRequest`，不另加检查。它在未配置 token 时拒绝所有请求，并用常量时间比较（2026-11-04 在终端实施前修复，提交 `2a219aeb`）。
  - **本机模式下校验 Host 头**：只检查主机名，不检查端口。主机名必须是 `localhost`、`127.0.0.1`、`[::1]` 或 serve 实际绑定的 loopback 地址，否则返回 403。不检查端口是为了兼容 SSH 端口转发（例如 `ssh -L 9000:localhost:4096` 时 Host 是 `localhost:9000`）；DNS 重绑定攻击靠的是主机名，与端口无关。校验 Host 是为了防 DNS 重绑定：恶意网页把自己的域名指向 `127.0.0.1` 后，可以读取首页 HTML 里注入的 token（`window.__OHBABY__`）。这个问题现有代码已经存在，终端上线后后果会从“能替用户发 prompt”升级为“能直接执行命令”，所以必须在终端上线前修复（参考 kimi-code 在 WebSocket 握手时做的 Host 和 Origin 白名单）。这是 server 级改动，作用于所有接口，测试要覆盖现有接口不受影响；server 的设计文档在 D4 中同步记录了这一条。
- **D12 终端不可用时降级**：node-pty 只在第一次新建终端时加载。加载失败时，用全局 `NoticeStack` 在右上角简短提示“终端不可用”及原因，不添加失败 tab，`ohbaby serve` 和聊天等其他功能照常工作。依赖选型（`@lydell/node-pty` 锁定精确版本等）见 [architecture](architecture.md)。

## Non-Duties（非职责）

- **N1 不做分屏**：一个 tab 里只有一个终端，需要并排时开两个 tab。
- **N2 不做终端内搜索**（Cmd+F）：以后可以用 xterm 现成插件补上，不影响本批结构。
- **N3 不做 shell 选择器**：不让用户每次选择开 zsh 还是 bash。
- **N4 不做字体和配色自定义**：跟随 ohbaby 主题。
- **N5 不做底部终端面板**：本批只在右侧面板提供终端。
- **N6 不做内置浏览器**：内置浏览器等 app 端完成后另行设计，因为 web 端的 iframe 有无法绕过的限制。
- **N7 不复用、不改动 agent 的 shell 工具**：`ohbaby-agent/src/shell` 保持不变（对应 G5）。
- **N8 不做多客户端输入仲裁、分屏同步等多人协作能力。**
- **N9 agent 不能读取或写入用户的终端**：用户终端不进入 agent 的工具集，也不绕过 agent 命令的审批链。参考项目都这样分开：deepseek-harness 在设计文档中否决了合并；Codex 只把 agent 的后台终端展示给用户，不提供客户端写入接口。
- **N10 不做闲置终端自动回收**：靠 D2 的全局 16 个上限兜底，终端 tab 又会显示全部终端，不做 deepseek-harness 那种闲置 2 小时自动回收。
- **N11 `ohbaby serve` 重启后不恢复终端**：shell 进程随 serve 一起结束，重启后不重建。
- **N12 不做跨网络的逐条输出确认**：借鉴 deepseek-harness，服务端屏幕处理不过来时暂停读取 PTY，处理下来后恢复；每个查看者独立限制积压，接回时快照后的待发输出也计入额度。借鉴 opencode 的小型写入队列，浏览器等 xterm 处理完当前批次再处理下一批，并限制尚未处理的输出总量。查看者或浏览器的输出积压超过 2 MB 时，只断开该连接，退避重连后拿快照恢复。浏览器内部的写入完成回调不作为网络消息发送，五种 WebSocket 消息保持不变。持续刷屏时接受画面跳变和重复重连；服务端暂停读取可能暂时阻塞该终端里持续输出的程序。具体计量与恢复规则见 dfd-interface F5（2026-11-03 审查确认）。
- **N13 不过滤环境变量**：终端继承 `ohbaby serve` 的环境，与用户在系统终端里看到的一致。deepseek-harness 会过滤密钥，是因为它的终端可能运行在沙箱或远程机器上，ohbaby 没有这种场景。
- **N14 不做快捷键**：Cursor 用 ⌘J（网页里会被 Chrome 占用），Codex 用 Ctrl+\`。第一版只从 `+` 菜单和入口页打开终端，快捷键以后再加。

## 模块归属

代码分三处，不新建 package：

```
ohbaby-server/src/terminal/            终端核心：shell 进程、屏幕快照、数量上限、关闭流程；不 import Hono
ohbaby-server/src/protocols/web/routes/terminals.ts
                                       路由：REST 与 WebSocket，只做协议翻译，调用 terminal/
ohbaby-sdk/src/contract/terminal.ts    前后端共用的终端信息与 WebSocket 消息格式
apps/ohbaby-web/src/ui/side-panel/terminal/
                                       Terminal 页面与 xterm.js，按 side-pages.ts 的预留方式登记
```

理由：

- **后端放 `ohbaby-server`，不放 `ohbaby-agent`**：用户终端只在 `ohbaby serve` 下由浏览器使用，不属于 agent 的领域逻辑；node-pty 是重依赖。两点分别对应 server 的 N1（不承载领域逻辑）和 G2（重依赖只进 server）。参考项目也没有放进 agent 核心：ZCode 放在 `packages/services`，deepseek-harness 单独拆出 `terminal-controller`，Codex 放在 `app-server`。
- **不新建 package**：目前只有 server 一个使用方，浏览器和以后的 app 都经由 `ohbaby serve` 使用终端。新建包要多一套构建配置和一个 npm 发布物，却换不来眼前的好处。server 里已有同类先例：`runtime/directory-browser.ts` 同样是只在 serve 下提供、只允许 loopback 访问的本机能力。
- **拆包不能解决原生依赖的安装风险**：`ohbaby-cli` 依赖 `ohbaby-server`，无论终端代码放在哪个包，安装 CLI 时都会装上 node-pty。这个风险靠选择 `@lydell/node-pty` 和懒加载来降低（见 D12）。
- **核心和路由分两层**：路由放在 `protocols/web/routes/`，与 sessions、subagents 等现有路由一致；核心不依赖 Hono，以后需要拆包时可以整个目录搬走。
- **以后满足任一条件再考虑拆包**：app 不经 `ohbaby serve`、改为在 Electron 主进程里直接管理终端；需要在远程（SSH）机器上运行终端；需要让 node-pty 变成可选安装。

## 以后可以做

以下需求本批不做，但已记录方向，届时另行设计：

- **把终端输出发进聊天**：用户选中一段终端输出，一键发到聊天输入框，让 agent 帮忙看报错。数据只从终端单向流向聊天，agent 仍然碰不到 shell。

## 自检

- **能否一句话说清存在意义？** 能，见顶部。
- **能否说清不做什么？** 能，见 N1–N14。
- **与其他模块职责重叠的风险？** 与 `ohbaby-agent` 的 shell 工具在“运行 shell”上看起来相近，但服务对象不同（人与 agent），已用 G5、N7 明确分开。
