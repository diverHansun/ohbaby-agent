# Loop 模块 goals-duty.md

> 本文档是 `/loop` 产品模块的边界声明。后续 architecture / data-model / 接口 / 用例均不得超出本文 Duties；若冲突，先改本文再改实现计划。

---

## 一、Design Goals（设计目标）

### 1. 用「主会话注入」交付自动任务，而不是另起执行体

Loop 到点后，把带来源信封的 prompt 投递进**所属主会话**的执行通道，由该会话主 Agent 跑一轮。主 Agent 能看见结果、能接着聊。这与 kimi-code（`steer`）与 Claude Code（命令队列）一致，避免独立 loop Agent / 子会话带来的双写上下文与同步复杂度。

### 2. 全局 serve 是唯一闹钟 owner，前台 TUI 不承担调度

创建、持久化、到点计算、恢复只发生在 `ohbaby serve` 进程。TUI in-process 路径不暴露 `/loop`、不注册 Loop 工具，避免「无常驻进程却假装能 cron」以及多进程重复触发。

### 3. 「到点」与「能不能跑」分离，防止不合时宜的自动执行

Scheduler 只负责时间到期；投递门控根据 session 是否空闲、TUI 是否占用、同任务是否已在队列/运行，决定立即投递、合并等待或跳过。目标是：不错过承诺的节奏信息（用合并次数表达），也不在用户正忙或本地 TUI 占着 session 时硬插一轮。

### 4. 默认有界，防止遗忘任务无限烧钱

周期任务自创建（或续期）起默认约 7 天有效；到期前最后一次投递带 `stale=true`，然后删除任务。用户可再次创建/续期以重新获得窗口。

### 5. MVP 只做会话型周期任务，概念数保持最小

首版只支持绑定 `scopeKey + sessionId` 的周期 ScheduledJob；不做工作区型（无会话）Loop、不做 Reminder/FollowUp 产品面、不做 session 级「一键停全部自动投递」。

---

## 二、Duties（职责）

### 1. 管理会话级 Loop 任务的生命周期

负责：

- 创建（含创建后立刻安排第一次执行）
- 列表
- 暂停 / 恢复
- 删除
- 默认过期与 `stale` 最后一次投递后的清理
- 每 session 活跃任务上限（20）

### 2. 在 serve 内维护「到点 → 可投递」的投递门控

负责：

- 订阅或接收 Scheduler 的到期信号
- 判定 session 是否可投递：无 running/queued 主通道工作，且无存活 TUI claim
- 同任务已在队列或运行：跳过本次到期（不新增第二份并发执行）
- 因忙无法投递：同一任务最多保留 1 个 pending，累加 `coalescedCount`；空闲后投递一次
- 暂停中的任务：到期触发**丢弃**，不记 pending；恢复后等下一次自然到期
- 多任务同时到期：按到期时间 FIFO 串行入队

### 3. 将触发投递到主会话执行通道

负责：

- 构造带信封的 prompt（含 `jobId`、间隔/表达式信息、`coalescedCount`、`stale`）
- 经 `WorkspacePromptScheduler.accept`（或等价主通道入队 API）写入目标 session
- `triggerSource` 标记为 scheduler/loop，权限画像**跟随该 session 当前权限**
- 入队成功但后续 run 失败 / claim 冲突：任务保持 active，等下次到期再试（不因失败推进「已交付完结」语义）

### 4. 对外提供一致的管理面

负责：

- 用户入口：`/loop` slash（仅 Web/App 等走 daemon 的客户端）
- Agent 工具：`LoopCreate` / `LoopList` / `LoopDelete`（及暂停/恢复若暴露为工具或 REST）
- REST 资源式 API（任务 CRUD + pause/resume）
- 供侧栏投影的状态字段（下次到期、paused、pending 等待原因、合并次数、过期信息）

### 5. 与持久化及 serve 生命周期对齐

负责：

- 任务写入 SQLite（与 SchedulerStore / `scheduler_job` 同批）
- 创建时检测 serve 可用；不可用则拒绝创建并提示启动 serve
- serve 启动时恢复未完成日程与可投递的 pending（与 prompt 队列恢复同模式）

---

## 三、Non-Duties（非职责）

### 1. 不负责精确闹钟算法本身

最小堆、`setTimeout`、cron/interval → `nextFireTime` 计算属于 `runtime/scheduler`。Loop 消费「到期」结果，不在产品模块内重写堆实现。

### 2. 不创建独立 loop Agent / 子会话 / SubagentHost 执行体

不把每次触发建模为新的子 Agent 会话；不复用「共享子会话」的 SubagentHost 语义来跑 loop。

### 3. 不在 turn 中途打断用户

不实现「抢占当前 turn」；忙则等待或合并。不因 loop 打断 TUI 占用中的 session（A1）。

### 4. 不做工作区型（无 session）Loop（MVP）

没有目标主会话就无法按模型 A 投递；工作区默认会话等能力二期再议。

### 5. 不做 Reminder / FollowUp 产品面（MVP）

一次性提醒、agent 主动 sleeping 续跑不在本模块首版职责内（可与未来 scheduler job kind 扩展衔接，但不阻塞 Loop MVP）。

### 6. 不做 session 级「暂停全部自动投递」总开关（MVP）

仅单任务 pause/resume/delete。

### 7. 不在 in-process TUI 注册 Loop 工具或 `/loop` 命令

TUI 可以因占用 session 而成为 busy 信号来源，但不是 Loop 的管理端或调度端。

### 8. 不负责侧栏 UI 实现

只提供状态与事件投影所需字段；右侧面板 UI 另议题。

### 9. 不负责主会话内 LLM/工具执行细节

Run 创建、lifecycle、tool scheduler、compaction 仍由现有 runtime 负责。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/scheduler` | 依赖 | 到期信号、job 行持久化、nextFireTime |
| `WorkspacePromptScheduler` | 依赖 | 主通道入队与同 session FIFO |
| `run-ledger` / claim | 依赖 | TUI claim 与 busy 判定 |
| `InstanceStore` | 依赖 | 按 scopeKey 路由到 workspace |
| `ohbaby serve` | 被宿主 | 唯一调度与投递进程 |
| Agent 工具层 | 入口 | LoopCreate/List/Delete；仅主 Agent；Plan 模式禁写 |
| Web/App | 入口 | `/loop` + REST + 侧栏投影 |
| Goal driver | 相邻 | 同 session 有 goal 在跑 ⇒ 主通道忙 ⇒ loop 不投递 |

---

## 五、文档自检

- 一句话存在意义：为 daemon 侧会话登记周期任务，空闲时注入主会话执行，并默认 7 天有界。
- 明确不做：独立执行体、TUI 调度、工作区型 MVP、四态大 Heartbeat、session 总开关。
- 与 scheduler 边界清晰：scheduler 管「何时」；loop 管「是否投、投给谁、过期与产品入口」。
