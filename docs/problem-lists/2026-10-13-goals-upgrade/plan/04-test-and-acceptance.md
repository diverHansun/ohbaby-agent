# 4. 总体验收基线

> 对应 [02](./02-optimization-plan-and-change-scope.md) 的全部总体约束，不代表这些测试已实现或执行。
> 各 improve 文档选择该批涉及的场景、具体测试文件和命令；归属见 [根 README](../README.md)，improve-5 收齐跨批组合。遵循仓库既有测试分类，不另建测试体系。

## 4.1 验证方法

| 类型 | 对象 |
| --- | --- |
| unit | 预算合并、校验、状态迁移、同因计数、文本渲染、时钟计算 |
| contract | SDK 字段、命令参数/错误、live/replay 消息、事件与 notice、输入状态 |
| integration | 真实 store/service/driver/adapter/scheduler 协作，持久化回放，假 provider 超时，压缩与 steer |
| smoke / 手工检查 | CLI/Web 的加载、状态布局、恢复交互与重连；构建和生成物同步 |

竞态使用可控 deferred/barrier 与 fake clock，显式卡住关键 await 再触发另一操作，不靠 sleep 碰运气。LLM 用 fake provider；真实模型测试仅按既有开关单独运行，不能作为竞态正确性的主要证据。UI 字段和恢复入口要有可重复检查，不排除 Web 渲染测试。

## 4.2 准入与生命周期（02 §2.2）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| A1 | 用户 claim 与 goal 准入同时观察到空闲 | integration | 仅一方取得执行权；存在更早用户工作时 goal 不先启动 |
| A2 | goal 等待期间 pause/cancel/新建替换 | integration | 无过期正文提交；未准入不计轮；已准入准备取消保留计轮，覆盖 runId 绑定前、startSession 前与启动握手期间；旧占位正确释放 |
| A3 | 等待期间只改 objective | integration | 旧等待者因 objective 实改失效，新 epoch 的正文和展示来自同一最新准入快照，轮号一致 |
| A4 | 计轮持久化失败 / 启动失败 | integration | 写失败无内存虚增、无悬空占位；已成功准入后启动失败保留一轮 |
| A5 | 手动 compact 占位时请求下一 goal 轮 | integration | 等待后重检，不 pause、不空转；压缩结束可靠唤醒 |
| A6 | 旧轮 succeeded/failed/cancelled/外层抛错，新目标已创建 | integration | 旧 usage、停因、clear、catch 不影响新目标 |
| A7 | pause 后立即 resume，旧轮迟到取消/失败 | integration | 旧结果不再次暂停；最后恰有一个有效 driver |
| A8 | 同条件重复 ensureDriving 与退出清理 | unit + integration | 不双启动、不删除后继占位；已提交新代或显式 resume 不丢驱动；同代致命失败且暂停落盘失败时停止，不因仍 active 自动忙重试，存储恢复后显式 resume 才重试 |
| A9 | 准入已落盘后崩溃 | integration | 回放保留计数，active 降 paused；不自动重跑 |
| A10 | 运行中 `/goal replace` 实改 / 同文 no-op；真实变更工具上下文 | integration + contract | 实改保留 goalId/统计但失效旧 epoch，旧 run 的 complete/budget/create 被拒，旧 usage 可结算；下轮用新正文；同文不失效。CreateGoal/SetGoalBudget/UpdateGoal 从真实 ToolExecutionContext 传 runId，未知身份不当作普通用户 |

A1/A2/A7 使用真实调度与状态组件组合，不只测一个模拟 admission callback，否则会漏掉检查空闲到占位之间的竞争。

## 4.3 状态、预算与 resume（02 §2.3）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| B1 | 轮次/时间/安全阀触发；显式 stop 与 run failure | unit | 前三者 blocked；后两者 paused；cancel 清除 |
| B2 | token 超过历史额度 | unit + integration | 不参与停止/converging；旧 token 预算读兼容，新记录与工具不再写它 |
| B3 | resume 无参数、只给轮次、只给时间、同时两维 | contract + integration | 未给维度保留；两维可交换顺序；总额度不清零用量 |
| B4 | 两维同时到顶，只抬一维后再给两维 | integration | 单维失败零修改并列出另一维；两维通过后一次 update 同时生效和恢复 |
| B5 | 非法数字、单位、重复维度、缺值、尾部垃圾、超 1000/24h | contract | 明确拒绝且状态/记录不变；不默默忽略参数 |
| B6 | resume 与 SetGoalBudget 并发改不同维度 | integration | 合并、校验、写入序列一致，无丢更新或用旧快照放行 |
| B7 | 上限等于已用量；安全阀到顶 | unit + contract | resume 拒绝；安全阀提示 cancel 后新建，不提示 replace 重置 |
| B8 | SetGoalBudget 调高 paused/blocked 预算 | integration | 预算更新但状态不激活；显式 resume 后才驱动 |
| B9 | 同一 run 三次 blocked；三个相邻 goal run 同因 | integration | 同轮最多贡献一次；逐轮调用返回 active 1/3、active 2/3、blocked；提示不得要求先等三轮再报告 |
| B10 | 换原因、空原因、无报告轮、普通用户 run、steer、not_admitted | unit + contract | 空原因拒绝；换因从一计；无报告轮断链；其他路径不增加计数 |
| B11 | 停止后 resume、active 幂等 resume、替换 objective、新目标、重启 | integration | 真正恢复、objective 实改、新目标、重启重置审计链；同文 no-op 不重置；active 幂等或仅调额度不重置；已落盘 blocked 保留 |
| B12 | 模型传 active/paused；旧目标 run 调工具 | contract | enum 拒绝；旧身份不能改变当前目标 |

模型 complete 无三轮或独立证据硬门禁。B9 不应误测成“调用工具三次即可”。安全阀达到后即使显式预算未设置也不能 resume。

## 4.4 时间截止（02 §2.3）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| D1 | 一轮长请求超过活跃时长预算 | integration | 当轮内 blocked 并中断对应 goal run，无需等轮末 |
| D2 | active 时首次设预算、抬高、降低或清除可清除的上限 | integration | 按实际 API 支持范围重排定时器；旧截止失效；不凭空新增清除语法 |
| D3 | 定时器将触发时 pause/resume/新建目标/objective 实改或同文 | integration | 旧回调无法停止后继生命周期；实改重排后仍在原累计截止点 block，并中断同目标仍运行的旧 root；同文保留原 timer；最新预算再次核对 |
| D4 | goal 等待正在执行的用户工作时到点 | integration | goal blocked，用户 run 及其子代理均不被中断；无 goal root 不走 session 级后备中断 |
| D5 | 中断 helper 的 await 前后执行者切换 | integration | 主 run 与子代理仅按捕获的 goal root 中断；旧回调不影响新 root 及其子代理；includePrimary=false 同样限定范围 |
| D6 | 早到回调、pause/cancel/complete/dispose | unit | 早到重算后重新安排；停止后无遗留任务和重复通知 |
| D7 | 用户队列持续有工作 | integration | goal 不插队；active 等待时长继续增长；paused/blocked 时停止增长 |

## 4.5 完成与统计（02 §2.4）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| C1 | 同一 goal run 内 complete，尾部 usage 随后返回 | integration | 先持久 complete 禁止续跑；usage 包含已知末轮数据；然后 clear |
| C2 | complete → 结算之间崩溃并回放 | integration | 残留 complete 直接清理；不变 paused、不恢复执行 |
| C3 | complete 等待尾部结算时 resume/replace/budget/create | contract + integration | 终态不能复活或编辑；允许新目标；旧清理不影响新目标 |
| C4 | complete 重复调用、无待结算 goal run 与最终 clear | contract + integration | 完成 notice 一次，无额外 cleared notice；无待结算 run 时及时清理；UI 始终无该已完成目标 |
| C5 | cancelled/failed 仍带已知 usage | integration | 同 goal 结算已知部分，不被 active-only 或 usageComplete-only 闸门丢掉 |
| C6 | usage 缺失、部分 usage、缓存命中 | unit + contract | 未知不伪装完整零；查询说明部分统计；总数与 cached 不重复相加 |
| C7 | 重复完成回调、旧目标替换/取消后回写 | integration | 同一票据不重复累计；usage append 失败经真实 session recovery 入口重试，clear 失败重试不重复用量；恢复前不准入，runtime finalization retry 返回的真实 usage 被保留；lease 在首次 settle/恢复注册后才释放，用户无法抢入覆盖 recovery 槽；替换/取消后补旧 run 记录但不追记新目标 |
| C8 | 子代理与摘要请求 usage | integration | 不归集进 goal primary 统计 |

统计测试断言记录顺序和关联身份，不要求新增完成历史 UI。模型 complete 的 reason 不保存；criterion 不进入硬验收逻辑。

## 4.6 用户输入、队列与恢复（02 §2.5）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| S1 | goal 运行时输入普通消息，恰好触发 drain | integration | accept 持久化后、claim 前完成分流；goal 不取消/暂停；输入下一 step 消费；最终 prompt.updated 为 steered，onSteered 与 completion waiter 完成，UI 无永久 queued 项 |
| S2 | steer 目标已封口/关闭/切换 | integration | 原项保留 queued，IDs 和接受顺序不变；无重复消息 |
| S3 | steer 存储异常/身份异常 | contract + integration | 如实报错，已接受内容仍可查询；不伪报成功 |
| S4 | 同 clientRequestId 重试 | integration | 复用原 receipt，不把旧输入改投新 run；并发重试在落盘后分流前读到 queued 并注册 waiter，成功 steer 后也会结算 |
| S5 | A 回退排队后 B 到达；同毫秒连发 | integration | B 不 steer 越过 A；同请求内多输入保持接受顺序 |
| S6 | 当前 goal 轮结束，用户队列非空 | integration | 用户先运行直到队列清空；goal 下一轮才准入 |
| S7 | 多 session 的 goal 都在运行，用户项排队 | integration | 未执行项不提前 claim 占 maxActiveSessions；其他 session 可运行 |
| S8 | stop/pause 与 accept/steer 交错 | integration | 按边界先后处理；未消费输入可见；不会自动恢复目标 |
| S9 | 异常失败、取消、进程恢复后残留未消费输入 | contract + integration | 不限 user-stop，也不限最近 run；原文可辨认且可显式重发 |
| S10 | 已标本地 attempt，但 provider 接收不确定 | contract | 显示“处理未确认”等准确事实，不声称肯定未发送或已处理 |
| S11 | 成功 steer 与排队普通 run 各自执行 | integration | 前者共享 goal Todo/reasoning/step；后者用普通 run 配置；无独立答复承诺 |
| S12 | 正常完成带 pending input；大 protected input 与压缩 | integration | 保留 close/seal 防护；未消费输入不被压缩吞掉；超限明确失败、可恢复 |

## 4.7 文本、UI 与上下文兼容（02 §2.6）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| U1 | goal 第一轮和续轮，实时与刷新重读 | contract | UI 显示同一短提示，模型及持久正文完整；仍 user origin |
| U2 | 同一发起消息附加 runtime context | integration | 环境信息/MCP 菜单仍存在，goal 不占用 runtime kind |
| U3 | inactive 或无 goal 时普通输入 | integration | 不新增自动 goal 前缀；允许历史、静态规则和显式 GetGoal 内容存在 |
| U4 | `/goal` 创建首条会话消息 | contract | 标题来自目标/正文，不是 `Goal auto-continue` |
| U5 | CLI/Web 初始快照、增量事件、重连 | contract + 手工 | blocked、轮次、时长一致；turnBudget 有值才显示分母；无 token 常驻字段 |
| U6 | 多次计轮/usage 更新 | contract | 更新数字，不追加生命周期 notice 刷屏 |
| U7 | Web blocked 的普通恢复与调高额度恢复 | contract + 手工 | 面板 Resume 可用；composer 带参原命令不丢参数，单维/双维/反序均到同一后端，非法尾部拒绝；无参仍进面板，错误可见 |
| U8 | 窄 CLI、窄屏 Web、长 objective/原因 | 手工 | 数字和操作可读，不加新色相/进度条，不出现明显溢出 |
| U9 | 状态查询与自动提醒 | unit + contract | 查询有 total/cached 与部分统计标识；自动提醒无 token，有轮次/时长/两轴预算 |
| U10 | criterion 5999/6000/6001、空白、非 BMP 字符 | unit | trim 后 UTF-16 length 正确；超限拒绝，不截断 |
| U11 | replace:true 且 criterion 超限 | integration | 原目标、用量与持久记录不变，校验先于替换 |
| U12 | objective/criterion 含 XML 闭合标签 | unit | 既有转义保持，各字段每轮只注入一次 |
| U13 | goal 开关、连续续跑、自动/手动压缩 | integration | 不按状态改写静态 system 前缀；正文仍按通用压缩分组处理；提醒由 store 重建 |

时长是最近后端快照值，本基线不要求每秒刷新。不把“画面没逐秒走字”判为失败，也不把展示估算值作为预算判定。

## 4.8 请求空闲超时（02 §2.7）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| W1 | provider 建流或首个 next 永不完成 | integration | 有界超时；符合重试条件时退避并重试；耗尽明确 failed |
| W2 | usage-only 事件后或主循环 next 挂起 | integration | 各等待点都受保护，无漏网裸 await |
| W3 | 已输出正文/reasoning/tool call 后挂起 | integration | 显式中断失败；不无条件重放产生重复输出/副作用 |
| W4 | 用户 stop / goal 时间截止与 timeout 竞争 | integration | 取消原因不被伪装为可重试超时；goal 状态不被迟到失败覆盖 |
| W5 | next / return 不响应 abort，迟到 resolve/reject | integration | 调用方有界退出；opening 在 timeout 后退避中（finally 前）及 finally 后迟到成功/失败，均不启动 observer/next 或污染后继记录；清理不阻塞，无未处理 rejection |
| W6 | 正常慢流、消费者处理缓慢 | integration | 只计 provider outstanding 等待；收到可观察事件重置；消费者耗时不误判 |
| W7 | 普通用户 run、goal run、重试多次 | integration | 同一通用保护；timer/listener 不泄漏，不增加第二层重试循环 |

对应 improve 必须先固定默认阈值、允许范围和配置入口，再用 fake clock 验证阈值边界。真实 provider 的心跳不可观察时，如实记录局限，不把另一项目的自建 SSE 能力当成本项目现有能力。

## 4.9 兼容、回归与完成条件

优先扩展既有 `goals/*.unit.test.ts`、`persistence.integration.test.ts`、`goal-compact.integration.test.ts`、adapter/scheduler/SDK/UI 测试。测试应检查消费者可见行为，不以私有 map 数量或固定函数调用结构代替契约。

必须保留的行为：

- 一 session 一有效执行者，权限审批与 sandbox 政策不变。
- `/goal budget` 仍不是新命令；新额度入口在 resume。
- complete 由模型自报；不增加 verifier 或最小完成轮数。
- blocked 读写与旧 token 字段兼容；active 重启暂停，complete 重启清理。
- `getMessageOrigin`、runtime model-context、压缩摘要和缓存身份不因 displayText 改变。
- 成功 steer 不影响显式 stop；用户消息不会因目标切换而静默消失。

总体完成要求：各批关联的 A/B/C/D/S/U/W 场景有测试或明确的手工证据；跨批组合回归通过；类型、构建、生成模板及模块文档一致。真实模型或手工项未跑时明确记录，不能以“相关单测通过”代替全部验收。

本次 plan 完成仅表示文档决策、参考依据与验收基线闭合，不代表上述产品行为已实现，也不产出实施验收 05。
