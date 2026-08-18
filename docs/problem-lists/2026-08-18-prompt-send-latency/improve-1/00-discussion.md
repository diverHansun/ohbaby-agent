# 讨论记录与已确认要点

> 2026-08-18 与用户讨论定稿。正式方案见 01–04。本文只保留当前有效结论，不保留已否决的“execute 开头正式落消息”方案。

---

## 1. 背景与动机

使用 `ohbaby serve` 在浏览器发送首条 prompt 时，输入框清空后页面数秒没有明显变化，随后用户气泡与 Thinking / spinner card 一起出现。用户会怀疑消息是否成功发送。

目标不是缩短 MCP/runtime 的真实热身时间，而是消除这段没有确认感的感知空窗：用户按下 Enter 后，页面必须立即表达“你的话已提交，系统正在接管”。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 总体模型 | **三阶段展示接管链**：本地 optimistic → 服务端 `prompt starting` projection → 正式 `UiMessage` |
| 是否建立状态机 | **不建立。** 三阶段是纯展示优先级，不新增 reducer、通用 optimistic framework 或协议状态 |
| OpenCode 借鉴 | 采用“立即 commit 输入 + optimistic overlay + 稳定 ID 对账 + 失败回滚”的因果；不复制其完整前端架构 |
| Web 首帧 | Enter 同一帧清空输入、切主对话布局、显示用户文本、本地 Thinking；HTTP admission spinner 同时开始 |
| 正式消息时机 | **不提前到 execute 开头。** 仍在 `runtime.startSession` 成功、最终 run ownership 已建立后，由现有路径发布正式 `message.appended` |
| 服务端启动投影 | 复用已有 `UiPromptSubmission(status="starting")`；不新增事件类型 |
| ID | receipt 前临时 key=`pending:${clientRequestId}`；receipt 后、starting projection、正式 UI/core message 统一使用服务端 `userMessageId` |
| admission 分界 | `submitPromptAccepted` 返回 receipt 即表示已受理：停止 Send spinner 并保留 attempt；后续 `selectSession` 是独立导航，失败不得回滚 prompt 或恢复旧草稿 |
| busy 回退 | `starting → queued` 时 provisional 对话行和启动 Thinking 退出，现有 Queue 接管；不做正式消息补偿删除 |
| Thinking | 独立寿命：local admission → server starting → run running 连续接管；不得因用户气泡对账完成而提前消失 |
| Receipt | 不改形状，继续返回 `promptId / clientRequestId / userMessageId / sessionId / status / createdAt` |
| queued | 不是正式 conversation message，不进入模型上下文；running 时再发只显示在 Queue |
| HTTP 未受理 | 移除 optimistic；仅当 Composer 仍空时恢复本次草稿，不覆盖用户后来输入 |
| 已受理但启动失败 | 若正式消息尚未产生，以 terminal submission projection 保留用户文本并显示内联错误 |
| 发送按钮 spinner | 只覆盖 HTTP admission；202 或失败后停止；约 1 秒一圈并支持 reduced-motion |
| Stop | 仍只在真实 live/running run 可用；startup Thinking 不伪造 Stop 能力 |
| TUI | 本批不增加 optimistic / starting projection；只做回归。若需要同等即时体验，另批评估 |
| 落点 | `docs/problem-lists/2026-08-18-prompt-send-latency/improve-1/` |

## 3. 已确认：边界（不做的事）

| 项 | 本批不做 / 后续 |
|----|-----------------|
| execute 开头正式写/发用户消息 | 不做。scheduler `starting` 不是最终跨进程 run-ledger claim；提前 adapter 正式投影会制造 busy 补偿、跨客户端闪烁和事实语义歧义。core 自身的 claim 前短暂写入是另一个存量风险 |
| 拆 `RunManager` claim/start | 不做。为感知延迟改核心生命周期不符合 KISS/YAGNI |
| Receipt 带完整 `UiMessage` | 不做；receipt 是 admission，不成为第二消息源 |
| queued 进对话流 | 不做；继续由 Queue 展示 |
| 新事件 / 新状态机 / 通用 optimistic 层 | 不做；复用现有 prompt 与 message 投影 |
| TUI optimistic 气泡 | 本批不做 |
| POST 等待 `startSession` | 不做 |
| serve 预热 MCP/runtime | improve-2 |
| 全屏 loading、骨架屏、按钮转到 Thinking 结束 | 不做 |

## 4. 已确认：与关联议题的关系

- [`../../2026-07-12-workspace-prompt-concurrency/`](../../2026-07-12-workspace-prompt-concurrency/) 仍是排队权威。本批保留“queued 不是正式 conversation message”和预分配 `userMessageId`，但补充实现事实：scheduler `claim → starting` 之后，`RunManager.create()` 才通过 DB run ledger 获得最终 session ownership。因此 `starting` 可以驱动 provisional UI，不能单独证明可安全持久化正式用户消息。
- 该并发文档禁止客户端另造一套**实体**消息 ID。本批的 `pending:${clientRequestId}` 只是 receipt 前的短期 React 展示 key；receipt 到达后立即以服务端 `userMessageId` 接管，不成为服务端实体。
- [`../../../ohbaby-web/goals-duty.md`](../../../ohbaby-web/goals-duty.md) G1“UI 不是事实源”继续成立：正式 `UiMessage` 优先于 starting projection，starting projection 优先于 local optimistic；低权威层只填补上层尚未到达的空窗。

## 5. 参考项目

详见 [03-reference-projects.md](./03-reference-projects.md)。结论摘要：

| 来源 | 本批采取 |
|------|----------|
| OpenCode `packages/app` | 主参考：立即 clear + busy + optimistic、稳定 ID 合并、失败删除与安全恢复 |
| Kimi Code VS Code Webview | 借鉴 `pendingInput` / queue 分离；不接受其 user bubble 等到 `TurnBegin` 的空窗 |
| DeepSeek Harness | 借鉴立即 commitSend，以及“草稿仍空才恢复”的失败纪律 |
| ohbaby 当前模型 | 保留服务端分配 ID、prompt Queue、现有 SSE/receipt 形状 |

## 6. 用户确认记录

- 2026-08-18：确认 Web 乐观更新、queued 不进对话流、HTTP spinner 与 Thinking 分工、两种失败体验。
- 2026-08-18：进一步确认“三阶段投影 + ID 统一 + busy 回退 + Thinking 独立寿命”。
- 2026-08-18：在参考 OpenCode、Kimi Code、DeepSeek 后，确认采用精简版：三阶段仅作为展示接管链；删除 execute 开头正式落消息及核心生命周期拆分。
- 2026-08-18：确认先优化和对齐本目录文档，随后由独立子代理审查；实施另开会话。
