# 数据流与接口边界

## Context and Scope

内部模块连接父子工具、Host 终态、现有调度输入和组合层续跑端口。以下是职责接口，不是要求新增同名公共 API；现有函数能承载的直接复用。

## Data Flow

### 主到子

父工具发送稳定身份的消息 → 校验目标与父子关系 → 现有 execution-message-channel 接收 → 子 run 在已有输入边界处理 → 成功请求确认。

重复提交必须核对相同身份对应的内容和来源。子 run 结束时仍未处理的消息保留可查事实，返回关闭原因；不因为恢复通知而偷偷重新启动该子代理。

### 子到主：忙与闲

子执行保存终态 → delivery 通知 supervisor → 若主 run 活跃，由 coordinator 在 beforeStep／beforeFinish 边界交付 → 若空闲，经现有 gate 与准入启动主 run → 持久化请求 → 确认消费。

当时只有 A/B 可用就交付 A/B，C 以后再通知。主 run 即将结束时发生的新结果，由输入关闭事务和 supervisor idle 核对接力，不能落在两条路径都不管的间隙。

### 自动启动的持久交接

组合层先保留最终 runId，条件认领可唤醒的 execution，并把同一 runId 写入其 delivery，再提交该 run。pending run 仍由现有 startSession 创建，不提前提到外层。不得在提交时另造 runId；reserveRunId 本身只是内存保留，持久关联来自 delivery。

不要求跨 LLM 的事务，也不新建工作队列表。几个崩溃窗口按如下方式收敛：

| 中断位置 | 恢复规则 |
| --- | --- |
| 只认领了批次的一部分 | 已认领结果带 runId；未认领结果仍 pending。按同一来源去重，不能把半批次视为已消费 |
| 认领后、run 尚未建立 | 本地提交已明确失败，或恢复已验证会话 ownership 后，才核对为入口失败并有限重试；活跃提交不能因账本暂时缺行被抢占 |
| 输入接收后、delivery 关联前 | 同 inputId 查证并补关联 |
| 成功请求后、消费确认前 | 按请求成员关系补确认，不再调用模型 |

认领和提交的正常失败也必须释放 gate，并返回明确结果；已创建的 run 依既有终态规则关闭。明确收到用户 Stop 时，先按 delivery 的自动启动 runId 找到真正触发该 run 的结果，用已有存储事务将其剩余恢复额度置 0；提交后再关闭 run、释放 gate 并完成取消收尾，不能误伤顺带接收的结果。即使 run 尚未建账，重启也不会重新尝试该来源。不在外层为取消新增账本行。若持久化本身不可用，不伪造成功或安全重试结论；待存储恢复后核对，证据不足则等待新触发。

### 故障中断

服务存活但子 LLM 重试耗尽：Host 保存 failed，立即进入正常终态通知。进程意外退出：现有 execution-recovery 验证 owner 已死亡，保存 reason 为 process-interrupted 的 interrupted，组合层通知 delivery。正常停服：Host 的各条结束路径均须保存 service-shutdown，finishRecord 同时保留 pending；当前 dispose 虽传递该原因，仍有下述竞态需要修复。关闭中的准入不启动模型，重启接管后交付。两条路径使用同一稳定结果身份，不重复通知。

正常停服还要修改 turn 的 markInterrupted：closeAdmission 的 abort 可能比 dispose.interruptRoot 更早触发终态写入。此时同样传递受控 service-shutdown，不能先写 cancelled；不通过允许覆盖终态来掩盖竞态。

不能只因为运行时间长就认定崩溃。其他活进程／未知 owner 仍按已有规则阻止接管。通知包含子代理身份、原任务、最终状态、错误或中断原因、可取得的输出以及未处理输入信息；输出文件不可读时也能交付基本故障事实。

主代理判断是否 monitor、再次 send、另派任务或自行完成；若工具可能产生了外部效果，先查现状。通知不命令它盲目重做最后一次工具调用。

## Interface Definitions

| 边界 | 输入 | 结果与责任 |
| --- | --- | --- |
| 接收父消息 | 来源身份、父子关系、内容、目标 execution | accepted／重复一致／目标关闭／冲突；沿用现有通道 |
| 记录／观察子终态 | 已持久化 execution 及受控终止原因 | 建立或核对稳定结果来源；不直接执行模型 |
| 交付可用结果 | session、scope、runId、排除的 Goal roots | 返回接收的 input 身份；遵守原有分页及内容预算 |
| 确认请求 | 成功持久化 requestId | 精确确认其 inputIds；幂等更新对应 execution |
| 核对恢复 | 已验证 ownership 的会话、现有 run/input/request 记录 | 补关联／补确认／允许有限重试／保留等待，不能靠列表读取触发 |
| 请求续跑 | 已认领的 runId、候选来源、Goal ticket（若有） | 有类型的 succeeded／failed／cancelled／not-admitted；Promise rejection 同样归一收尾 |

续跑接口不能再返回 `Promise<unknown>` 并仅捕捉 throw。失败阶段根据持久记录核对，不根据错误文本猜“有没有请求过”；所有合格的请求前失败共用一个有上限的恢复策略，不新增 transient/permanent 错误体系。入口错误与后续主任务失败分别向现有错误投影报告，避免重复提示。

## Data Ownership

execution store 是子执行与结果交付元数据的唯一来源；input store 是接收和请求成员的唯一来源；run ledger 是运行状态和所有权的唯一来源。SDK/UI 只读投影。delivery 不保存另一套这些状态，也不从 UI 当前消息列表推导持久身份或消费事实。
