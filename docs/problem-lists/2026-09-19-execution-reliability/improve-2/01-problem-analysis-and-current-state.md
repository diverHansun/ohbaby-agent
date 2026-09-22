# 01 现状与问题

> 基线 `039dca95`，2026-09-20 只读调查。第一轮仍是规划，不能把其待建 pending registry、真实身份，以及 improve-1.1 的整页投影屏障当作当前能力。本轮未运行产品测试；历史诊断见[已有证据](../evidence/2026-09-19-serve-stalled-tools.md)。

## 1.1 承重问题

| ID | 现状及影响 | 代码锚点（仓库相对路径，行号为基线快照） | 02 回应 |
|---|---|---|---|
| P1 | executeBatch 顺序完成全部 preflight 才启动工具，一项待批阻塞同批已准工具 | `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts:1817`，`splitIntoWaves:351` | §2.2 |
| P2 | lifecycle 先把工具都记 running，等 executeBatch 全返回才写终态和 yield 结果；快工具也等待慢工具 | `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:973,989,1004` | §2.3 |
| P3 | scheduler 有精细阶段，但事件缺 run/session/message 归属，SDK 工具只有四态；实时/刷新没有统一精细事实 | `core/tool-scheduler/events.ts:46`，`packages/ohbaby-sdk/src/snapshot.ts:123` | §2.3–2.4 |
| P4 | Thinking 依据整个 run 的 isRunning/startAt 显示，工具/审批时间被叫作思考；组件每秒由当前时间减起点 | `apps/ohbaby-web/src/ui/App.tsx:1562,2117` | §2.4–2.5 |
| P5 | llm:start 在消息建立前、重试循环外；不是每次实际 provider 请求起点 | `core/lifecycle/lifecycle.ts:1126`，`core/llm-client/streaming.ts:318` | §2.4 |
| P6 | Bash 已有 TERM→KILL，但 registry 等待收尾后可合成 timed_out；工具 Promise 结束可能早于真实资源清理 | `shell/process.ts:45`，`tools/shell-job-registry.ts:455`，`tools/bash.ts:204` | 前置 C、§2.6 |
| P7 | executeToolCalls 把 scheduler 所有抛错变成普通工具错误；事件 bus 不能承担必须成功的异步保存 | `core/lifecycle/lifecycle.ts:1481`，`bus/bus.ts:15` | §2.3、2.7 |
| P8 | 已有 prompt 时间和 message JSON，但未贯通模型请求阶段、工具等待原因和最终一次总耗时展示 | `packages/ohbaby-sdk/src/prompt.ts:36`，`core/message/database-store.ts:65` | §2.4–2.5 |
| P9 | scheduler 跨同 backend 会话共享粗粒度互斥；文件锁超时后提前释放，普通 read 未参与保护 | `core/tool-scheduler/concurrency.ts:19`、`tools/utils/file-locks.ts:40,65–67`，详见 §1.7 | 前置 C、§2.1–2.2、§2.10 |

上表省略的 agent 路径均在 `packages/ohbaby-agent/src/`。并发 bug 不能归因于模型连接；已有真实模型诊断曾跑通普通工具、子代理和队列，但不能证明本轮新行为已实现。

## 1.2 模块职责与结构

| 模块 | 现有职责与结构 | 本次发现的接口缺口 |
|---|---|---|
| scheduler | prepare/preflight、类别 wave、并发槽、取消、执行期限 | 无 awaitable 逐项交付接口；审批批次屏障过大；prepare 在 cleanup try 外 |
| lifecycle / message | 建消息、执行模型步、执行工具批次、保存 parts、产出流 | 保存与展示困在批次末；fatal 保存异常可能被降级；generator 无法从普通回调直接 yield |
| adapters / SDK / server | run event → UI parts；snapshot、SSE及会话过滤 | 只有粗粒度状态；不能凭 active run 猜工具来源；需消费 improve-1.1 的整页一致恢复接口 |
| Web / TUI | 渲染消息、工具与审批 | Web Thinking 代表整轮；必须减少误导且保持轻量，不将后台枚举全铺到默认行 |
| shell registry | 前后台 job、输出、固定期限、终止 | 调用终态与进程清理未分开；后台派遣本来就不持有 scheduler 整生命周期槽 |
| prompt scheduler | 提交/排队/启动/运行/终态，保存 created/started/ended | 可以复用总耗时，不能把 run.startedAt 冒充 prompt 提交时间 |

## 1.3 数据流与数据模型

现有主路径：`model tools → lifecycle 标 running → scheduler 全批 preflight → waves → results[] → lifecycle 保存所有结果 → UI`。

`ToolCallStatus` 已区分 pending/checking_permission/awaiting_approval/queued/executing/success/error/rejected/cancelled；`ToolState` 与 `UiToolCall` 是另一层较粗投影。新增精确信息应附着既有 tool part，不新建一套任务表或让 UI 反推状态。

`AssistantMessage` 当前没有模型请求时间字段；message 和 part 通过 JSON 存储，增加可选、显式类型字段可避免新表。仍需修改类型、事件 schema、store 更新白名单及 snapshot/live 投影，不能只写任意 JSON 后宣称全链路已支持。

`ToolSchedulerEvent.ExecutionCompleted` 仅经过 runTool 的调用才发布，参数错误、拒绝等早退不能靠它全部覆盖。bus.publish 不 await 异步 subscriber，也隔离 subscriber 异常，因此可靠持久化必须走可等待接口。

## 1.4 用例、可靠性和测试缺口

- 同波次 A 等审批、B 已批准：当前 B 仍可能没开始。跨写屏障放行 B 又可能读到旧文件，不能无条件并发所有调用。
- A 慢、B 快：必须证明 B 已保存/可见且模型尚未续轮，而非仅证明 Promise 并发。
- 写入失败：必须证明没有下一次模型请求、下一波工具未启动，已完成记录没有被覆盖。`Promise.all` 首错返回不等于兄弟任务已取消。
- 超时：当前 shell 单测/集成包含 TERM/KILL 和后台 timeout，但合成 timed_out 不能代替进程组消失证据。stdout 继承可让 close 延迟，直接 shell 退出也不等于同组后代消失。
- 刷新：必须重建阶段及时间，不能把前端重挂载当起点。网络断开不取消后台执行。
- 当前有 scheduler/lifecycle integration、shell-job registry tests、Web App tests；需增加跨层可控交错用例，不靠长时间真实搜索随机触发。

## 1.5 既有设计与代码对照

| 原文档 | 已有要求 / 当时取舍 | 本轮关系 |
|---|---|---|
| `docs/core/tool-scheduler/architecture.md` | 明确精细状态、wave及并发限制 | 保留必要顺序与容量；前置 C 替换粗粒度互斥，本轮补逐项交付与独立审批 |
| `docs/ohbaby-web/test.md` | live/snapshot一致、重连恢复 | 扩到工具阶段和模型计时，不能只修直播 |
| `docs/problem-lists/2026-09-18-web-chrome-polish/improve-3/02-optimization-plan-and-change-scope.md` | 静默摘要、全部折叠 | 按本次用户决定补简洁执行/异常标记；不恢复一排文字标签 |
| 第一轮及 improve-1.1 | 第一轮提供真实身份、独立审批、signal；1.1 提供整页快照与续传一致性 | 前置契约；未实施，本轮不复制实现，也不重新决定授权范围 |

## 1.6 SWE 审视与影响面

依据 learn-swe 的信息隐藏/职责分离（references/02）、KISS与DRY（03）、契约和行为测试（07）：复用消息持久化、取消和 shell registry，按前置 C 调整批次与资源准入；把实际执行、结果交付、资源释放分清，不让前端承担运行判断。保留一个持久化事实来源和共享格式函数，避免 live/snapshot 两套计时。

改动涉及 agent scheduler/lifecycle/message/llm-client/stream/adapters/shell、SDK、Web、CLI 及 server 的投影恢复边界。暂不扩大为 session 树重写、子代理协调框架、通用工作流引擎；并发/文件锁的必要调整已单列前置 C。方案必须接受不合作的进程内任务可能仍阻塞的现实限制，不能以“响应性”之名提前释放写入保护。

## 1.7 2026-09-21 补充：共享范围和文件锁

现有 scheduler 在 runtime composition 内共享，跨同 backend 主会话，不止父子代理（`ui-inprocess/runtime-controller.ts:106–109,158`、`ui-runtime/composition.ts:266,552`）。不同 workspace backend 的构造见 server `runtime/daemon/server.ts:166`。因此 P1/P3 的等待分析还需覆盖跨主会话资源竞争。

P9：`tools/write.ts:53` 与 `tools/edit.ts:72` 已使用路径级 `withFileLock`；`tools/read.ts:51` 附近直接读文件，不参与该锁。外层 ConcurrencyController 不看路径，使已有细粒度写保护不能带来不同文件并行。另有独立缺陷：`tools/utils/file-locks.ts:40,65–67` 超时包装先结束并触发 release，底层操作仍可能未停。对应前置 C：先修锁正确性，再完成访问范围、并发准入及 Bash 清理；第二轮消费这些能力，见 02 §2.10。
