# 现状、故障与历史提交

分析日期为 2026-11-12，规划基线为 `d5625248ea877cee107ee73cec23b146f50be1b5`。工作区已有其他议题的未提交变更，本轮未修改它们。下列代码路径相对仓库根目录，行号是本次核查快照，定位以符号为准。

## 1. 真实会话发生了什么

会话为 `session_1794396938462_0rff2x2`，标题为“搜索海淀高校秋招活动时间”。只读证据来自用户本机 SQLite 和运行记录，不是仅凭截图推断。

六次子代理终态通知都触发了主代理自动运行，但六次运行均以 `Existing message identity/content conflict` 失败，没有进入主模型请求。以最后一个 xyl-a 为例：2026-11-11 21:38:27.496（UTC+8）子代理完成，主运行在 .521 启动，.526 失败。结果仍为 pending，已有 `wakeupAttemptedAt`，没有 `inputId`。

前五份结果后来随用户主动输入进入成功请求；这解释了会话中主代理已经谈到部分子代理结论，却仍没有收到最后一份结果。不是所有子代理结果都丢了，也不是主代理已经看到最后结果后选择不回答。

严重程度判断为 P1：核心协作流程在受影响的历史数据库中静默中断。当前证据显示结果仍保留，没有发现结果被删除；影响取决于历史消息身份与当前加载范围，不能表述为所有安装必现。

## 2. 根因链路

| 问题 | 当前实现与证据 | 影响 |
| --- | --- | --- |
| P1 自动输入使用进程内 ID | `adapters/ui-inprocess.ts:4405` 的 `submitPromptWork` 回退到 `messageIds.next()`；`adapters/ui-runtime/composition.ts:1333` 优先接受 `initialUserMessageId` | UI 局部编号被写入全局唯一的消息表 |
| P2 历史范围不完整 | 编号来自当前 UI 快照，未覆盖其他工作目录或快照范围外的历史；真实库已有 `message_1` 至 `message_6` | 切项目或重启后的局部编号撞上历史消息 |
| P3 尝试标记过早消耗机会 | `agents/subagents/execution-store.ts:565` 的 `claimWakeup` 先写 attempted；`session-supervisor.ts:110` 此后排除它 | 入口失败也被当作已经自动处理过 |
| P4 返回失败没有统一处理 | `adapters/ui-inprocess/subagent-wakeup.ts` 对普通 submit 只处理 Promise rejection；`submitPromptWork` 可正常 resolve 一个 failed completion | 调用没有抛异常，仍可能运行失败；恢复与提示漏接 |
| P5 空失败轮次被隐藏 | `ohbaby-sdk/src/util/turn.ts:88` 排除无 prompt、无可见消息的 run | 用户看到 Completed 与沉默，无法知道主运行失败 |
| P6 故障中断与主动停止混用 | `execution-store.ts:218` 的 `finishRecord` 对 interrupted/cancelled 统一设 delivery none；`runtime/execution-recovery/session.ts:243` 将孤儿执行记为 interrupted | 服务退出导致的故障没有结果通知 |

P6 还包括正常停服：`agents/subagent-host.ts:1345` 的 closeAdmission／dispose 使用 `service-shutdown`，执行已进入 interrupted，后续恢复不再把它当 queued/running 处理。必须在终态保存时保留可投递事实。此外 turn 内 markInterrupted（约 1790 行）固定传 cancelled，可能抢先于 dispose 写入；应让所有停服结束路径保留同一个受控原因。子 LLM 最终失败和超时本来就分别进入 failed/timed_out 的 pending 路径；它们需要修好交付链路，不能误写成当前没有产生终态通知。

普通用户提交已经在 `adapters/ui-persistent.ts:899` 注入 UUID 工厂，队列路径在 `ui-inprocess.ts:2037` 使用它；自动输入绕过这条路径。结果协调器和主到子消息通道已有稳定来源及命名空间 ID，说明问题是入口不一致，而非整个消息存储缺少唯一性约束。

`runtime/prompt-scheduler/current-run-inputs.ts:329–349` 检查既有消息的 session、scope、身份和内容。该检查正确阻止了跨会话冲突，必须保留，不能通过忽略冲突或覆盖旧消息来修复。

## 3. 历史提交

| 提交 | 时间 | 与本问题的关系 |
| --- | --- | --- |
| `b92777c05228f22a1608bd9f93987c48d58825f7` | 2026-10-29 | 引入 session-owned lifecycle、空闲时新开自动主轮次和一次自动机会。本次冲突链路在该提交的隔离副本中已复现，是直接回归起点。 |
| `c990b0eeb47093db1e35fdefa8d9d82d2bf74be7` | 2026-10-29 | 加固和拆分清理、投递、监督代码，但保留上述行为。当前 blame 可能落到这里，不能仅凭 blame 判定首次引入。 |
| `aa5493b8` | 2026-10-31 | 子代理统一后台运行，落实 D54；主 Stop 不再连带停止子代理。 |
| `c7ee98f83939da823fdc892c46061414e2c6eda4` | 2026-11-07 | 取消 2/5 分钟模型巡查，保留结果、失败、超时唤醒。不是消息 ID 冲突的起因，修复不回退该设计。 |
| `957f48089aa0f4efe508df62a46af273324fb9ab` | 2026-11-07 | 共用 ended turn 规则，隐藏没有可见消息的自动失败，使故障更难发现。 |

此前在原主 run 内等待子结果的路径使用运行时命名空间 ID。新开主轮次后经过另一条输入构造路径，暴露了局部编号与持久身份混用的问题。

主动检查也已有历史基础：`59e577d9`（9 月 28 日）补充持久派遣身份与有界历史分页；`b92777c0` 加入 monitor；`c990b0ee` 补充未处理消息和关闭原因。这些能力继续复用。

## 4. 诊断验证及限度

调查阶段使用真实 persistent facade、SQLite、supervisor 和子执行，只替换模型响应。在干净数据库中，父模型调用三次并消费结果；加入另一个项目的历史 `message_1` 后，父模型只调用两次，自动轮次出现与用户会话相同的冲突，结果保留 pending。

同样的探针在 `b92777c0` 的临时源码副本复现；仅在临时副本把运行时输入改成 `runtime:${inputId}` 后，两组场景通过。没有修改用户运行中的服务或生产数据库，也没有把这个小改动当作完整修复。

本机诊断探针位于 `.ohbaby/subagent-wakeup-diagnosis/repro.test.ts`，配置为同目录 `vitest.config.ts`；它是 gitignored 调查材料，不是交付物。命令：`pnpm exec vitest run --config .ohbaby/subagent-wakeup-diagnosis/vitest.config.ts`。原始基线预期为一项通过、一项失败。实施时须将行为用例整理进正式测试，不能依赖该临时目录存在。

原有内存唤醒集成测试通过，不能覆盖全局 SQLite 历史冲突。历史副本的小改动只证明直接原因，不证明恢复、停止和前端反馈已经修复。

## 5. 现有能力与缺口

| 维度 | 已有能力 | 本轮缺口 |
| --- | --- | --- |
| 目标与职责 | Host 管生命周期，输入 store 管接收和确认，adapter 管准入 | 投递规则散落，启动失败无人完整收尾 |
| 架构 | 共享 SessionExecutionGate；coordinator 接生命周期输入端口 | 结果业务规则与 UI 提交路径耦合；应统一内部入口，不复制执行器 |
| 数据含义 | sourceId、inputId、messageId、requestId 分工；execution.delivery 保存结果状态 | attempted 缺少可核对的运行关联；终止原因不足以稳定区分故障和主动停止 |
| 数据流 | `execution-message-channel.ts` 支持主到子幂等接收；`continuation-coordinator.ts` 负责子到主 | 自动启动 ID 不一致；请求成功与确认之间的崩溃需完整核对 |
| 用例 | 忙时后续请求、闲时启动、Stop 后子继续、monitor 纯读 | 入口失败、故障恢复通知与空轮次反馈不完整 |
| 可靠性与成本 | 输入与关闭事务，明确进程 owner，现有 provider 重试预算 | 不能把投递恢复叠成无限模型重试，也不能仅靠内存事件恢复 |
| 测试 | monitor 的只读 SQLite 重开测试；wakeup/gate/coordinator/input 集成测试 | 缺少带旧库的完整自动唤醒测试及关键崩溃窗口断言 |

## 6. 文档与实现对照

| 文档约定 | 当前实现 | 处理 |
| --- | --- | --- |
| lifecycle D08、D54：Stop 后新结果仍可唤醒 | 主代理 abort 与后台执行已经分开 | 保留，不新增永久暂停开关 |
| lifecycle：请求成功才确认 | `confirmRequestSuccess` 检查持久成功请求 | 保留并补恢复核对 |
| lifecycle：同一失败结果不立即重开 | attempted 一律排除，包括输入前失败 | 细化启动失败与有效请求／用户停止的区别 |
| `docs/runtime/prompt-scheduler/subagent-inputs.md`：每结果一次自动机会 | 缺乏失败阶段与运行关联 | 实施时同步说明，不能直接删除限制 |
| 既有故障恢复不自动重放命令 | 修复 orphan 记录，无后台中断通知 | 保留不重放，补一份故障通知 |
| Goal 结果不可绕过 Goal 准入 | `goals/service.ts` 的 ownedRuns 只在内存；子结果唤醒的 Goal run 仍可标记 triggerSource=subagent | execution 接收时新增 goalId 事实，不假定现有持久 Goal/run 关系已经存在 |
| 模型反馈议题保持轮次可见性规则 | 无输出自动失败仍隐藏 | 本轮明确增加此类失败展示 |

`docs/agents/goals-duty.md` 仍有“runtime 不依赖 agents”的笼统约束，但当前 execution-recovery 已引用 agents 类型。本轮不扩大这条依赖，也不借机重构全仓层级；新增投递编排留在 agents，由组合层连接现有恢复结果和调度端口。实施时修正文档表述，使具体边界可执行。

## 7. SWE 判断与后续对应

直接故障先修统一身份；可靠性补在已有数据和事务边界；模块提取用于集中当前确有重复的规则。两种方向的消息不强行合并成同一种运行策略。P1/P2 对应 02 Stage 1，P3/P4 对应 Stage 2，P6 对应 Stage 3，P5 对应 Stage 4；验收见 [04](04-test-and-acceptance.md)，目标结构见 [design](design/architecture.md)。
