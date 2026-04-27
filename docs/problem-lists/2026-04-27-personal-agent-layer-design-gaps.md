# 2026-04-27 Personal Agent Layer 设计缺口提醒

本文记录本轮对照 opencode、claude-code、deerflow harness、OpenHarness 后发现的潜在设计问题。它不是正式架构方案，只作为后续补全文档时的提醒清单。

## 一、总体问题

ohbaby-agent 当前文档更偏向 coding CLI：用户打开 CLI，提交请求，Lifecycle 执行一轮或多轮工具循环，然后返回结果。这个基础很适合借鉴 opencode / claude-code。

但如果 ohbaby 还要像 hermes-agent / openclaw 一样成为个人 agent 助手，就需要补一层 Personal Agent runtime：它能后台存活、被定时唤醒、主动跟进任务、通过多种通道收发消息，并且能把这些后台行为纳入同一套 session、permission、memory 和 event 体系。

## 二、分模块缺口

### 1. Runtime / Run Manager

当前 `core/lifecycle` 负责执行循环，但缺少一等的 `Run` 概念。建议后续补充 `runtime/run-manager` 文档，定义 `runId`、`sessionId`、状态、取消、恢复、并发冲突策略。

可借鉴：
- opencode 的 `session/run-state`
- deerflow 的 `runtime/runs/manager.py`
- OpenHarness 的 `engine/query_engine.py`

初步建议：Lifecycle 只管 agent loop，RunManager 负责“这个 loop 作为一次运行如何被创建、查询、中断和清理”。

### 2. Daemon / Supervisor

当前没有后台守护进程设计。Personal Agent 需要一个可选 daemon，用来托管长期任务、远程通道、scheduler 和 worker。

可借鉴：
- claude-code 的 `daemon`
- OpenHarness 的 cron scheduler daemon

初步建议：daemon 不直接承载业务逻辑，只负责进程状态、worker 管理、pid/state 文件、优雅退出、崩溃重启与日志。

### 3. Heartbeat / Proactive

目前缺少心跳、tick、主动唤醒状态机。若直接把“心跳”等同于“定时调用 LLM”，会造成成本失控和循环错误。

可借鉴：
- claude-code 的 `proactive`
- OpenHarness 的 `sleep_tool`
- deerflow 的 stream heartbeat sentinel

初步建议：设计 `active / paused / blocked / sleeping` 状态；heartbeat 只产生 wake signal，真正是否运行由 scheduler + policy + run-manager 判断。

### 4. Scheduler / Reminder / Cron

当前没有定时任务、提醒、follow-up 的统一模型。个人助手需要支持“明天提醒我”“每周检查仓库 issue”“30 分钟后继续”。

可借鉴：
- OpenHarness 的 `services/cron.py`、`cron_scheduler.py`
- OpenHarness 的 `cron_create` 系列工具

初步建议：新增 `scheduler` 模块，区分 `scheduled job`、`reminder`、`follow-up`、`sleep wakeup`。它只负责触发 run，不直接执行工具。

### 5. Background Tasks

当前子代理、工具调用、后台任务边界容易混在一起。Personal Agent 层需要独立的 task 概念：任务可以长时间运行、可查询输出、可停止、可由 channel 或 scheduler 创建。

可借鉴：
- claude-code 的 `tasks`
- OpenHarness 的 `tasks`

初步建议：`task` 不等于 `tool call`。Tool call 是一轮模型中的动作，Task 是 runtime 层可管理的后台工作单元。

### 6. Channels / Personal Inbox

当前文档没有 Slack、Telegram、Email、桌面通知、Web hook 等通道适配层。Personal Agent 如果只绑定 CLI，就无法成为常驻助手。

可借鉴：
- OpenHarness 的 `channels`

初步建议：新增 `channels` 模块，负责 inbound/outbound 消息标准化；channel 不直接调用 core，而是投递到 runtime 或 session backend。

### 7. Event Bridge / Server / SDK

当前 Bus 是进程内事件总线，适合模块解耦，但不够支撑独立 UI、远程客户端和断线恢复。

可借鉴：
- opencode 的 `server/event` SSE
- opencode TUI 的 SDK + Sync store
- deerflow 的 `stream_bridge`

初步建议：保留轻量 `bus`，另建 `event-bridge` 或 `server`，负责把 Bus 事件转换成 SSE/WebSocket/SDK 事件，并提供 heartbeat 与重连语义。

### 8. UI 解耦

当前 UI 文档仍有“UI 直接订阅 Bus / 调用 lifecycle”的倾向。后续多端 UI 会因此耦合后端实现。

可借鉴：
- opencode 的 TUI 通过 SDK 和 sync store 消费事件

初步建议：UI 只依赖 `runtime-client` 或 `sdk`，后端通过事件投影同步 session、message、part、permission、status。

### 9. Memory / Personalization

当前 memory 更偏 OHBABY.md 项目记忆。个人助手还需要个人长期记忆、偏好、关系、任务历史、跨项目上下文。

可借鉴：
- deerflow 的 memory middleware
- OpenHarness 的 personalization

初步建议：后续区分 `project memory`、`personal memory`、`session summary`、`task journal`，并明确哪些内容可被模型主动写入。

### 10. Middleware / Hooks / Harness

当前 Lifecycle 容易变成所有逻辑的汇聚点。deerflow 和 OpenHarness 都倾向通过 middleware/hooks 组合能力。

可借鉴：
- deerflow 的 middleware chain
- OpenHarness 的 hooks/plugins

初步建议：新增 `harness` 或 `runtime/middleware` 文档，把 memory、summarization、todo、title、guardrail、token usage、loop detection 做成可组合环节。

### 11. Observability / Audit

Personal Agent 后台运行后，用户需要知道它为什么醒来、做了什么、花了多少钱、是否失败。

可借鉴：
- opencode 的事件与日志
- claude-code 的 cost tracker / task logs
- OpenHarness 的 cron history / autopilot journal

初步建议：新增 `observability` 或放入 `runtime`，记录 run、tool、permission、token、cost、wake reason、error recovery。

### 12. Permission for Autonomous Runs

当前 permission 更适合交互式 CLI。后台任务无法随时弹窗询问用户，因此必须有更明确的授权边界。

可借鉴：
- claude-code background session 的 permission mode
- OpenHarness autopilot policy

初步建议：为后台 run 定义 permission profile，例如 `read-only`、`notify-only`、`full-auto-with-policy`、`requires-human-before-write`。

## 三、建议优先补的文档目录

下一轮可以先讨论是否新增这些目录：

```text
docs/runtime/
docs/daemon/
docs/scheduler/
docs/heartbeat/
docs/tasks/
docs/channels/
docs/server/
docs/sdk/
docs/harness/
docs/observability/
docs/personalization/
```

也可以采用更收敛的分组方式：

```text
docs/runtime/
docs/runtime/daemon/
docs/runtime/scheduler/
docs/runtime/heartbeat/
docs/runtime/tasks/
docs/interfaces/server/
docs/interfaces/sdk/
docs/interfaces/channels/
docs/harness/
docs/personalization/
docs/observability/
```

倾向建议使用第二种：Personal Agent 层大多是 runtime 与 external interface 能力，集中放置更容易看清边界。

## 四、后续讨论重点

1. `runtime` 是不是应该成为 core 之上的新一层，而不是放进 `core/lifecycle`。
2. `heartbeat`、`scheduler`、`daemon` 三者边界如何划分。
3. UI 是否改成通过 SDK/EventBridge 同步状态，而不是直接依赖 Bus。
4. 后台任务的权限策略是否要独立于交互式 CLI。
5. Personal memory 是否与 OHBABY.md 共用机制，还是单独设计。
