# 讨论记录与已确认要点

> 2026-07-12 与用户讨论定稿。本文件只保存已确认结论；技术证据见 01，正式方案见 02–04。

## 1. 背景与动机

用户在真实 Web 使用中观察到两个相互关联的问题：

1. 多会话同时发送消息时存在明显延迟，看起来不像真正并行。
2. 点击或 Enter 发送后，用户消息不会立即进入对话，需要等较久才看到 prompt 或 agent 输出，造成“没有发送成功”的错觉。

讨论随后扩展到同 session 连续发送、workspace 并发上限、双击 Esc 后的队列推进、provider 错误归属，以及 Web/CLI 是否应各自维护排队状态。

## 2. 已确认：并发与排队

| 决策项 | 已确认结论 |
|--------|------------|
| 并发作用域 | 全局 serve 内按 canonical project root / `WorkspaceInstance` 独立计算 |
| workspace active 上限 | **10 个不同 session lane** |
| 同一 session | 同时最多一个 active run |
| 同 session 再次普通发送 | 接受并进入严格 FIFO；不 reject、不自动 interrupt、不 steer |
| 第 11 个 session | 接受并进入 `queued`；有槽位后按队列规则启动 |
| queued 安全上限 | 每 workspace 最多 **100 条 queued submission**，不含 starting/running |
| 第 101 条 queued | 接受前拒绝，返回结构化 `QUEUE_FULL`；不得写成 provider 错误 |
| provider 并发 | 不按 LLM 厂商额外限制 session 并发；provider 自己的 429/认证/容量错误原样规范化返回 |
| permission/question | 等待用户响应期间 run 仍占一个 active 槽 |
| provider retry/backoff | LLM client 内部重试期间 run 仍占一个 active 槽 |
| workspace 隔离 | A 的 10 个 active 不阻塞 B 的 10 个 active |

这里的 “10” 是本地产品保护与公平性边界，不是假装知道 provider 的真实容量。用户确认通过较大的默认上限，让正常使用几乎感受不到限流；provider 若不支持该并发，应返回自身错误，而不是由 ohbaby 猜测并吞掉。

用户再次确认：permission/question 等待占槽是预期行为。因为 workspace 同时最多只有 10 个 active session lane，所以最多累积 10 个占槽 permission；不得另建“不计槽 permission”旁路，否则会绕过资源上限并让恢复/取消语义分叉。

## 3. 已确认：服务端是唯一队列真相

- Web/remote CLI 只提交 prompt，不在本地决定其队列位置和启动时机。
- 服务端接受成功后返回稳定 receipt：`promptId`、`userMessageId`、`sessionId`、`status`。
- snapshot 与事件流包含 prompt submission 状态；刷新、重连、切 session 后从服务端重建。
- Web 可使用 receipt 立即渲染，但必须用服务端 ID 幂等合并 SSE，不能生成另一套 optimistic ID。
- CLI 当前本地 `Queued` 计数只能作为过渡实现，不能继续充当排队事实。
- “服务端”指接受该 client 提交的 backend runtime。默认 TUI 仍是 in-process backend，不因此改成 attach serve；全局 daemon 下的 Web/remote clients 共享同一个 workspace queue。

## 4. 已确认：持久化与重启恢复

| 场景 | 行为 |
|------|------|
| queued 时 daemon 正常运行 | 断开浏览器不删除，继续排队 |
| queued 时 daemon 重启 | 从 SQLite 恢复并继续 drain |
| starting/running 时 daemon 重启 | 死 owner/旧无 owner 标记 `interrupted`，不自动重放；存活 TUI/隔离 runtime 不误恢复 |
| 恢复 scope 不可用 | 该 submission 明确失败为 `WORKSPACE_UNAVAILABLE`，不静默改用 cwd/其他 workspace |
| 重启后没有原 client | prompt 仍可执行；若后续需要 permission，按现有 session 可见性等待已连接 client 接管，不伪造旧 client owner |
| 重复恢复/重复事件 | 以 `promptId` 幂等，不创建第二条 user message 或第二个 run |

不自动重放 starting/running 是有意的保守选择：模型或工具可能已经产生外部副作用，重放会比一次显式 interrupted 更危险。

持久化口径也固定如下：`queued/starting/running/terminal` submission 都落在与 workspace 会话数据相同的 SQLite；100 条安全上限只统计 `queued`，不统计 active 或 terminal。为保留失败详情、幂等依据和重启后的 UI 可解释性，本批不引入 TTL/后台 GC；后续若数据库体积成为真实问题，再以独立 retention/compaction 议题处理，不能让客户端自行删除服务端队列记录。prompt 正文与现有 message 处于同一数据保护边界，不写入用户级 daemon state 文件。

## 5. 已确认：用户消息与 queued 展示

- HTTP/JSON-RPC 一旦接受，就应立即有可展示的 user prompt，不等待 provider、sandbox、run claim 或 assistant 首 token。
- Web 在 composer 上方显示 Queue 区，按同 session FIFO 排列；**只有 `status=queued` 的 prompt 留在该区域**。
- Queue 卡片只需要文本和轻量 `queued` 状态，不向用户暴露 `starting/running/succeeded/interrupted` 等内部状态字段。
- queued submission 不是正式 conversation message。只有被 claim 并开始执行时，才以预分配的同一个 `userMessageId` 提升为正式 user message。
- 这样可以保证 prompt B 排在 prompt A 后面时，A 的模型上下文不会提前读到 B。
- prompt 不再 queued 后离开 Queue 区并进入 conversation 投影；正式 message 到达时使用同一 ID 合并，不闪现两条重复用户消息。
- queued 时通过 trash 取消的 prompt 直接从 Queue 区消失，不进入 conversation；已开始后失败或被中断，只在对应 conversation message 下显示一条简短错误/中断结果，不建立失败队列或中断队列。

## 6. 已确认：取消与续排

同一 session 的期望时序：

```text
A running → B queued → C queued
       双击 Esc
A cancelling → A cancelled（ledger/claim/stream 真正收口）
             → B starting → B running → C ...
```

- 双击 Esc 只取消当前 active run，不清空 B/C。
- scheduler 不能在 abort HTTP/RPC 回执到达时就抢跑 B。
- 必须等 A 的 RunLedger 终态、active claim 释放、stream projection 收口后再启动 B。
- 如果旧执行体不响应 abort，B 保持 queued；不能为了“看起来快”而制造同 session 副作用重叠。
- “清空队列”若未来需要，必须是单独显式操作，不复用双击 Esc。

## 7. 已确认：queued 编辑与取消

- queued message 允许编辑和取消；这两个动作的服务端能力进入本批后端，Web 交互留到下一批。
- 编辑只允许 `status=queued`，修改 text 但保持 `createdAt` 和 FIFO 位置不变。
- 取消只允许 `status=queued`，状态写为 terminal `cancelled`；用户界面可以把动作呈现为垃圾桶“删除”，但服务端不物理删记录。
- edit/cancel 与 scheduler claim 竞争时使用条件更新：若已经 `starting/running`，返回结构化冲突，不修改正在执行的 prompt。
- Phase E Web：待发送消息框附着在 composer 上方，比 composer 更窄、更小；每条提供小 pencil icon 与小 trash icon。pencil 在卡片内 inline edit，不占用或覆盖主 composer 草稿。
- Queue 区固定为最多约两条卡片的可见高度；更多 queued 通过鼠标滚轮、触控板或可拖动的细纵向滚动条手动浏览。滚动条默认弱化，在 hover/scroll 时增强；标题显示 `Queued N`，底部可有轻微渐隐提示，但不得自动轮播或自动改变用户位置。
- Phase E Web 运行中仍保留输入与 Send，同 session 新消息进入 FIFO；Stop 与 Send 是两个独立动作。
- UI 不显示不稳定的全局“队列第 #N 位”；本批只保证轻量 `queued` 状态和同 session 顺序，避免其他 session 启停造成编号跳动。

### 7.1 已确认：TUI Queue 交互

- TUI 主输入区只显示服务端/当前 backend 投影得到的简短 `queued N · /queue to manage`，不再根据本地未完成 Promise 猜测数量。
- `/queue` 打开独立管理面板；使用方向键选择，`e` 编辑，`d` 取消，Esc 返回 composer。
- TUI 不照搬 Web 的 pencil/trash 图形控件；Web 与 TUI 共享 receipt/event/snapshot 与 edit/cancel 契约，但各自保留符合载体习惯的交互。
- Shift+Tab、Tab、双击 Esc、Ctrl+C 等既有快捷键语义保持不变，不为 Queue 管理新增冲突快捷键。

## 8. 已确认：错误返回

- 沿用 LLM client 已有 provider status、retryability、retry reason、retry exhausted、stream interrupted 识别，不在 Web/CLI 重复解析厂商错误。
- core 应把错误规范化为可序列化结构；传输层保留 `code`、`message`、`source`、`retryable`、`providerId?`、`statusCode?`、`attempts?`、`terminalReason?`。
- 已接受 prompt 的失败必须带 `promptId + sessionId + runId?`，不能只发全局 `{message}`。
- Web 把错误放到对应 prompt/session；CLI 使用同一规范化文案。
- provider 429、认证失败、网络错误、重试耗尽只终结对应 run，并释放 workspace 槽；不得清空其他 session 队列。
- 发送给前端的错误必须清理 API key、authorization header、原始敏感响应体。

## 9. 明确不在本批

- `/loop`、cron、Scheduler、Heartbeat。
- prompt steer/合流。
- 自动重放 interrupted run。
- provider-specific 并发配置。
- 改变默认 TUI in-process 决策。
- 让默认 TUI 与 serve 共享严格 FIFO；跨 runtime 同 session 继续由 DB claim 防双写。
- 全局 daemon 之外的系统级 worker pool、分布式队列或消息中间件。
- 自动滚动/轮播 Queue、全局队列位次、失败/中断历史队列、批量清空队列、queued 之外状态的编辑/取消。
- OpenCode 三栏导航重做、顶部搜索、Review、设置；Phase E 只改 conversation/composer 与 TUI Queue 交互。

## 10. 参考项目确认

- 借鉴 Codex：每 thread 一个 active turn，不同 thread 独立并行；控制状态按 thread 保存。
- 借鉴 Kimi Code：每 session `_active/_queued`、提交 receipt、`prompt.submitted` 与 `userMessageId` 投影。
- 不照搬 Kimi 的纯内存队列；ohbaby 已明确要求 queued 持久化。
- 借鉴 ohbaby 自身 subagent durable queue 的原子 claim/finish 思路，但不复用 JSON queue 字段或混用表。
