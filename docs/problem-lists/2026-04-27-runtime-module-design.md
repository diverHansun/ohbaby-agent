# 2026-04-27 Runtime 模块设计讨论记录

本文记录针对 ohbaby-agent `runtime` 模块的设计讨论，对照 opencode、claude-code、deerflow harness、OpenHarness、hermes-agent 后形成的洞察、未决问题与待写文档清单。

不是正式架构方案，只作为后续撰写 `docs/runtime/*/goals-duty.md` 之前的对齐底稿。

---

## 一、背景

ohbaby-agent 同时承担两种角色：

1. **Coding CLI**（对标 opencode / claude-code）：用户在终端发起请求，跑一轮 agent loop，返回结果
2. **个人 Agent 助手**（对标 hermes-agent / OpenHarness 的 personal use case）：长期存活、被定时唤醒、主动跟进任务、多通道收发消息

第 1 种诉求由 `core/lifecycle` 已经覆盖。第 2 种诉求需要在 lifecycle 之上新增一层 **runtime**。runtime 是"运行台/调度台"，lifecycle 是"agent loop 引擎"。runtime 调 lifecycle，lifecycle 不调 runtime。

---

## 二、核心概念辨析（Run / Task / Tool-call / Turn / Lifecycle.run / Session）

当前 lifecycle 文档把这些概念混在一起，导致后续讨论 daemon/scheduler/heartbeat 时容易绕。先把六层固定下来：

| 概念 | 是什么 | 生命周期 | 负责模块 | 持久化形态 |
|------|--------|----------|----------|------------|
| **Tool call** | turn 内的一次工具调用 | 秒级 | `core/tool-scheduler` | 作为 ToolPart 写入 message storage |
| **Turn** | 一次 LLM 调用 + 该次解析出的 tool 调用 | 秒到分钟 | `core/lifecycle/processor` | 作为多个 Part 写入 message storage |
| **Lifecycle.run** | 一个完整 agentic loop（多轮直到停止） | 分钟级 | `core/lifecycle` | 不持久化（执行体本身是函数调用） |
| **Run** | 对一次 Lifecycle.run 的"运行台账"，含 trigger / status / 权限画像 / cancel | 分钟级 | **`runtime/run-manager`** | RunRecord 内存维护 + 关键事件落到 session storage |
| **Task** | 后台长期 subprocess 或周期性工作（不是 agent loop） | 小时到天 | **`runtime/tasks`** | TaskRecord + 输出日志文件 |
| **Session** | 跨多个 Run 的对话线程 | 长期 | `services/session` | SQLite / JSON 文件 |

### 概念混淆的具体例子

- "agent 现在正在跑" 是 **Run** 状态，不是 Session 状态。Session 长期存在，Run 是 Session 上的一次激活
- "Subagent task" 是个误称。Subagent 应该是 **嵌套 Run**（有 `parentRunId`），不是 Task。Task 是 agent 之外还在运行的东西（比如后台 build、长时间 grep）
- Tool call 不是 Run。同一个 Run 可能产生几十个 Tool call

---

## 三、Bus vs StreamBridge 边界辨析

ohbaby 已有 `docs/bus`（进程内事件总线）。新增 runtime 后还需要 `runtime/stream-bridge`（对外事件流）。两者职责必须严格区分。

### 3.1 一句话区分

- **Bus**：**进程内**模块间总线，无 ID、无顺序、无重放、同步分发
- **StreamBridge**：**跨进程**对外事件流，有 ID、有顺序、可重放、异步缓冲

### 3.2 维度对照

| 维度 | Bus（已有） | StreamBridge（新增） |
|------|-------------|----------------------|
| 边界 | 进程内 | 跨进程边界 |
| 通信对象 | 模块 ↔ 模块 | runtime ↔ 外部客户端（UI / SDK / SSE / WS） |
| 事件定义 | 分布式：每个模块在自己代码里 `BusEvent.define()` | 集中：定义在 `ohbaby-sdk`，作为对外契约 |
| ID / 顺序 | 无 | 必须有单调递增 `eventId` |
| 重放 | 不支持 | 支持 `Last-Event-ID` 重连 |
| Payload 约束 | 任意 JS 对象 | 必须 JSON 可序列化（**即使内存版也强制**） |
| 缓冲 | 无 | 每个 runId 维持滚动 buffer |
| 心跳 | 不需要 | 有 `HEARTBEAT_SENTINEL` + `END_SENTINEL` |
| 谁能发布 | 任意模块 | **只有 runtime/run-worker**（其他模块不直接发） |

### 3.3 单向翻译关系

```
Lifecycle / Permission / Tool-Scheduler / Policy
        │ 发 Bus 事件（进程内）
        ▼
Run Worker（runtime/run-manager/worker.ts）
        │ 订阅 Bus + 翻译 + 包装 runId
        ▼
StreamBridge.publish(runId, eventName, payload)
        │
        ▼
SDK / SSE / TUI Consumer
```

**三条强制原则**：

1. **Bus 不知道 StreamBridge 存在**——lifecycle / permission / tool-scheduler 永远只发 Bus 事件，绝不直接调 StreamBridge
2. **Run Worker 是唯一的翻译层**——它知道"当前在跑哪个 run"，把进程内事件加上 `runId` 后发到外部
3. **不是所有 Bus 事件都对外**——`Memory.Event.Added` 内部用就好，不外发

### 3.4 翻译表样例

| Bus 事件（内部） | StreamBridge 事件（外部） | 是否外发 | 命名空间 |
|------------------|---------------------------|----------|----------|
| `Lifecycle.Event.StepStarted` | `run.step.started` | ✅ | `run.*` |
| `Lifecycle.Event.Aborted` | `run.aborted` | ✅ | `run.*` |
| `Permission.Event.Updated` | `run.permission.required` | ✅ | `run.*` |
| `Tool.Event.StateChange` | `run.tool.state-changed` | ✅ | `run.*` |
| `Memory.Event.Added` | — | ❌ | — |
| `Policy.Event.ModeChanged` | `app.policy.mode-changed` | ✅ | `app.*` |
| `Scheduler.Event.JobFired` | `app.scheduler.job-fired` | ✅ | `app.*` |

注意：**StreamBridge 需要支持两种命名空间**：
- `run.*`：按 runId 路由，订阅者必须指定 runId
- `app.*`：进程级，所有 client 默认订阅

---

## 四、Daemon / Heartbeat / Scheduler 边界

```
Daemon（进程级，不知道 agent 是什么）
  ├── 持有 pid 文件 / state 文件 / 文件锁
  ├── 启动 / 重启 / 优雅关闭 worker
  └── 内嵌：Scheduler tick + StreamBridge instance + RunManager instance

Scheduler（时间级）
  ├── 维护最小堆（next fire time），事件驱动唤醒（不轮询）
  ├── 检查 due jobs / reminders / follow-ups
  ├── 输出 wake signal → Heartbeat
  └── 不直接创建 Run

Heartbeat（agent 状态机）
  ├── 状态：active / paused / blocked / sleeping
  ├── 收到 wake signal 后判定"现在能不能跑"
  ├── 能跑 → 调 RunManager.create(...)
  └── 不能跑 → 记录 deferred，等条件满足
```

---

## 五、触发源 → 权限画像 → 多任务策略 联动

每个 Run 创建时必须明确 4 个属性：

```typescript
interface RunCreateOptions {
  trigger: 'user' | 'scheduler' | 'channel' | 'heartbeat' | 'follow-up'
  permissionProfile: 'interactive' | 'read-only' | 'notify-only' | 'full-auto'
  multitaskStrategy: 'reject' | 'queue' | 'interrupt-current'
  disconnectMode: 'cancel' | 'continue'
}
```

### 默认联动表（可被覆盖）

| 触发源 | 默认 permissionProfile | 默认 disconnectMode | 默认 multitaskStrategy |
|--------|------------------------|---------------------|------------------------|
| `user` (CLI) | `interactive` | `cancel` | `reject` |
| `scheduler` | `notify-only` | `continue` | `queue` |
| `channel` (telegram/slack) | `notify-only` | `continue` | `queue` |
| `heartbeat` (wake) | `read-only` | `continue` | `reject` |
| `follow-up` | `inherit-from-parent` | `continue` | `queue` |

### 这层联动的必要性

- 用户 Ctrl+C 关掉 CLI，scheduled 跑的 run 不应该被取消
- 后台 scheduled run 没有 UI 可弹窗，必须有预定义权限画像
- Telegram 入站触发的 run 不能写文件却没人确认，必须是 notify-only
- hermes 的"惊喜账单"教训（issue #6130）告诉我们：没有这层联动 = 财务事故

---

## 六、StreamBridge 设计原则

### 6.1 即使 MVP 内存版也要实现的能力

无论 MVP 多急，以下能力**必须从一开始就实现**，否则后期加 SSE 时调用方代码全要改：

- `subscribe(runId, lastEventId?)`：订阅时可指定从哪个 eventId 开始
- 单调递增 eventId（per runId 或 global，建议 per runId 简化）
- `HEARTBEAT_SENTINEL`：长时间无事件时发心跳
- `END_SENTINEL`：run 结束时发终止信号
- 滚动 buffer：每个 runId 保留最近 N 个事件（默认 N=200），过期事件不可重放
- 死信处理：runId 不存在时 subscribe 立即返回 END

### 6.2 序列化约束

- payload 必须是 plain JSON（无函数、无类实例、无 Date 对象——都用 number/string）
- 内存版也强制走 JSON.stringify/parse 一次（开发期校验序列化兼容性）
- 类型在 ohbaby-sdk 包里定义，runtime 和 ui 都从 sdk import

---

## 七、参考 opencode 持久化做法（决定 1 的依据）

opencode 的存储方案：
- **持久数据**：SQLite（Drizzle ORM）
  - `session` / `message` / `part` 三张表（part 独立存储，支持流式更新）
  - `todo` / `session_entry` 等辅助表
- **运行时状态**：进程内 `Map<SessionID, Runner>`
  - `Runner` 持有 scope/finalizer，进程退出时自动 cancel 所有运行中的 runner
  - 不持久化"哪个 session 在跑"——重启后状态重置

### 应用到 ohbaby 的方案 C（已确认）

- **RunRecord**：内存维护，崩溃丢失（可接受）
- **LoopEvent / message / part**：落到 session storage（已有机制）
- **崩溃恢复**：从 message storage 重建"哪些 session 上次有 in-flight run"，标记为 `interrupted` 状态

ohbaby 当前 storage 是 JSON 文件，将来可平滑过渡到 SQLite——两者都满足"part 独立可流式写"这个核心约束。

---

## 八、已对齐的 5 个设计决定

| # | 主题 | 决定 | 理由 |
|---|------|------|------|
| 1 | Run 持久化 | **方案 C**：RunRecord 内存 + 关键事件落到 session storage | 与 opencode 一致；崩溃恢复成本低 |
| 2 | StreamBridge 远程支持 | **方案 B**：接口抽象做对，先做内存版，后做 SSE 版 | 避免后期回头改调用方 |
| 3 | Run worker 并发模型 | **方案 A**：每个 run 独立 async task | Node.js 异步模型天然适合，由 multitaskStrategy 控制冲突 |
| 4 | Heartbeat tick 频率 | **方案 C**：事件驱动（最小堆 + setTimeout） | 空闲时 0 CPU，比 hermes 60s 轮询节能 |
| 5 | Daemon / Heartbeat / Scheduler 三者职责 | 进程级 / 状态机 / 时间触发 三层划分 | 边界清晰，每层只做一件事 |

---

## 九、还未对齐的设计决定（**重点讨论**）

### 9.1 Task：subprocess vs 同进程

**问题**：`runtime/tasks` 里的后台任务用什么实现？

- 选项 A：全同进程（async background task）
- 选项 B：长期任务用 subprocess，短期任务同进程
- 选项 C：可配置，task 类型自带 `isolation: 'subprocess' | 'in-process'`，默认同进程

**参考**：
- OpenHarness 用 subprocess（强隔离）
- deerflow 用同进程 asyncio.Task（轻量）
- claude-code 用同进程 + worker thread

**待你拍板**

### 9.2 Run 崩溃恢复语义

**问题**：进程崩溃后重启，runtime 应该如何处理上次留下的 in-flight run？

- 选项 A：全部标记 `abandoned`，不恢复
- 选项 B：试图从 message store 重建 RunRecord，标记 `interrupted`，由用户/scheduler 决定是否继续
- 选项 C：自动恢复（仅限 trigger=`scheduler`/`heartbeat` 的非交互 run）

我倾向 B：保留可见性，不自动续跑（避免崩溃原因还在导致再次崩溃）。

### 9.3 Subagent 是新 Run 还是共享父 Run

**问题**：当主 agent 调 `task` 工具触发 subagent 时，runtime 怎么对待？

- 选项 A：subagent 共享父 Run（同一 RunRecord，内部多套消息）
- 选项 B：subagent 是独立 Run（有自己 runId，RunRecord 含 `parentRunId`）

我强烈推荐 B：subagent 失败 / 取消不污染父 run；可以独立查询 subagent 状态；与 lifecycle 现有的 SubagentExecutor 设计兼容。

### 9.4 Channel 入站消息如何变成 Run

**问题**：Telegram / Slack 收到一条消息，如何创建 Run？谁创建 Session？

- 谁负责"判断这条消息属于哪个已有 session"（按 channel 用户 ID？按 channel ID？）
- 谁负责"如果是新对话则创建新 session"（ChannelAdapter？SessionManager？RunManager？）
- ChannelAdapter 应该做"消息标准化"，RunManager 应该做"创建 Run"——但中间的"找 session / 建 session"由谁负责？

候选边界：
- **ChannelAdapter**：标准化消息格式 → `IncomingChannelMessage`
- **ChannelDispatcher**（新组件）：根据 channel + sender 找/建 session，然后调 `RunManager.create({ trigger: 'channel', sessionId, ... })`
- **RunManager**：纯粹按 sessionId 创建 run

**待你拍板：要不要新增 ChannelDispatcher？还是合进 ChannelAdapter？**

### 9.5 Cost / token 汇总位置

**问题**：每个 Run / Task 的 cost、token 用量在哪里记录？

- 选项 A：直接放在 RunRecord 字段里（`tokenUsage`、`costUSD`）
- 选项 B：单独的 `runtime/cost-tracker` 子模块，由 RunRecord 引用 trackerId
- 选项 C：作为 LoopEvent 的一种，由 message storage 落盘后聚合查询

OpenHarness 用 A（CostTracker 直接在 QueryEngine 里）。我倾向 A：简单，查询便利。但 Task（subprocess 模式）的 cost 怎么传回主进程是个开放问题。

### 9.6 取消语义的层级

**问题**：当前 lifecycle 文档定义了：
- 单击 Ctrl+C：取消当前 LLM 调用
- 双击 Ctrl+C：取消所有 subagents

但 runtime 引入后语义层级要扩展：
- 取消单个 Run（不影响其他 Run、不影响 Task）
- 取消 Session 上所有 Run
- 取消整个 daemon 上所有 Run + Task（"全局停车"）

**待对齐**：UI 上 Ctrl+C 的几次按键分别对应哪个层级？

### 9.7 StreamBridge 是否区分 `run.*` 和 `app.*` 命名空间

**问题**：见 §3.4。policy 模式切换是全局事件（与具体 run 无关），是否应该和 run 事件用同一个 bridge？

- 选项 A：两个命名空间，同一个 bridge 实例
- 选项 B：两个独立 bridge 实例（`runBridge` + `appBridge`）

我倾向 A，简化客户端代码。

---

## 十、推荐 runtime/ 目录结构

对应 `packages/ohbaby-agent/src/runtime/`（与 `docs/runtime/` 镜像）：

```
runtime/
├── run-manager/             【新增目录】Run 一等概念
│   ├── manager.ts           # create / cancel / get / list / waitForCompletion
│   ├── record.ts            # RunRecord 类型
│   ├── status.ts            # RunStatus 枚举
│   ├── trigger.ts           # TriggerSource 枚举
│   ├── strategy.ts          # MultitaskStrategy 枚举
│   ├── disconnect.ts        # DisconnectMode 枚举
│   └── worker.ts            # Run worker（调 Lifecycle.run，桥接事件）
├── stream-bridge/           【新增目录】事件 producer/consumer 解耦
│   ├── bridge.ts            # StreamBridge 接口
│   ├── memory.ts            # InMemoryStreamBridge 实现
│   ├── event.ts             # StreamEvent 类型
│   └── sentinel.ts          # heartbeat / end 常量
├── daemon/                  【已存在空目录】进程供养
│   ├── supervisor.ts        # pid / state file / worker 管理
│   ├── lock.ts              # 跨平台文件锁
│   └── crash-recovery.ts    # 崩溃后状态重建
├── scheduler/               【已存在空目录】时间触发
│   ├── scheduler.ts         # 最小堆 + setTimeout 事件驱动
│   ├── job.ts               # 周期性 job（cron-like）
│   ├── reminder.ts          # 一次性提醒
│   └── follow-up.ts         # 延迟续跑
├── heartbeat/               【已存在空目录】Agent 状态机
│   ├── machine.ts           # active / paused / blocked / sleeping
│   ├── state.ts             # 状态类型
│   └── wake-decision.ts     # wake signal 判定
├── tasks/                   【已存在空目录】后台工作单元
│   ├── manager.ts           # TaskManager
│   ├── record.ts            # TaskRecord
│   ├── shell-task.ts        # bash subprocess
│   └── agent-task.ts        # 后台 lifecycle run（待 §9.1 决定）
├── permission-profiles/     【新增目录】触发源对应权限画像
│   ├── profile.ts           # PermissionProfile 接口
│   ├── interactive.ts       # 弹 UI 询问
│   ├── read-only.ts         # 只允许 readonly
│   ├── notify-only.ts       # 写操作改成发通知
│   └── full-auto.ts         # 按 policy 全自动
└── hooks/                   【新增目录】runtime 层 plugin hooks
    ├── executor.ts          # HookExecutor（参考 OpenHarness）
    ├── types.ts             # HookPoint 枚举（pre-run / post-run / pre-tool / post-tool / on-wake）
    └── README.md            # 与 docs/ui/hooks（React hooks）的命名区分说明
```

**新增 4 个目录**：`run-manager/` `stream-bridge/` `permission-profiles/` `hooks/`

---

## 十一、编译期 / lint 边界约束

```
runtime/  →  core/lifecycle               ✅ 允许
core/lifecycle  →  runtime                ❌ 禁止（编译期 + lint）
runtime/  →  ohbaby-sdk                   ✅ 允许（事件类型从 sdk 来）
runtime/  →  bus / memory / message / permission   ✅ 允许（只读消费）
interfaces/sdk  →  runtime/stream-bridge  ✅ 允许（订阅 bridge）
ohbaby-tui  →  runtime                    ❌ 禁止（UI 只看 SDK）
ohbaby-tui  →  ohbaby-agent 内任何模块     ❌ 禁止（除 sdk 外）
```

**强制手段**：
- TypeScript Project References：`ohbaby-tui` 的 tsconfig 不引用 `ohbaby-agent`
- ESLint `no-restricted-imports`：明确禁止跨包内部路径引用

---

## 十二、下一步

**等用户对 §9（7 个未决问题）给出答复后**，按以下顺序推进：

1. 创建 4 个新目录（`run-manager/` `stream-bridge/` `permission-profiles/` `hooks/`），**只放占位 README.md**
2. 为 7 个 runtime 子模块各写一篇 `goals-duty.md`（不写 architecture）
3. 写 1 篇 `docs/runtime/_overview.md`，包含：
   - 六层概念区分表
   - Bus vs StreamBridge 边界
   - 触发源联动表
   - runtime 与 core/lifecycle 的边界
4. 修订 `docs/bus/architecture.md` 末尾加一节"与 StreamBridge 的关系"
5. 修订 `docs/core/lifecycle/architecture.md` 末尾加一节"与 runtime 的边界"
6. 全部 `goals-duty.md` 对齐后，按 ohbaby 的 5 件套规范继续写 `data-model.md`、`architecture.md`、`dfd-interface.md`、`test.md`

**不写代码**。整个 runtime 模块设计阶段完成才考虑实现。
