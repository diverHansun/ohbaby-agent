# Workspace Prompt 并发与持久队列改造

> 状态：**后端批次已实施并通过独立复审；Web/TUI Phase E 产品决策已确认，规划文档已更新待审查，代码实施未开始。**
>
> 发布目标：与后续 `/loop` 一起进入 `v0.1.8`；当前后端能力可独立验收。
>
> 时间口径：2026-07-12，基线 `main@63f1810383a454ad73c740d1de57ad53db3c7437`。

本目录记录全局单 daemon 完成后，Web/remote client 的 prompt 提交、同 session FIFO、跨 session 并发、持久排队、即时用户消息投影、取消续排和 LLM 错误透传改造。

## 1. 为什么单独立项

现有代码已经具备：

- 全局单 daemon + per-workspace `InstanceStore`；
- daemon 外层按 session lane 排队；
- `run_ledger` 对同 session active run 的原子 claim；
- Web HTTP `202` 接受 prompt；
- LLM provider retry、stream interruption 与 message error 类型。

但这些能力没有形成同一条端到端契约：daemon 外层认为不同 session 可并行，backend 内层却仍以全局 `promptInFlight` 串行；Web 收到 `202` 后拿不到 `promptId/userMessageId/queued`；队列只在内存里；provider 错误跨越 lifecycle、RunLedger、SDK 和 SSE 后退化为无归属的字符串。

本议题独立于已完成的单-daemon与 Web 导航改造，也不提前实现 `/loop`。它解决的是用户主动 prompt 的运行时通道。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结已经确认的产品行为、数值、边界和恢复语义 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 当前双队列、全局门闩、消息延迟、错误降级和测试缺口的证据链 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 后续实施会话的架构、状态机、协议、迁移、文件改动面与分阶段 DoD |
| [03-reference-projects.md](./03-reference-projects.md) | Codex、Kimi Code 与 ohbaby durable subagent queue 的 adopt/adapt/reject |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、集成、真实进程、Playwright 与发布门 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施时以 `02 + 04` 为准；若与 `00` 冲突，必须先修文档，不能在代码里自行解释。

## 3. In scope

- 全局 serve 的每个 `WorkspaceInstance` 最多同时运行 **10 个不同 session lane**。
- 同一 session 最多一个 active run，后续普通 prompt 严格 FIFO。
- 第 11 个可运行 session 及同 session 后续 prompt 被接受并显示 `queued`，不以并发错误拒绝。
- 每 workspace 最多保留 **100 条 queued prompt**；第 101 条在接受前以结构化 `QUEUE_FULL` 拒绝。
- 服务端/后端 runtime 是排队顺序、状态和错误的唯一真相源；React/Ink 不自行推导队列。
- durable `PromptSubmission`：queued 跨 daemon 重启恢复；旧 starting/running 标记 interrupted，不自动重放。
- HTTP `POST /v1/prompts` 与 JSON-RPC `submitPromptAccepted` 返回 `promptId + userMessageId + sessionId + status` receipt；旧 `submitPrompt` 保持 submit-and-wait，避免默认 TUI/非交互 CLI 提前结束。
- 只有真正处于 `queued` 的 prompt 显示在 Web composer 上方 Queue 区；其余已接受状态进入 conversation 投影，刷新/重连从 snapshot 恢复，不依赖本地 optimistic 临时 ID。
- queued submission 与正式 conversation message 分离，避免未来 prompt 提前进入当前 run 上下文。
- 双击 Esc 只取消当前 run；当前 run 真正终态收口后，队首自动继续。
- 结构化 LLM/provider 错误从 core 透传到 prompt/run 事件，Web、remote CLI 和默认 CLI 使用一致的人类可读错误。
- 移除或降级重复的 daemon/backend 队列所有权，形成单一调度入口。
- 本批后端提供 queued prompt 的条件编辑与取消能力；编辑保持原队列位置，取消写 terminal `cancelled` 而不是物理删除。
- Phase E Web 在 composer 上方显示最多两条可见高度的 Queue 区，超出后由用户手动垂直滚动；queued 卡片支持 pencil inline edit 与 trash cancel。
- Phase E TUI 以服务端 snapshot/event 替换本地 Promise 计数，并提供 `/queue` 管理面板；默认 TUI 仍保持 in-process。

## 4. Out of scope

- `/loop`、Scheduler、Heartbeat、`scheduler_job` migration。
- prompt steer/合流到正在运行的 turn。
- provider 专属并发配置、按厂商限流或自动降低 workspace 并发。
- 自动重放已经 starting/running 的 prompt。
- “取消整个 session 队列”；双击 Esc 仍只取消当前 run。
- 改变全局单 daemon、workspace header、项目 registry 或 OpenCode 三栏导航。
- 将默认 TUI 改成 attach serve。
- 跨独立 runtime（默认 TUI + serve）共享严格 FIFO。该边界继续由 `run_ledger` claim 防止同 session 双写；本批 10 槽首先属于单个 serve `WorkspaceInstance`。
- 自动轮播 Queue、队列位置编号、失败/中断历史队列、批量清空队列或 queued 之外状态的编辑/取消。
- 大型截图基线平台、顶部搜索、Review、设置等 Web 产品功能。

## 5. 与既有文档关系

| 文档 | 关系 |
|------|------|
| [`../2026-07-11-global-single-daemon/`](../2026-07-11-global-single-daemon/README.md) | 前置条件；其单 daemon、per-scope runtime、TUI in-process、双写 claim 继续有效 |
| [`../terminal-daemon/`](../terminal-daemon/README.md) | 历史 FIFO 意图来源；本目录取代其中“内存全局队列已足够”的实现假设 |
| [`../2026-07-11-opencode-style-web-navigation/`](../2026-07-11-opencode-style-web-navigation/README.md) | Web shell 前置；本目录只扩展 conversation/composer 的 prompt 状态 |
| [`../../agents/2026-07-09-subagent-context/`](../../agents/2026-07-09-subagent-context/README.md) | 内部 durable queue/atomic claim 参考，不与用户 prompt 共用表或状态机 |
| [`../../services/database/`](../../services/database/goals-duty.md) | migration、WAL、事务与 busy retry 约束来源 |

## 6. 实施与审查闸门

1. [x] 用户审查并确认本目录 00–04。
2. [x] 独立临时分支按 02 实施后端，不修改 Web UI。
3. [x] 后端批次按 04 完成 unit/contract/integration 与真实 daemon process E2E，并由子代理独立审查。
4. [ ] Phase E 完成共同 prompt 投影、Web Queue UI、TUI `/queue`、`canSend`、edit/delete 接线与 Playwright。
5. [x] 独立复审对照 02/04 检查实现与文档一致性，阻塞 findings 已全部关闭。
6. [ ] 前后端两批完成后再进入 `/loop` 的设计；不得顺手恢复 scheduler schema。
