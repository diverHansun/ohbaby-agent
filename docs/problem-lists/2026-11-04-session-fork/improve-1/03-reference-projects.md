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
| dsh | fork 不记录来源会话，因为 `parentSession` 让 fork 看起来像子代理（`.agents/notes/implemented/architecture/2026-10-23-independent-session-forks.md`）；fork 在列表里和普通会话平级 | **部分采用**：平级显示、不用 `parent_id`。来源信息按用户确认记在 `session.data` 里，但不用于导航 |
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
