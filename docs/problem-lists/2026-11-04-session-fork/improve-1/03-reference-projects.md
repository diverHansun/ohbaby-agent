# 3. 参考项目

> 2026-11-04 由子代理只读调研，主代理汇总。路径都在 `/Users/hansun025/Projects/code-cli/` 下，行号是调研时的快照。

## 3.1 调研范围

| 项目 | 看了什么 |
|---|---|
| deepseek-harness（下称 dsh） | fork 的入口、切点、种子构建、标题、来源关系 |
| ZCode | `forkAssistant`、原子复制与 ID 映射 |
| opencode | `session.fork`、`fork_session_id` 与 `parent_id` 的分工 |
| codex | `thread/fork` 的切点参数、血缘字段、不继承的内容 |
| kimi-code | `:fork` 的目录复制与按轮切分 |

## 3.2 可借鉴点

| 项目 | 做法 | 本项目取舍 |
|---|---|---|
| dsh | fork 按钮只出现在已结束轮次的回答末尾；会话行菜单从最近一轮已结束的对话 fork（`ui-chat/src/client/apply.ts:301-310`、`ui-workspace/src/client/navigation.ts:324`）。fork 就是“切下日志前缀”（`core/session/src/fork.ts:21`）。不论源会话是否在运行都能 fork | **采用**：两处入口、只在已结束的轮次末尾切、不要求源会话空闲。用户确认“fork 学习 dsh” |
| dsh | 标题 `Foo` → `Foo (1)`、`Foo (2)`，由前端在创建后再发一次改名请求（`session-controller/src/client/sessions/service.ts:138`） | **改造**：同样的标题规则，改在服务端一次算好 |
| dsh | fork 不记录来源会话，因为 `parentSession` 让 fork 看起来像子代理（`.agents/notes/implemented/architecture/2026-10-23-independent-session-forks.md`）；fork 在列表里和普通会话平级 | **部分采用**：平级显示、不用 `parent_id`。来源信息按用户确认记在 `session.data` 里，侧栏用它做嵌套显示 |
| dsh | 未闭合的工具调用补“forked”结果（`fork.ts:21`） | **不需要**：本项目只在已结束的轮次末尾切，不会有未闭合的调用 |
| ZCode | 一个 SQLite 事务完成复制，先建好 ID 映射表，再改写所有会话内引用，改写不了就让 fork 失败（`core/runtime/methods/session-fork.ts:140-260, 600-815`） | **采用**：一个事务、全部换新 ID。**改造**：映射表只用于“按值替换”，不逐个字段改写 |
| opencode | `fork_session_id` 和 `fork_boundary` 记来源，`parent_id` 留给子代理（`core/src/session/sql.ts:38-39`）；只复制已完成的消息，花费和 token 从零开始 | **采用**：来源与 `parent_id` 分开 |
| codex | `lastTurnId` 含这一轮（`app-server-protocol/src/protocol/v2/thread.rs:544-583`）；goal 不继承（`thread_processor.rs:5788-5814`） | **采用**：切点含整轮；goal 不继承 |
| kimi-code | 复制整个会话目录再按轮切 wire；子代理按时间切，空了就丢（`sessionLifecycleService.ts:606-829`、`forkTurnSlice.ts:133-184`） | **不采用**：本项目不复制子代理 |

## 3.3 明确不借鉴

- **引用父会话的前缀而不复制**（codex 的 `history_base`）：本项目的读取方都直接查本会话的行，改成拼接父前缀要动所有读取方。
- **复制子代理**（kimi-code）：子代理有自己的会话、实例、执行和投递状态，复制它们的复杂度远超 fork 本身的价值。
- **前端二次改名**（dsh）：多一次请求，还会出现“先显示旧标题再变”的闪动。

## 3.4 对 02 的影响

| 02 决策 | 来源 |
|---|---|
| 两处入口、只在已结束轮次末尾切、源会话不要求空闲 | dsh |
| 标题 `(n)` | dsh |
| 一个事务、全部换新 ID | ZCode |
| 来源与 `parent_id` 分开 | opencode、dsh |
| 切点含整轮、不继承 goal | codex |
| 共用复制函数、按 run 切 | ZCode、codex（2026-11-08 补充） |
| 缓存身份用新会话自己的、已加载 MCP 工具随复制的历史带过去（2026-11-10 起由[从历史重建议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)保证）、不带“总是允许” | codex、kimi-code、ZCode、dsh（2026-11-08 补充） |
| 侧栏平级 | 6 个开源项目都平级（2026-11-09 补充；讨论过 Claude app 的嵌套，最终不做） |

## 3.5 2026-11-08 至 11-09 补充调研

逐条讨论时，每个问题先对比各项目，结论记在 00 §6。

| 问题 | codex | dsh | ZCode | kimi-code | opencode | claude-code |
|---|---|---|---|---|---|---|
| 哪些轮次能 fork | 任何不在进行中的轮次，只有 `/fork` | 任何已结束的轮次，按钮在复制按钮旁边 | 只有用户开启、成功结束的轮次，按钮在复制旁边 | 用户 prompt 开启的轮次，VS Code 版按钮在复制旁边 | 用户消息的菜单 | 只有 `/branch` |
| 和 side chat 共用复制代码 | 共用：`/side` 是临时 fork（`tui/src/app/side.rs:3、668`） | 没做 side chat，提案打算复用 | 共用 `commitAtomicConversationFork`（`session-fork.ts:588-812`） | 不共用：btw 是会话里的子代理 | btw 只调一次模型 | `/btw` 不存盘 |
| fork 的缓存键 | 新键；只有临时 fork 沿用父会话（`session.rs:978-992`） | 新键 | 新会话 ID | 新键（`profileService.ts:539`） | 沿用来源会话（`affinity.ts:6-7`） | — |
| 已加载的按需工具 | 存在历史里，复制历史就带过去 | 工具增减记在事件日志里 | 存在历史里（`tool/search/history.ts`） | 从历史重新算（`dynamicTools.ts:107-134`） | 没有按需加载 | — |
| “总是允许” | 从空开始（`session.rs:1843`） | 没有“总是允许” | 带权限档位 | 记在日志里，随日志带过去（推断） | 按项目存，自动生效 | — |
| 会话列表里的 fork | 平级，`forked_from_id` | 平级，不记来源 | 平级，曾借用 `parentID` 后改为按类型过滤 | 平级，`forkedFrom` | 平级，`fork_session_id` | 平级，`forkedFrom` |
| 标题 | — | `原标题 (n)` | `Fork of 原标题` | `Fork: 原标题` | `原标题 (fork #N)` | `原标题 (Branch N)` |
