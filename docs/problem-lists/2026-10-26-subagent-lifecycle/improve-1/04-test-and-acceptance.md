# 4. 测试与验收

> 本文是后续实施验收要求，不是已通过的测试报告。本次只写规划文档，没有运行下列测试。
> 对照 [02](02-optimization-plan-and-change-scope.md) 的 S1–S4，沿用仓库现有 unit / contract / integration / smoke / compiled Web E2E 分层，不新建一套测试政策。

## 4.1 风险与测试方法

这次改造的风险主要在真实执行归属、异步清理、请求输入边界和跨层 UI 投影，不能只断言状态字段变了。

- 容量与竞态用受控 Promise、可控启动/清理闸门；监督用 fake clock，不真实等待 2/5 分钟，不靠 sleep 猜顺序。
- 存储与恢复用临时 SQLite 和实际 store；模型调用使用可计数的受控 provider，验证请求内容、执行数量及确认时机。
- shell 相关用可控子进程和现有 confirmed/unconfirmed 测试能力。真实进程测试必须由测试宿主设置外部超时、独立回收，不能把被测清理当唯一兜底。
- 工具契约测试经过实际 schema/动作校验和调度，而不是直接调用私有方法绕过工具容量、权限或 provider catalog。
- Web 测试验证真实列表、reader 和路由语义；保留现有分页、迟到事件、revision 和阅读缓存测试，只重写已经被新需求替代的浮层断言。

已有规范可参考 [agents/test.md](../../../agents/test.md)、[Web 测试规范](../../../ohbaby-web/test.md)、[Web 改版验收](../../../ohbaby-web/redesign-2026-10/08-test-and-acceptance.md)。其中历史示例和旧停止/布局语义与本轮冲突时，使用 00/02 的明确替代规则，不把已废弃字段重新加回实现。

## 4.2 S1：执行、名额与控制

| ID | 场景 | 必须观察到的结果 | 主要层级 |
| --- | --- | --- | --- |
| A01 | 同一主会话同时启动混合前后台执行，并将异步创建卡住 | 前六个在 await 前占位；第七个立即明确未启动；没有容量队列；主代理不计数；另一主会话独立 | unit + integration |
| A02 | 一轮多个 spawn、相同请求重试、创建/绑定/持久化失败；预占后尚未创建完成就 stop/close | 每个调用独立成功或失败；允许部分成功；成功项不回滚；同一请求不重复执行或占位；失败部分资源清完后归还；先停止/关闭不被迟到创建结果重新启动 | contract + integration |
| A03 | 执行终态已写但 shell/工具仍在清理 | 仍占名额；不允许借空缺启动第七个；清理确认后只归还一次；stop/monitor 控制通道仍可使用 | integration |
| A04 | 重复 stop/close、超时和晚到成功交错；清理 unconfirmed | 复用同次清理，终态不倒退；不重复 kill/release；未确认时如实报错并保留资源归属，迟到 confirmed 自动只还一次、无需再次控制调用，且不释放新执行的 lease；无退出证据不强行归还 | unit + integration |
| A05 | 主正常结束或用户 Stop 后后台继续开 shell、读文件 | 后台模型与工具继续；不会因旧 root seal 被拒；审批仍可处理；新主轮次不回收旧后台名额 | integration，包含受管 shell |
| A06 | 主 Stop 时同时存在前台和后台；单独 UI/tool stop 某个 child | 主 Stop 只结束本轮前台及主执行；后台继续；前台中断不唤醒主；单子停止不向上停止主或误伤兄弟 | integration |
| A07 | 运行中 send，当前请求受控暂停，然后允许进入下一请求 | 同一 execution 的下一模型请求收到消息；不 abort 当前请求、不改变 mode、不另占名额、不另建 execution | contract + integration |
| A08 | send 与执行结束或 stop 交错；只剩一个名额时两条 send 同时命中同一空闲实例 | 已受理消息不丢失；执行结束后的发送按新执行申请；显式 stop 后未消费消息不暗中开新 execution；“受理后、组装请求前 Stop，再显式 send”能有来源地带回未消费消息且不重复；启动中的第二条 send 归入同次执行，不双占或隐藏排队 | integration |
| A09 | 完成/中断后 send，分别省略 mode 或指定 foreground | 复用同一 agent ID 与保存上下文；新 execution 重新申请名额；默认后台立即受理，前台等待结果；满额未启动 | contract + integration |
| A10 | close 活跃/空闲实例、重启后使用旧 ID | 自然完成后仍可 list/send，不自动 close；明确关闭后无可运行控制入口，list 隐藏、send 不重建，历史保留；重复 close 幂等；可另行 spawn 新 ID，停止后的实例仍与 closed 区分 | integration + persistence |
| A11 | 六 action 的 schema、调度、角色授权和 metadata | 无效/不适用字段拒绝；list/monitor 只读；stop/close 不排在 foreground 执行名额后；原禁用派遣的角色不能因统一名称绕过限制；默认模式各层一致；提示词包含按需关闭换新规则，无固定轮数自动关闭要求 | contract |

## 4.3 S2：结果、读取、监督和恢复

| ID | 场景 | 必须观察到的结果 | 主要层级 |
| --- | --- | --- | --- |
| A12 | 原主轮次结束，后台结果到达；主空闲或正在处理新用户消息 | 空闲经过同一执行门启动一轮；忙碌进入下一模型请求；包含原任务来源；不强行打断、不产生第二个并发主执行 | integration |
| A13 | 结果/用户输入/监督同时到达，或恰逢主执行收尾 | 活动主执行最多一个；待交付结果不随旧 run 输入关闭丢失；多个结果可同次请求处理 | integration，受控竞态 |
| A14 | 结果输入请求失败、被中断、事件重复或终态通知漏发 | 成功请求才确认；稳定 source 防重复消费；未处理内容保留，但同一结果已唤醒的主轮次失败/被停后不反复自动开新轮；既有事实核对可发现未触发过的漏事件，不靠 monitor 才交付 | integration + persistence |
| A15 | foreground 完成；主动 stop/close；后台自然失败/超时 | 前台只经工具结果交付，不重复后台唤醒；取消控制回执不触发反弹轮次；后台自然失败/超时作为结果交付 | integration |
| A16 | monitor 一个/多个运行、完成、中断、closed 的目标 | 立即读取保存内容；模型调用数、订阅数、状态写入数、结果确认数均为零；已关闭历史可读但不恢复运行 | contract + integration |
| A17 | monitor 长输出、多目标、游标、非法或跨会话 ID | 遵守每目标/总输出预算；截断可识别、有续读方式；单目标错误不抹掉其他结果；跨会话记录不可见 | unit + contract |
| A18 | 主代理先工作很久，然后结束当前轮，仍有后台运行 | 从此次 idle 开始算 2 分钟，spawn 时间不影响；监督处理结束后从新 idle 算 5 分钟；普通进度不延后到期 | unit，fake clock |
| A19 | 用户 Stop 后 timer 到期，再有真实后台结果或新用户输入 | timer 不启动主代理；结果/用户输入仍可启动；之后正常空闲重新计时；迟到 timer 不能越过最新 Stop | integration，fake clock |
| A20 | 主忙碌、所有后台结束、全部等审批 | 忙碌不积压监督轮次；没有后台则不再唤醒；纯审批阻塞不反复模型复述；执行预算/清理仍由程序检查 | unit + integration |
| A21 | Goal 有独立工作，或只剩后台工作；用户 Stop/预算终止 | 有独立工作沿用 Goal 推进；只等后台不连续空转；Stop 不被旁路恢复；预算/整体终止按实际 Goal 归属处理跨轮子执行 | integration |
| A22 | 服务退出、会话销毁、异常 owner 恢复、后台结果持久化失败 | 所属资源被正确收尾；运行名额与实际 owner 一致；主 run completed 不被误当作后台已死；历史 closed 不复活；错误不只发给已经结束的 root | integration + persistence |
| A23 | 新会话模型配置与历史工具/运行时消息 | 结果唤醒沿用当前主会话配置入口；旧历史能读；内部 subagent-status 不被当可调用工具；新 catalog 不再出现旧工具 | contract + integration |

## 4.4 S3：右侧栏、实例投影与阅读

| ID | 场景 | 必须观察到的结果 | 主要层级 |
| --- | --- | --- | --- |
| A24 | 第一次展开右侧栏、添加/关闭 Tab、收起再展开 | 默认入口页；Subagents 是独立 Tab；只提供本批可用入口；恢复已开页面；没有不可用的文档/Review/浏览器/终端页 | Web component + compiled E2E |
| A25 | spawn/空闲 send 成功或失败，运行中 send | 原 agent 输入/输出仍能查看；实际启动才显示“xx 子代理启动”；投递消息不假报新启动；失败/满额没有成功链接 | Web component + contract |
| A26 | 点击主消息启动链接，再返回列表、切换实例 | 自动展开右侧并直达对应子会话；同一 Tab 返回列表和选择；主会话输入/审批可继续用；主空闲也可直接停止子执行，迟到停止不误伤后续 execution；旧浮层/展开覆盖行为消失 | Web integration + compiled E2E |
| A27 | 同一 agent 多次 send，跨多个主 turn；保留超过 50 个实例；列表刷新失败 | 完整列表仍是一实例一行，不丢旧实例；失败刷新不清空；Active/Done 派生且带真实状态；中断/失败位于 Done 但不显示成功；等待审批和清理归 Active；core enum 不新增 Active/Done | SDK contract + Web integration |
| A28 | 在旧 execution 启动链接进入一个已续跑实例 | 阅读定位到历史锚点，标题与列表显示当前状态；实时新消息可见，不被旧 Queued/Completed 事件覆盖 | SDK integration + Web integration |
| A29 | close 当前正在查看的实例，以及已完成无新 execution 事件的实例 | 列表移除、详情退出、专用启动入口撤下；Web 不再读取该 child 历史；普通主工具记录保留；不会因旧列表 merge 再出现 | server/SDK/Web integration |
| A30 | 关闭 Subagents Tab、折叠侧栏、切换主会话 | 只取消读取；子执行继续、结果仍交付；旧 watch/迟到响应不污染新会话；重新打开读到真实状态 | SDK integration + compiled E2E |
| A31 | 长会话分页、重连、工具展开、滚动位置与窄屏键盘操作 | 保留现有阅读能力；列表返回/详情切换不丢对应阅读位置；无旧模态焦点锁，能回到主会话；布局不改变后端执行 | Web/SDK integration + 人工检查 |
| A32 | 历史 subagent_run、CLI execution reader、审批布局 | 旧记录仍有正确展示；可用旧实例入口可定位新右栏；closed 入口不可用；CLI reader 与共用审批样式不被误删 | regression + smoke |

## 4.5 复用的测试骨架

优先扩展下列测试族，不为本轮另造一整套测试目录：

- `packages/ohbaby-agent/src/agents/subagent-host.unit.test.ts`、`subagent-execution.integration.test.ts`：请求去重、关闭竞争、settling turn、启动与复用。
- `packages/ohbaby-agent/src/agents/subagents/{execution-store,database-store}.integration.test.ts`：持久化、首次终态、重复交付和历史。
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`、`tools/shell-job-cleanup.unit.test.ts`：等待清理、兄弟 scope 隔离、unconfirmed 与幂等回收。
- `packages/ohbaby-agent/src/agents/subagents/continuation-coordinator.unit.test.ts`、`runtime/prompt-scheduler/current-run-inputs.integration.test.ts`、`adapters/session-execution.integration.test.ts`：请求确认、timer、门与结果交付。
- `packages/ohbaby-agent/src/adapters/goal-*.test.ts` 与 `goals/driver.unit.test.ts`：Goal 等待与中断，按仓库实际文件选择运行。
- `packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-*.integration.test.ts`、SDK readers 的现有测试：实例投影、历史、watch 和分页。
- Web `DelegationRow.unit.test.ts`、Session 相关测试及现有 compiled Web E2E：原工具输出、右侧导航、删除旧浮层行为。旧 `subagent-layout` 几何组件若已无使用者，其专属测试随删除；不是保留无用实现以满足旧断言。

新 execution lease 的测试可与 Host 共置或在小模块旁新增；以可观察的活跃执行数和资源回收验证，不写仅复述函数实现的测试。

## 4.6 执行检查与发布门槛

实施中先运行受影响的定向测试。例如：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/agents/subagent-host.unit.test.ts packages/ohbaby-agent/src/agents/subagent-execution.integration.test.ts packages/ohbaby-agent/src/agents/subagents/execution-store.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/tools/shell-job-cleanup.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-views.integration.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-conversation-history.integration.test.ts
```

整批发布前，按现有脚本完成 `pnpm typecheck`、`pnpm lint`、受影响的 unit/contract/integration 与 `pnpm test:smoke`，并执行 `pnpm test:e2e:compiled-web` 验证编译后的真实入口。该脚本包含 build，不必为了相同事实额外重复构建。新增或重命名测试文件时相应调整定向命令。

发布要求：

1. A01–A32 均有对应证据，失败项解决或明确不能发布；不以“模型偶尔这样回答”替代后端保证。
2. 六个名额按实际执行持有，主停止不破坏后台 shell，取消尚未清完时不会超卖。
3. 请求失败/中断不丢结果；结果、用户消息、timer 不造成两个主执行；所有工作完成后不再自动空转。
4. monitor 纯读取，close 不可复用且 UI 不见；保存历史仍符合主模型只读规则。
5. 工具、服务端协议、SDK、Web、提示词和权威文档一致；新旧 viewer 不并存。
6. 人工走查宽屏/窄屏：工具输出 → 启动入口 → 右侧详情 → 返回 Active/Done 列表 → 切换代理 → 主会话继续输入；关 Tab 后子代理继续；关闭实例后消失。

真实付费模型 E2E 不是验证调度/清理契约的前置条件。需要验证某提供方 schema 行为时，实施阶段再按该目的安排最小检查，并如实区分未跑、通过和失败。不要把本规划文档写成测试已经通过。

## 4.7 对抗性复查

验收时专门检查以下五个跨层接缝，而不是只重跑快乐路径：

1. **最后一个名额竞争：** 两个 spawn 同时看到剩一个名额，失败者绝不能偷偷排队；已成功者不能被整批回滚。
2. **停止与物理退出分离：** UI 已显示中断，但受管命令未退出；新任务不能抢到该名额，控制接口也不能卡死。
3. **结果到达与主收尾交叉：** 下一模型请求尚未建立，旧 run 正关闭；结果仍能被下一轮消费且不会重复启动主执行。
4. **用户 Stop 与旧 timer 交叉：** 旧回调晚到不能唤醒；随后真实结果到达仍能唤醒，不能把两种事件共用一个“全部禁止”开关。
5. **关闭与历史投影分离：** 持久历史存在，但旧列表缓存/旧主消息链接不能让 UI 重新显示 closed；monitor 也不能因读历史而重建控制实例。

实施完成后再创建 `05-implementation-acceptance.md`，记录代码版本、实际测试命令/结果、实现偏差与复查结论。本轮不提前创建空的“验收通过”文件。
