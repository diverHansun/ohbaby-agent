# 2. 总体方案与改动面

> 本文是跨 improve 批次共用的设计基线，覆盖 [00](./00-discussion.md) 的全部有效决议。它规定最终行为、边界和依赖；实施顺序见 [根 README 的五批地图](../README.md)。
> improve 文档在此基础上确定各批改动、具体接口、测试与回滚，并明确中间版本的过渡行为。当前不实施产品代码。

## 2.1 总体结构与原则

保留 GoalStore → GoalService / driver → GoalTurnRunner → adapter → runtime 的结构。主要改动是统一用户与 goal 的执行准入，补齐停止/恢复/结算边界，并把模型正文与 UI 展示分开。

```text
用户输入 → 持久化接受 → 当前 goal 可接收且无更早排队项？
                         ├─ 是：steer 到当前 run
                         └─ 否：保留 queued，等执行权

用户 claim ─┐
             ├─ 同 session 的短准入串行区 → 唯一执行占位 → 启动 run
 goal 准入 ─┘         ↑ 用户 queued/starting/running 优先

GoalStore → 状态/预算/用量 → adapter 投影 → CLI / Web
                         └─ 生命周期通知与数据刷新分开

所有 LLM 请求 → llm-client 空闲看门狗 → 有界重试或明确失败
```

短串行区只协调状态、接受顺序与执行权，不持有到整个 run 完成，也不在其中等待 runReady 或中断完成。优先复用现有 session 提交机制；goals 通过依赖注入使用窄变更端口，adapter 接现有 owner 队列，不让 goals 导入 scheduler 或 UI 投影。区内只做读改写与捕获身份，区外执行中断、驱动等后续动作，避免同队列重入。

**不变量**：同 session 不会同时启动两个执行者；旧执行不能改变新生命周期；计轮与提醒来自同次准入；被接受的用户输入可追踪；模型自报完成后不会再次自动续跑。

## 2.2 执行准入与旧结果保护（决议 7、8、12）

### 共享执行权

用户 accept 后的 steer 分流、用户 claim 前的执行权占位，以及 goal 的队列检查和占位，需要使用同一 session 顺序保证。现有 wait-for-idle 后再 set map 的检查/写入间隔必须消除。

- 用户消息持久化成功后，在释放提交串行区前尝试 steer；不要递归调用会重入同一串行队列的公共方法。
- goal 准入前检查没有 queued / starting / running 的普通用户工作，也没有压缩等会话操作占位。
- 获得执行权后核对当前 goalId、active 状态、预算与安全阀，形成准入快照，持久化本次计轮并生成完整正文和展示文本。
- 票据从 reserve 起持有准备取消 signal；停止提交先捕获旧票据，append 成功后立即失效并取消准备，区外等待中断。绑定 runId 后、startSession 前及跨 await 的 runReady 交接均复核，防暂停/取消/截止落在启动握手内仍继续运行。runtime 启动即算已启动；交接只执行已捕获停止意图，complete/模型 blocked 与正文实改允许主 run 收尾，不能因 epoch 失效一概中断。
- 占位覆盖到首次结算成功，或同票据 recovery 阻断已登记，再按 token 释放；准备失败、启动失败、取消和正常结束都须闭合。仅延长 gate 占位，不持有 owner 等长任务；释放后唤醒双方。不能先释放让用户 run 进入，再发现 goal 结算失败覆盖同 session 的 recovery。

准入计数成功即算一轮，随后启动失败或准备阶段取消也计入，并以携带票据的 failed/cancelled 结果结算，不能再报不计轮的 `not_admitted`。它代表已获准执行，不是 provider 成功次数。持久化失败不能留下仅内存加一；不能仅把 `turnsUsed += 1` 从 await 后挪到前面就宣称解决一致性。

准入检查发现预算或安全阀到顶时，先将对应 active 目标转 blocked，再结束驱动；不能保持 active 返回重试。压缩结束、执行权释放、用户队列清空都触发条件重检；真正的先后由同一个准入门决定，不依赖通知谁先被唤醒。

准入时可先持有 goalId + generation 的执行票据，runId 生成后、启动前绑定到该票据；所有变更工具从 `ToolExecutionContext.runId` 经 `GoalToolBackend` 传递真实身份（第 2 批完成），不接收模型提供的 runId。adapter 依据实际 run 所有权分辨 goal 票据与普通用户主 run，缺票据或未知身份不自动获得普通用户权限；GetGoal 只读不受 mutation 门禁。第 3 批审计在此基础上再要求已准入 goal run。无需假设现有代码在最初占位时就已生成 runId。

`not_admitted` 表示未取得本轮资格，不计轮、不构造过期消息。目标已停止/替换则重新读态退出或重试；用户工作或压缩仍忙则等待对应变化。最终实现需覆盖“订阅与检查之间条件已改变”，不能只盲等下一次事件。

### 身份与回写

准入身份至少能关联 goalId、runId 和当前生命周期。优先使用已有 runId 加一个进程内 generation；无需持久 revision，也无需把每个字段变更都版本化。

| 操作 | 必须检查 |
| --- | --- |
| 用量结算 | 属于准入的 goalId/run，最多结算一次，不能写到替代目标 |
| failed / cancelled / 外层 catch 导致暂停 | 目标及生命周期仍对应旧执行，且当前仍可被该结果改变 |
| 截止回调 | 当前 goalId、生命周期及最新时间预算仍匹配 |
| 释放执行权 / 删除 driving 项 | 只释放自己持有的占位/promise，不能删除后继执行者 |
| 工具更改目标 | 依据真实调用 run 绑定目标，旧目标工具不能修改新目标 |

暂停后立刻恢复必须使旧轮的迟到结果失效：生命周期转换时就失效进程内代号，不能等新 driver 启动才变更。driver finally 按原 promise/条目身份清理自己的记录，不拿已经变化的生命周期代号当清理条件；随后仅为已提交的不同 goalId/epoch 或未消费的显式驱动请求补一次 ensureDriving，防退出期间的 resume 请求丢失。若同代致命失败且暂停写入也失败，不能因仍 active 而循环重启；错误可见，存储恢复后显式 resume 才重试。待结算 recovery 也阻止新准入。

`/goal replace` 归一化后正文实际改变时递增同一个 executionEpoch（本文 generation 的同义词），保留 goalId、预算与累计统计；同文 no-op 不失效。旧等待者退出，已准入准备取消且保留计轮，已启动旧 run 可收尾并结算同目标 usage，但不能再 complete/改预算/创建替代目标或接自动 steer。后继新 epoch 从最新准入快照开始。

## 2.3 状态、预算、恢复与截止（决议 3、9、13）

### 状态边界

active 可续跑；显式 stop/pause、当前 run 失败和重启归一化进入 paused；两轴预算、安全阀和模型合格阻塞报告进入 blocked；模型 complete 是不可恢复的终态，随后清除。cancel 直接清除。

`pauseReason` 同时承载 paused / blocked 原因，不增加 PauseCause 枚举。模型工具只接受 complete / blocked；静态规则、续跑规则和生成模板同步更新。

### 三轮同因阻塞

复用第 2 批已接通的工具 runId 与票据，绑定本次已准入轮。只在当前 active 的 goal-owned run 接受审计贡献；普通用户 run 不能凑足次数，返回清楚说明。

- reason trim 后必须非空，比较值为 trim().toLowerCase()。
- 每轮第一次有效报告最多贡献一次；同轮重复调用不能加速累计，也不能用换理由重写该轮计数。
- 相邻 goal 轮同因报告累计；中间一轮没有报告则下一次重新从一计。
- 新理由从一计；新目标、从 paused/blocked 显式恢复和进程重启清零。active 上幂等 resume 或仅调额度不重置审计链，不能借此绕过连续轮审计。
- 第三次合格报告立即持久化 blocked 和本次原因；前两次返回仍 active 的 1/3、2/3。静态规则、续跑规则与工具说明要求每个真正受阻轮报告一次，并继续可做的独立工作；不能提示模型先等待三轮再调用，否则与后端计数叠加。
- 预算、安全阀不经这个计数器；runtime error 走 paused。

计数器为进程内小状态，不落盘，不增加审计数据库。objective 实际改变时随第 2 批 epoch 失效重置审计链，旧 run 报告不被接受；同文 no-op 不重置，也不另设 cutoff。预算用量与 goalId 保留。

### 两轴预算

删除 goal 的 tokenBudget、remainingTokens、tokenBudgetReached、tokens 工具单位和相关提示。totalTokens / cachedInputTokens 只用于查询统计。75% 的 converging 提醒只看轮次和时长。

活跃时长仍是 active 全部时间，包括让位用户队列。设置的轮次上限是准入上限：最后一个允许轮可执行，完成后若仍 active 且无法再准入，则转 blocked。时间预算则是执行中的截止约束。

预算校验与持久化在同一串行变更边界完成。不能只对 resume 串行，而让并发 SetGoalBudget 从旧快照算出覆盖值。服务层保留业务规则（包含 safetyCapTurns），store 保留唯一状态写入入口；不要在两层各维护一份并发规则。

### resume 解析与原子语义

支持无参数、单维和两维：`/goal resume`、`/goal resume 100 turns`、`/goal resume 3h`、`/goal resume 100 turns 3h`。两维可交换顺序。未指定的维度保留当前值，包括未设置状态。

命令解析和 SetGoalBudget 复用数值/单位校验，不从工具模块反向导入业务逻辑。重复维度、未知单位、缺少数值、非有限数、负数/零、非法轮次数值和超范围值应明确拒绝，不忽略尾部参数。沿用现有单次配置边界：轮次最高 1000，时间最高 24 小时。

服务在串行边界中执行：读取当前状态与用量 → 合并上限 → 检查两轴与安全阀 → 一条 update 同时写预算/active/清停因 → 触发驱动。任何检查失败都不改预算或状态。

新值是累计总额度，不是“再跑多少”。双维到顶而只给一维时，拒绝并列出另一维；提示可一次填写两维。达到安全阀则提示 cancel 后新建，不提示 replace 重置。

此检查适用于 paused、blocked，也适用于 active 上的 resume 调参，不以停因字符串决定是否检查。active 无参数且仍可运行保持幂等，仍调用幂等 ensureDriving：已有有效 driver 不重复启动，缺失则补一个。SetGoalBudget 不激活停止目标。

安全阀按 goalId 累计，不是 session 永久累计。`/goal replace`（编辑原目标）与 `CreateGoal({replace:true})`（创建新身份）必须明确区分；后者保持现有用户授权要求，不得让模型把“同一个目标到安全阀后自动重建”当作续跑办法。普通恢复入口只引导显式 cancel 后新建，不扩展为跨目标安全计数系统。

Web 沿用 Goal 面板的 resume 交互，给需要调额度的恢复增加最少的可选轮次/时长输入，并调用同一命令/服务语义；普通恢复仍可直接操作。Web composer 输入带参数的 `/goal resume ...` 时，保留完整原命令，经该受控分支的既有 `allowOverlay:true` 执行入口走后端命令解析（保留 catalog/session 校验），不进入会丢弃 rest 的无参 overlay；无参命令继续现有面板入口。错误显示具体到顶维度或非法参数，面板和文本命令使用同一后端语义。

### 时间截止与中断

GoalService 管理每个 active goal 的一个截止任务。创建、恢复、objective 实改及预算变更后，根据最新 active 用量重排；离开 active、清除或服务销毁后移除。不能只在 ensureDriving 起手安装一次。objective 实改提交后在区外按保留的累计活跃用量重排，原截止时刻不被延后；同文 no-op 不换代、无需重排。

到点后，在状态变更边界重新核对目标、生命周期与最新预算，仍到顶才进入 blocked，并中断该目标当前占有的执行。等待用户工作时也可变 blocked，但不得中断用户 run 或其子代理。

中断端口要携带或验证预期执行身份，异步等待之后再次核对，不能“先检查 owner，随后中断此刻任意 runId”。旧定时器不可覆盖新上限、误伤 resume 后的新轮或替代目标。停止时按同 goalId 的实际执行占位捕获票据，不以 mutation 资格筛掉正文实改后仍在运行的旧 epoch；子代理中断同样只针对捕获的 goal root runId，复用 `interruptByRootRun`，不得在主 run 不匹配或无票据时退回 session 全量中断。complete/blocked 的 `includePrimary:false` 也遵循此范围。轮次边界检查保留兜底。

## 2.4 完成与统计结算（决议 3、6、7、12）

完成判断仍在 UpdateGoal(complete)，不加 verifier。状态决定与 run 尾部结算分开：

1. complete 决策先持久化终态，停止后续准入，并发一次完成生命周期通知。当前主 run 可继续给出自然语言收尾。
2. 同一目标的已准入 run 结束后，把可获得的 usage 结算到该目标；待同目标的已准入票据全部结算后，再清除当前目标。若 complete 发生时没有该目标待结算的已准入 run，直接清理，不等待不存在的 driver 回调。仅“内存 complete、磁盘仍 active”等轮末的方案不采用。
3. 若该目标在结算前已被 cancel 或新目标替代，旧结算不得修改、清除新目标；不额外建立旧 goal 历史账本。
4. 重启回放到 complete 时直接完成清理，不降为 paused，不恢复驱动。崩溃前尚未取得的 usage 不追算。

complete 在 UI 投影为无当前目标；store 可暂时保留该 complete 状态，供同身份 run 结算。无需新建按 goalId 保存历史结算对象的 map：新目标创建后旧状态可被替换，迟到结算直接跳过。用户创建新目标不应被 complete 残留阻止；resume、replaceObjective、预算更新不得复活或编辑残留 complete。最终 clear 只做数据刷新，不再发第二条 cleared/completed 通知。

这有意改变了旧代码“complete 从不驻留落盘”的约定，相关 data-model 与历史说明须同步。先落 complete 比只在内存标记多一条 update，但复用既有回放 complete → clear 分支，避免已告知完成的目标在崩溃后变成 paused。仅内存 complete 同样需要防 resume/replace，并不能省掉身份与终态守卫。

轮次在准入时记；token 在 run 结束时至多结算一次。succeeded / failed / cancelled 均传回已有 usage，不因终态丢弃已知用量。未知用量不得填为“完整的零”；保留可识别的不完整性，状态查询可标为已知部分。outcome 与 settled 留在既有票据，usage 失败通过现有 session finalization recovery 显式重试，不能只“保留票据”却没有生产调用入口。成功置 settled 后才清理；clear 单独失败重试不再累计。同票据只注册一个顺序恢复闭包：先 retryFinalization 取得最终 RunCompletion，再映射真实 usage、结算及 clear；不能把待恢复合成为无 usage 的 failed 而提前 settled。每阶段成功后不重复，且注册先于释放 gate，避免新用户 run 反向覆盖恢复槽；恢复前执行准入仍受既有 recovery 阻断，不增加历史账本或后台重试循环。

缓存统计不是纯文案修改：从 RunCompletion.usage.inputBreakdown.cacheRead 经 GoalTurnOutcome → driver → store/持久记录 → GoalSnapshot → formatGoalStatusLines 传递，并保留缺失兼容。总用量与统计完整性也沿同一通道传递；不为此增加独立事件系统。

缓存命中量与总用量分列，不把 cached 再加一次当总用量，也不从总用量中扣掉后冒称总 token。无子代理归集、无账单估算。用量迟到允许更新同 goal 的 paused/blocked/complete 结算状态，但不能把状态拉回 active。

**完成通知不承诺已包含尾部统计**，其作用是告知目标完成。最终持久用量在可结算时更新；不新增完成历史界面来展示它。

## 2.5 用户插话与队列恢复（决议 8）

### 接受与分流

保留现有队列容量限制。accept 成功后才能 steer；同一 clientRequestId 的重试复用原 receipt 和分流决定。成功 steer 进入当前 run 的 protected input，不走 promptTextForModel，也不重建模型配置。自动和手动 steer 共用不重入 owner 的成功后续处理：发布最终 steered 的 prompt.updated、调用既有 onSteered、结算 completion waiter；退出 owner 后 requestDrain。只调裸 store 会漏掉这些 scheduler 责任；投影失败不得撤销已提交 receipt 或改成 queued。

有更早 queued 项时，后来的消息继续排队，不能 steer 越过它。接受顺序使用稳定的 session 顺序依据；不要以随机 UUID 作为同毫秒 FIFO 的替代。

预期竞争（关闭/封口/目标已切换）保留原项等待。真实错误保留已持久化事实并可查询，同时明确报错。不得把所有异常吞成“排队成功”。

删除普通用户输入打断 goal 的分支及其专用 helper；保留显式 stop 的中断能力。删分支后不能落进通用 throw。queued 用户工作在 goal 释放执行权之后优先 claim，不能提前占全局容量。

### 共享语义与暂停

成功 steer 的输入共享当前 goal Todo scope、reasoning、模型配置和剩余 step。UI 不承诺每条消息单独回答，也不承诺接受之后仍有工具步骤。若输入在封口后到达，则排队形成普通 run，使用普通 run 的 scope 与配置。

显式 stop/pause 与分流竞争时按受保护边界的先后顺序处理：先停止则不再 steer 进该执行；先接受的输入若尚未被处理，进入未消费提示。分流时在同一串行区核对当前 goal 为 active、目标身份及执行代号有效、run 仍可接收；complete / blocked 已落盘或目标已替换时，旧 run 即使仍在收尾，也不能接收新的自动 steer。任何未消费输入都不能自行恢复 paused/blocked。

### 未消费输入

adapter 与 SDK 去除仅 user-stop 才提示的限制。按输入与目标 run 关联展示未消费/处理未确认的事实，不能只查看“最近一个关闭 run”，否则后继 run 会覆盖提示。

用户能看到原文和显式重发动作。重发是新的用户请求，保留原项便于辨认，不静默重放 steered 内容；无法证明模型已收到时明确写“处理未确认”，不声称“从未发送”。正常完成已有的 pending/close/seal 防护继续保留。

protected inputs 仍受总上下文限制。连续大输入导致请求无法准备时，显示失败与未处理状态，不能以压缩为由丢弃输入，也不无限增加上下文。

## 2.6 注入、字段校验与 UI（决议 1、4、5、14）

### 正文和展示

GoalTurnRunner 的提交契约承接准入时生成的完整正文与简短展示文本。adapter 实时 createTextMessage 用短文本；runtime.startSession 的 prompt 用正文，displayUserText 用短文本，落库回放读 metadata.displayText。

同一个准入快照生成轮号、正文、短文本，避免出现“显示第八轮，正文还是第七轮”。会话标题源使用 objective/正文。沿用英文短提示，例如 `Goal auto-continue (turn 7)`；不新增消息 kind、system role 或国际化体系。

删除 paused 轻提示及 suppressGoalContextNote。若 promptTextForModel 删除后只剩原文透传，一并简化；原先附带的 publishGoalUpdated 刷新由明确的快照/事件路径承接，不为刷新 UI 保留文本注入 helper。普通输入不因 inactive goal 新增正文，历史和 GetGoal 返回值不受此约束。runtime model-context 保留原位置与去重行为，不能被 goal 正文抢占。

### 长度与规则

objective 保持 6000。criterion trim 后校验并存储，UTF-16 length 上限同为 6000，纯空白按未提供处理；超限返回明确的 criterion 校验错误。校验先于 create/replace 的任何状态修改，失败时原目标和记录均不变。

两字段独立封顶，不设联合预算，不自动转存文件，不截断。用户可自行把长说明放在文件中引用。每轮各注入一次，使用既有 escapeUntrustedText。

静态 Goal mode 规则不按状态切换；complete/blocked 与预算文案同时更新 constants 和 base.md，重生成 templates.generated.ts。保留合理重复，不抽通用 prompt 构造框架。

### 展示和事件

UiGoal 新增 turnsUsed、wallClockMs、可选 turnBudget，并扩 status 为 blocked。完整 budget report、tokensUsed 不进入常驻 UI 类型。CLI 简短显示状态/轮次/时长，Web chip 保持状态、面板显示数字。

使用既有 goal.updated 通道刷新快照；区分 usage 更新与 lifecycle notice，记轮和记 usage 不追加“Goal active”刷屏。初次加载、事件更新和重连快照的投影一致。

时长显示后端最近一次快照值，可在生命周期、计轮、结算和查询时刷新；本次不新增逐秒广播或前端推算计时器。paused/blocked 显示停止值。blocked 使用既有单色视觉体系中的方块/状态文字，原因在面板或查询中显示。

## 2.7 通用请求空闲看门狗（决议 2）

保护每个 llm-client request attempt，覆盖 provider 创建流的等待、首个事件和后续事件间空闲。计时只覆盖尚未完成的建流或 next 等待，不把消费者处理事件的时间算成 provider 空闲；每次新等待重新计时，结束/失败/取消时清理。所有 observer.next 路径都必须覆盖，包括首事件、usage-only 事件后的等待和主循环。

超时只取消当前 attempt 的子控制器，不 abort 代表用户取消的共享请求 signal。超时错误带可识别的重试分类；仅改 retry predicate 不足以绕过现有 user_aborted 和 partial-output 分支。当前 SDK 未必暴露 SSE 心跳，未观察到的心跳不能声称会重置看门狗。

- 看门狗超时有独立原因，不能伪装为用户取消。
- 无已提交输出且满足既有重试条件时，走已有有界重试与退避；重试耗尽后明确 failed。
- 已有部分输出、工具调用或副作用时，遵守既有重试安全策略，不无条件重放整步。
- 用户 stop、goal 截止、外部 abort 都结束请求，不因 watchdog 错误分类而自动重试。
- provider 不响应 abort、iterator.next 或 iterator.return 永不返回时，调用方仍须在有界时间内退出；清理不能成为第二个挂点。
- 超时后迟到的 resolve/reject/chunk 不得污染后继 attempt，也不能产生未处理 rejection。opening 在重试退避中返回、finally 尚未执行时也必须检查 watchdog 已过期，不能只检查 `signal.aborted || finalized`；在赋值 iterator、启动 observer/next 前隔离，迟到 iterator 仅 detach 清理。

优先复用 RequestAttemptObserver 和既有 attempt 结构，不引入 goal 特例、不把超时参数穿过每层业务端口，不新增 SDK 与应用层叠加的重试循环。

具体默认阈值及是否开放配置由对应 improve 批次在 provider 行为核查后固定；本 plan 不把 ZCode 的 600 秒直接当作本项目参数。必须区分长思考无 chunk 与真正故障，使用宽松且可测试的阈值。不要把“有界退出”误写为“所有超时都必然自动恢复”。

## 2.8 改动面与兼容

| 目录/接口 | 改动职责 |
| --- | --- |
| `packages/ohbaby-agent/src/goals/` | 状态、两轴预算、计轮/结算、恢复与截止、规则和校验 |
| `packages/ohbaby-agent/src/commands/goal.ts` | resume 单/双维解析及错误文案 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`、`goal-execution-control.ts` | 共享准入接入、执行身份、live/replay 展示、投影与通知 |
| `packages/ohbaby-agent/src/runtime/prompt-scheduler/` | accept 后分流、claim 前互斥、用户优先与稳定顺序 |
| `packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.ts` 及输入投影 | 必要的 steer 关联/未消费信息复用；不改底层并发政策 |
| `packages/ohbaby-agent/src/core/llm-client/` | attempt 空闲超时与重试/取消衔接 |
| `packages/ohbaby-sdk/src/` | UiGoal、blocked、未消费输入投影契约 |
| `packages/ohbaby-cli/src/tui/`、`apps/ohbaby-web/src/` | 轮次/时长、blocked 恢复和未消费提示 |
| `core/system-prompt/prompts/primary/base.md` 及生成物 | 模型状态枚举与预算语义 |

历史记录采用读取兼容，不改写整库：忽略旧 token 预算字段，缺缓存统计时按未知/默认兼容处理；blocked 按原值保留；active 重启降 paused；complete 清理。新写入不再产 token 预算字段。

SDK 类型、事件与 Web/CLI 是真实的协议改动，不能再宣称“无跨包影响”。对应批次应一起更新生产者、消费者与契约测试。参考 01 §1.8 同步模块文档；两份 2026-07-03 历史决策只补 superseded 说明，不删原文。

## 2.9 依赖、取舍与后续批次

后续分批时按依赖收敛：共享准入与执行身份是正确计轮、steer、旧结果保护的基础；状态/预算是 resume 与截止的基础；统计结算要与完成清理一起设计；UI 依赖投影/事件契约。请求 watchdog 相对独立，但仍要回归 goal 截止与用户取消。

2026-10-15 的分批规划据此确定五批：1 请求 watchdog；2 准入、身份、完成统计及 token 预算删除；3 blocked、审计、恢复、截止及客户端恢复；4 自动 steer 与消息恢复；5 上下文、字段和展示收尾。各批入口与验收归属见 [根 README](../README.md)。第 2 批暂用 paused 表示轮次/时间到顶，普通输入先排队、不打断；第 3、4 批分别补齐最终状态与自动 steer。不能先发布会吞 blocked 的消费者，或先删打断分支却没有新的排队准入。

| 已接受取舍 | 边界 |
| --- | --- |
| 严格用户优先可能饿住 goal | 不做轮流配额；active 等待计时，用户可暂停或调整预算 |
| displayText 保留 user role | 减少正文噪音，不承诺机器输入身份完全独立 |
| 模型可能误报 complete | 不加 verifier；保持 prompt audit |
| 同因字符串可能换说法 | 不加语义相似度模型；预算/安全阀继续兜底 |
| 崩溃可能丢尾部未报告 usage | 不伪造统计、不引入跨进程结算系统 |
| inactive 历史仍含目标 | 只删除新的自动注入，不改写既有历史 |

回滚按实际批次的接口依赖设计，不宣称所有改动可独立 revert。新增 blocked 写入后，旧版本会把它降为 paused；回滚文档必须提示这一语义变化。watchdog 可单独停用其新增包装，但不得顺带撤销现有取消/重试保护。

总体验收见 [04](./04-test-and-acceptance.md)。具体函数签名、watchdog 参数、最小测试命令和批次回滚方案在后续 improve 文档中落实，不能用这些实施细节尚未固定作为推翻已确认业务语义的理由。
