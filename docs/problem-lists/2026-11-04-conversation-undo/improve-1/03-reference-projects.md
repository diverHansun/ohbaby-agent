# 3. 参考项目

> 2026-11-04 由子代理只读调研，主代理汇总。路径都在 `/Users/hansun025/Projects/code-cli/` 下，行号是调研时的快照。

## 3.1 调研范围

| 项目 | 看了什么 |
|---|---|
| kimi-code | 撤销服务、wire 分支、Web 的撤销入口、TUI `/undo` |
| codex | `thread/revert`、TUI 回溯（backtrack）、输入框回填 |
| ZCode | `editUserQuery`、`SessionRevert` |
| deepseek-harness（下称 dsh） | 删掉编辑按钮的决策记录 |
| opencode | revert 的 stage、clear、commit 流程 |
| claude-code | `/rewind` |

## 3.2 可借鉴点

| 项目 | 做法 | 本项目取舍 |
|---|---|---|
| kimi-code | `POST /sessions/{id}:undo {count}`（`kap-server/src/routes/sessions.ts:993-1023`）。会话忙时返回 `SESSION_BUSY`（`agent/undo/undoService.ts:186-191`）；在 wire 里追加 `agent.switched` 记录切到新分支，旧内容留在磁盘上（`wire/wireService.ts:213-260`）；压缩摘要是硬边界（`wire/tree/fork.ts:58-100`）；明说文件不回滚；Web 端撤销后把原文填回输入框，不自动发送 | **采用**：忙时拒绝、旧内容保留、压缩边界、文件不回滚、原文回填不自动发送。**改造**：按 `promptId` 定位，不按条数；存储是 SQLite 行，用 `undone_at` 列代替 wire 分支记录；忙碌判断照本项目手动压缩的现有做法，错误码复用现有的 `SESSION_RUNNING` |
| codex | `thread/revert {beforeTurnId}`（`app-server/src/request_processors/thread_processor.rs:2248-2460`）写一个新的不可变 rollout 文件指向保留的前缀，旧文件不动（`thread-store/src/local/revert_thread.rs:15-160`）。拒绝 steer 和进行中的轮次作为撤销点；输入框回填文本、图片和 mention，失败路径上也会把原文放回去；明说不回滚文件 | **采用**：按轮次 ID 定位、steer 不是撤销点、失败时不丢原文。**不采用**：撤销前先关掉线程（本项目改为忙时拒绝） |
| ZCode | 撤销时取消被撤销轮次里的后台任务（`cancelRemovedBranchBackgroundTasks`）；旧消息隐藏不删 | **采用**：停止被撤销轮次里的子代理 |
| dsh | 删掉了没有后端支撑的编辑按钮：没想清楚“已经进入模型上下文的消息被修改意味着什么”之前，不放这个按钮（`.agents/notes/archived/simplification/2026-07-31-drop-user-message-edit-stub.md`）；不可用的按钮置灰并说明，不隐藏 | **采用其原则**：先把撤销语义定清楚再上按钮；不可用时置灰加说明 |
| claude-code | `/rewind` 可选只回滚对话、只回滚代码或两者都回滚（`src/components/MessageSelector.tsx:54`） | 参考：以后接入文件回滚时，可以照这个思路做成单独的选项 |

## 3.3 明确不借鉴

- **按条数撤销**（kimi-code `{count}`）：用户在界面上点的是某一条消息，用条数表达会在并发提交时出错。
- **撤销时真删除**（opencode 的 commit 阶段会删掉 `seq >= boundary` 的消息，`core/src/session/projector.ts:798-829`）：和“保留废弃分支”的决定冲突，而且不可逆。
- **只能改最后一条**（ZCode，`fork-edit-retry.ts:68-76`）：用户要求能撤销到任意一轮。
- **通用的 undoable 状态框架**（kimi-code `.undoable()`，`state/state.ts:170-210`）：本项目和轮次挂钩、需要回退的状态只有 todo，而 todo 本来就是从历史重建的，不值得为它建一套框架。
- **可选的文件回滚**（ZCode、opencode、claude-code）：本轮不做文件回滚。

## 3.4 对 02 的影响

| 02 决策 | 来源 |
|---|---|
| 忙时拒绝 | kimi-code |
| 压缩点之前不能撤销 | kimi-code |
| steer 不是撤销点、按轮次 ID 定位 | codex |
| 停止被撤销轮次里的子代理 | ZCode |
| 原文回填、不自动发送、文件不回滚 | kimi-code、codex |
| 不可用时置灰加说明 | dsh |
