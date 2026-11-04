# Terminal 架构

> 第二份模块设计文档，说明内置终端内部由哪些部分组成、怎么协作，以及为什么这样分。每一项都对应 [goals-duty](goals-duty.md) 中的目标（G）或职责（D），不引入新职责。
>
> 本模块不单独写 `data-model.md` 和 `use-case.md`：核心对象只有“终端”一个，字段放在 [dfd-interface](dfd-interface.md) 的契约里；业务动作只有新建、接回、关闭三种，流程放在 dfd-interface 的数据流里。

## 1. Architecture Overview（总体架构）

终端横跨三个包，按“谁运行在哪里”划分：

```
浏览器 · apps/ohbaby-web
┌──────────────────────────────────────────────────────────────┐
│ Terminal 页（右侧面板的一种页面）                              │
│   ├─ 终端 tab 同步：按服务端的终端摆出 tab                       │
│   └─ 终端视图：xterm.js 显示、主题、自适应、链接、复制粘贴        │
│ 终端客户端：REST 调用 + 打开 WebSocket                          │
└───────────────┬──────────────────────────────┬───────────────┘
        REST（新建/列出/关闭）            WebSocket（数据流）
                │                              │
ohbaby-server ──┼──────────────────────────────┼────────────────
┌───────────────▼──────────────────────────────▼───────────────┐
│ 终端路由 protocols/web/routes/terminals.ts                     │
│   鉴权（token、loopback、子协议）→ 翻译成对终端核心的调用        │
├──────────────────────────────────────────────────────────────┤
│ 终端核心 terminal/（不依赖 Hono）                               │
│   终端管理器：按 id 登记全部终端，全局上限 16                    │
│   终端会话：一个 shell 进程 + 一份服务端屏幕 + 当前连接的查看者   │
│   启动配置：选 shell、参数、环境变量、工作目录                   │
│   PTY 适配：懒加载 node-pty，失败时报告“不可用”                  │
└──────────────────────────────────────────────────────────────┘
横切改动：Host 头校验（daemon 级）、WebSocket 接入（传输层）

ohbaby-sdk · contract/terminal.ts：终端信息、WebSocket 消息、错误码
```

### 服务端各部分

| 部分 | 负责什么 | 对应 |
| --- | --- | --- |
| **终端管理器** | 持有全部终端：新建前预留名额，已登记终端加正在创建任务总数不超过 16 个；列出全部；按 id 查找；关闭；`ohbaby serve` 停止时全部结束 | D1、D2、D9、N11 |
| **终端会话** | 一个终端的全部状态：shell 进程、服务端屏幕（用于快照）、正在连接的查看者。用一条内部队列按顺序处理输出、接回快照和尺寸变化；输出写入屏幕并处理完后推给每个查看者；屏幕处理不过来时暂停读取 PTY，处理下来后恢复；独立限制每个查看者的输出积压；把查看者的输入写给 shell；判断是否有程序在运行；按“挂断 → 2 秒后强制结束会话内全部进程”关闭，退出通知只发一次 | D6、D7、D8、D9、N12 |
| **启动配置** | 纯函数：按平台选 shell 和参数，补齐 `TERM`、`COLORTERM`、UTF-8 语言环境，确定初始目录 | D3、D4、D5、N13 |
| **PTY 适配** | 唯一 import node-pty 的地方。第一次使用时加载，加载失败就记住失败原因，之后的新建请求都返回“不可用” | D12 |
| **终端路由** | REST：新建、列出、关闭。WebSocket：握手鉴权后把连接交给对应的终端会话。所有入口先过 loopback 和 token 检查 | D10、D11 |

### 浏览器各部分

| 部分 | 负责什么 | 对应 |
| --- | --- | --- |
| **Terminal 页** | 右侧面板登记的新页面类型，一个 tab 显示一个终端 | D1、D9 |
| **终端 tab 同步** | 网页加载时、窗口重新获得焦点时请求终端列表，不改变面板开关与现有选中项，无选中项时选中第一个终端标签、不展开面板：为服务端有、面板里没有的终端补上 tab；面板里有、服务端已经没有的终端 tab，显示为已结束 | D9 |
| **终端视图** | 挂载 xterm.js，接上 fit 和 web-links 插件，按 CSS 变量生成配色，打开 WebSocket，收到快照后重画，之后用有界队列追加实时输出，等待 xterm 写入完成再处理下一批；本地输出积压超限时断开并退避重连 | D6、D9、N12 |
| **终端客户端** | 复用现有 daemon 连接配置（地址、token、workspace 目录），发 REST 请求、建立 WebSocket | D10 |
| **关闭确认** | 关闭终端 tab 时先请求服务端关闭；服务端回复“有程序在运行”时弹出确认，用户确认后带上强制标记再关一次 | D7 |

### 页面反馈

内部仍需区分创建、连接、关闭等过程，但不为每一步增加提示、转圈或独立页面。正常操作直接展示结果，失败或无法继续输入时才给必要反馈。各情形的来源见 [dfd-interface](dfd-interface.md)：

| 状态 | 触发 | 页面显示 |
| --- | --- | --- |
| 新建或首次连接 | 请求尚未完成 | 新建时保持原页面；成功后打开终端，首次连接显示终端容器。不加“正在创建”、转圈或占位 tab |
| 已连接 | 快照写入完成 | 直接显示终端内容，不加“已连接”标签 |
| 重连中 | 连接意外断开、收到 4408 或浏览器本地输出积压超限 | 保留当前画面，顶部提示“正在重新连接” |
| 已退出 | 收到 `exit` | 保留画面，末尾显示“进程已退出（代码 N）” |
| 已结束 | 同步列表确认服务端已没有这个终端（收到 4404 时也先同步确认） | “终端已结束”，关闭 tab 即可 |
| 达到上限 | 新建返回 `TERMINAL_LIMIT_REACHED` | “已经开了 16 个终端，关掉不用的再试” |
| 不可用 | 新建返回 `TERMINAL_UNAVAILABLE` | “终端不可用”及原因 |
| 确认关闭 | 关闭返回 `TERMINAL_BUSY` | 确认框，带程序名 |
| 正在关闭 | 关闭请求正在等待清理 | 保留 tab 和原画面，仅禁用关闭按钮的重复点击，不加状态文案或转圈 |
| 关闭失败 | 返回 `TERMINAL_CLOSE_FAILED`，或列表返回 `close_failed` | 保留或恢复 tab，显示原因，用原来的 `x` 重试关闭 |
| 未授权 | 401 或 4401 | 沿用现有的未授权处理 |

### 右侧面板接入（2026-11-04 审查确认）

- 新建入口先调用终端客户端，成功后再把真实 `terminalId` 交给面板，打开并选中标签。失败复用现有的简短错误反馈，不创建错误页或占位标签。
- 面板只补充“打开并选中”和“补齐标签但不切换”两种操作。自动同步按终端 id 去重，不改变面板开关；无选中项时选中第一个标签，不抢输入焦点。
- 菜单名称仍是 `Terminal`；每个终端标签显示终端图标和终端信息里的 `title`（目录名，主目录为 `~`），悬停提示完整路径与 shell 名。不要把每个标签的标题写进全局页面定义。
- 提示全部复用现有组件，不新写：新建失败（上限、不可用）用 `NoticeStack`，显示在右上角，不建 tab；关闭时有程序在运行用 `ConfirmDialog`（危险色确认，焦点默认在“取消”）；正在重新连接、关闭失败用终端页顶部的 `Banner`；进程退出在终端末尾写一行灰字“进程已退出（代码 N）”。
- 终端页必须使用创建或查询返回的真实 id，不通过 `initialState` 填空 id 来套用现有的同步新建流程。Subagents 沿用现有方式。
- 关闭中的记录刷新后也能恢复标签，不接回终端、不显示额外状态文案。只在本页面正在等待关闭请求时禁用重复操作；否则仍可用原来的关闭入口等待已有任务或重试。
- 关闭按钮和标签上的键盘关闭操作共用已确认的关闭流程。只为 terminal 接入这些行为，不引入通用页面生命周期框架。

参考：ZCode 的 `packages/ui/src/terminal/TerminalSession.tsx` 直接渲染终端容器，启动失败时才写入错误；`TerminalTabTrigger.tsx` 接收每个标签自己的标题。kimi-code 的 VS Code 界面 `apps/vscode/webview-ui/src/components/Header.tsx` 中，新聊天按钮只触发操作，未给这个按钮添加独立的“正在创建”显示；这是界面处理的参考，不是内置终端实现。

### 横切改动

| 改动 | 位置 | 对应 |
| --- | --- | --- |
| Host 头校验 | daemon 的全局中间件，作用于所有接口 | D11 |
| WebSocket 接入 | 传输层监听时挂上 `ws` 的 `WebSocketServer` | D10 |
| 终端接口只在 loopback 且有 token 时可用 | 终端路由内部 | D11 |

## 2. Design Pattern & Rationale（设计模式与理由）

本模块刻意少用模式，只在两处用了，各有具体理由：

- **适配器（PTY 适配）**：其余代码只认一个很小的“伪终端”接口（写入、调整尺寸、暂停与恢复读取、结束、取 shell 进程号、监听输出和退出），不直接 import node-pty。理由有两个：一是 `@lydell/node-pty` 是第三方重新打包的 beta 版，日后换回官方 node-pty 只改这一处；二是测试可以用假的伪终端驱动终端会话，不必每次都真的开 shell。
- **登记表（终端管理器）**：一个 `Map<id, 终端会话>`，正在关闭或清理失败的终端也保留在表内并占用名额，清理成功后才删除。再用一个小集合记录正在创建的任务，创建前占名额，成功后转入登记表，失败清理完再释放。serve 停止也等待这个集合里的任务。借鉴 dsh 的 pending 记录，不引入生命周期框架或事件总线。

**终端内部的顺序处理**：借鉴 deepseek-harness 的 `enqueue()`，每个终端只维护一条执行队列，输出解析完才处理后续快照或 resize。接回时先将快照入发送队列，再登记查看者，后续输出自然排在快照后面。浏览器借鉴 opencode 的 `terminalWriter`，将快照恢复、输出、本地尺寸变化按顺序处理；恢复结束前只记录容器的新尺寸。使用小型内部函数即可，不新建 package 或通用调度框架。代价是快照和 resize 需要等待前面的输出，积压仍遵循 N12 的限制（2026-11-04 审查确认）。

**关闭任务**：借鉴 deepseek-harness 的 `closeProcess()` 和 controller `close()`，每个终端保存一个 `closePromise`。重复关闭、serve 停止都等待它，清理成功后再删登记并返回成功；失败保留记录，供显式重试或停止清理使用。借鉴 dsh controller 的 `list()`，尚未清理完的记录仍返回给页面；刷新后保留关闭入口。接口携带运行、关闭中或关闭失败的状态，只用来决定是否接回和提示失败，不增加正常过程的状态展示。沿用 daemon 已有的 `stopPromise` 和清理结果汇总习惯，不另建后台清理任务集合。

刻意不用的：

- **不复用现有的 SSE hub 和事件重放**：那套机制为会话事件设计，靠序号和环形缓冲重放。终端输出量大，重连恢复靠的是屏幕快照，不需要逐条重放，混在一起反而会撑满会话事件的缓冲。
- **不做发布/订阅框架**：一个终端的查看者通常只有一两个，终端会话直接持有一个查看者集合、逐个发送就够了。
- **不把终端塞进 `UiBackendClient`**：`UiBackendClient` 同时服务命令行 TUI（进程内）和 web。终端只在 `ohbaby serve` 下存在，加进这个接口会逼着进程内实现也写一套空方法。web 单独用一个终端客户端，复用同一份连接配置。

## 3. Module Structure & File Layout（模块结构与文件组织）

```
packages/ohbaby-server/src/
├─ terminal/                                 终端核心，不 import Hono
│  ├─ terminal-manager.ts                    终端管理器
│  ├─ terminal-session.ts                    终端会话
│  ├─ shell-launch.ts                        启动配置（纯函数）
│  ├─ pty.ts                                 PTY 适配与懒加载
│  ├─ process-tree.ts                        进程表解析、归属和发信号前的身份检查
│  ├─ errors.ts                              终端错误码与状态
│  └─ index.ts                               对 server 其余部分的出口
├─ protocols/web/routes/terminals.ts         终端路由，形如现有的 registerGlobalSettingsRoutes
├─ auth/host-check.ts                        Host 头校验（新增）
├─ transport/node-listen.ts                  改：挂上 WebSocketServer
└─ runtime/daemon/server.ts                  改：创建终端管理器、注册路由和 Host 校验、停止时结束全部终端

packages/ohbaby-sdk/src/contract/terminal.ts 终端信息、WebSocket 消息、错误码、子协议前缀

apps/ohbaby-web/src/
├─ api/daemon/terminals.ts                   终端客户端（REST + WebSocket）
└─ ui/side-panel/
   ├─ terminal/
   │  ├─ TerminalPage.tsx                    一个 tab 的终端页面与各状态
   │  ├─ use-terminal-tabs.ts                终端 tab 同步
   │  ├─ TerminalView.tsx                    xterm.js 挂载与连接
   │  ├─ terminal-theme.ts                   CSS 变量 → xterm 配色
   │  ├─ use-terminal-close.ts               关闭确认流程
   │  └─ terminal-page.css
   ├─ side-pages.ts                          改：登记 terminal 页面
   ├─ SidePanelPage.tsx                      改：加 terminal 分支，SidePageContext 带上终端客户端
   └─ SidePanel.tsx / use-side-panel.ts      改：关闭 tab 前交给页面的关闭流程
apps/ohbaby-web/src/ui/shell/AppController.tsx 改：构造 SidePageContext 时传入终端客户端
```

对外稳定的部分只有两处：sdk 里的契约，以及 server 上的 HTTP/WebSocket 接口。`terminal/` 内部的文件划分是实现细节，可以随实现调整。

### 依赖

| 依赖 | 版本 | 所在包 | 用途 |
| --- | --- | --- | --- |
| `@lydell/node-pty` | `1.2.0-beta.18`，锁定精确版本 | server | 开 shell。各平台预编译包以可选依赖的方式提供，安装时不跑脚本、不编译 |
| `ws`、`@types/ws` | `8.22.1`、`8.18.2` | server | WebSocket 服务端，通过 Node HTTP server 的 `upgrade` 事件接入 |
| `@xterm/headless` | `6.0.0` | server | 服务端屏幕，用于生成快照 |
| `@xterm/addon-serialize` | `0.14.0` | server | 把屏幕序列化成快照 |
| `@xterm/xterm` | `6.0.0` | web | 浏览器端显示 |
| `@xterm/addon-fit` | `0.11.0` | web | 按容器尺寸算行列 |
| `@xterm/addon-web-links` | `0.12.0` | web | 让 http(s) 链接可点击 |

xterm 系列锁定精确版本，保证 headless、serialize 和浏览器端版本配套。`@lydell/node-pty` 没有安装脚本，不需要加进 `pnpm-workspace.yaml` 的构建白名单。版本号于 2026-11-03 用 `npm view` 核实。

## 4. Architectural Constraints & Trade-offs（约束与权衡）

| 选择 | 放弃的方案 | 代价 |
| --- | --- | --- |
| **终端管理器挂在 daemon 上，一个 serve 一个** | 每个 workspace 实例各自持有终端 | WebSocket 不能带 `x-ohbaby-directory` 头，按 id 直接找到终端最简单；server 也没有单个 workspace 的回收（server N7），挂在 workspace 实例上得不到任何好处。上限也随之按全局计算，比按 workspace 计数更简单，也真正限住了总资源 |
| **服务端维护屏幕快照** | 重放原始输出尾部（pi-web、opencode 的普通 PTY 路径） | 每段输出在服务端多解析一遍，每个终端多占 1000 行屏幕内存。换来的是接回后画面准确，前端不用藏 DOM |
| **服务端屏幕反压 PTY，查看者和浏览器输出积压超限则断开重连** | 跨网络的逐条输出确认 | 借鉴 deepseek-harness 的 PTY 暂停与恢复、有界查看者队列，以及 opencode 的前端顺序写入队列；浏览器有界队列超限重连是针对本方案的调整。持续刷屏时接受画面跳变；服务端暂停读取可能暂时阻塞持续输出的程序 |
| **清理成功后再删记录、返回成功** | 先删记录，再单独追踪后台清理任务 | 正常退出立即完成；不响应退出时需等待两秒宽限期及后续检查。关闭期间占名额，前端保留原画面，仅禁用关闭按钮的重复点击 |
| **关闭走“先试关 → 有程序就返回忙 → 确认后强制关”** | 另开一个“查询是否忙”的接口 | 关闭请求多一次往返，但判断和关闭在同一个请求里完成，不会出现查询时空闲、关闭时却有程序的情况 |
| **“有没有程序在跑”看进程表里 shell 的子孙进程** | node-pty 自带的前台进程名；shell 集成（deepseek-harness） | 每次关闭多查一次进程表（约十几毫秒）。换来后台任务也能被发现，而且和强制结束时记录子孙进程是同一份查询，一套机制两处用。Windows 不查进程表，所以 Windows 不弹确认（已写入 D7） |
| **token 错误、终端不存在时先完成握手，再用关闭码说明原因** | 握手前直接返回 HTTP 401/404 | 未授权的连接会短暂建立再被关闭，但不会收到任何终端数据；换来浏览器能区分“该重连”和“别重连”。浏览器拿不到握手失败的状态码，否则只能看到 1006，然后无限重试 |
| **终端代码留在 server 包内，不拆包** | 新建 `ohbaby-terminal` 包 | 见 goals-duty“模块归属”；以后拆包时整个 `terminal/` 目录搬走即可 |
| **Host 校验作用于所有接口** | 只给终端接口加 | 改动影响面变大，要回归现有接口；但 token 是从首页 HTML 泄漏的，只保护终端接口挡不住泄漏本身 |

### 输出积压与顺序处理的参考代码

- deepseek-harness：`packages/subprocess/subprocess-local/src/terminal.ts` 在缓冲满时暂停 PTY，排空后恢复；`packages/api/terminal-controller/src/terminal.ts` 等服务端屏幕写入完成后继续消费；同目录 `stream.ts` 为每个查看者限制队列容量。
- opencode：`packages/gui-plugins/src/terminal/connection.ts` 的持久终端路径使用快照恢复；`writer.ts` 将输出和尺寸变化放在同一队列，合并连续输出，等终端写入完成后继续。其队列本身没有容量上限，ohbaby 增加本地积压计数和超限重连。
- deepseek-harness 前端 `packages/api/terminal-controller/src/client/model.ts` 的 `acknowledge(revision)` 是本地显示完成通知，不等同于发送网络 ACK；其输入命令确认是另一套机制。

## 改动面清单

借用 plan-code-improvement 的改动面格式，列出对现有代码的修改。新增文件见第 3 节。

| 文件 | 改什么 | 风险 |
| --- | --- | --- |
| `packages/ohbaby-server/src/transport/node-listen.ts` | 在 HTTP server 的 `upgrade` 事件上接入终端路由提供的 WebSocket 处理器；路由内部创建 `WebSocketServer({ noServer: true, handleProtocols, maxPayload: 65536 })`，只协商 `ohbaby.terminal.v1`。停止时先对 `wss.clients` 逐个 `terminate()`，再关闭 HTTP server | 已升级的 WebSocket 不受 `closeAllConnections()` 管，须单独结束，避免停止流程被挂住 |
| `packages/ohbaby-server/src/runtime/daemon/server.ts` | 创建终端管理器；在 `mountRoutes` 最前面加 Host 校验；终端路由注册在外层 `this.app` 上，位于多 workspace 分发和单 scope 兜底转发之前，两种模式都注册；`stop()` 先让终端管理器拒绝新建，再在清理步骤里“结束全部终端” | 终端属于整个 serve，不能随 workspace app 分发；WebSocket 升级也在外层处理。新建带目录头时调用 `resolveWorkspaceScope`，无目录头时用 `os.homedir()`。GET 和 DELETE 忽略目录头 |
| `packages/ohbaby-server/package.json` | 加上表中的服务端依赖 | 发布包体积变大 |
| `packages/ohbaby-sdk/src/index.ts` | 导出终端契约 | 无 |
| `apps/ohbaby-web/package.json` | 加上表中的浏览器端依赖 | 首屏体积：Terminal 页按需加载 xterm |
| `apps/ohbaby-web/src/ui/side-panel/side-pages.ts` | 登记 `terminal`：状态 `{ terminalId: string }`；新建入口先取得真实 id，不伪造默认 id；菜单名与每个标签的标题分开，标签标题取自终端信息的 `title`，`sessionScoped: false` | 无 |
| `apps/ohbaby-web/src/ui/side-panel/SidePanelPage.tsx` | 加 `terminal` 分支；`SidePageContext` 增加终端客户端；删除第 27 行附近“只有一种页面”的 eslint 例外注释 | 无 |
| `apps/ohbaby-web/src/ui/side-panel/SidePanel.tsx`、`use-side-panel.ts` | 新建终端先请求成功再打开标签；补充按 id 去重且不展开、不切换的标签同步；显示每个终端自己的标题；终端的按钮及键盘关闭均等清理成功后移除 tab；删除 `use-side-panel.ts` 第 126、173 行附近“只有一种页面”的 eslint 例外注释 | 不能影响 Subagents tab 的直接关闭 |
| `apps/ohbaby-web/src/ui/shell/AppController.tsx` | 构造 `SidePageContext` 时传入终端客户端（约第 201 行） | 无 |
