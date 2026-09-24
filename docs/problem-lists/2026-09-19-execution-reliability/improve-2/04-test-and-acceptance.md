# 04 测试与验收

> 后续实施的验收合同，不是本次已执行测试记录。未发现项目级 test-blueprint；沿用 colocated Vitest、现有 integration/contract、compiled Web及有人值守TUI。参考项目测试只作为设计材料，本轮未运行它们。

> 2026-09-21 已统一到确认的职责：前置 C 先独立验收资源准入和真实清理；本轮用真实接口验证审批、逐项交付、状态、计时和故障组合。以下均为待实施验收要求，不是通过记录。

## 4.1 测试方法与落点

优先可控provider、deferred Promise和fake clock控制顺序；用真实manager/store/scheduler连接验证持久化与失败传播。不要只mock一个新DTO证明UI能渲染。Shell终止必须同时有真实子进程测试，不能只断言kill函数被调用。

已有文件按需扩展：

- `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts`
- `tests/integration/core/tool-scheduler-permission.integration.test.ts`
- `tests/integration/core/lifecycle-tool-scheduler.integration.test.ts`
- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts`
- `packages/ohbaby-agent/src/tools/shell-job-registry.unit.test.ts` / `.integration.test.ts`
- `packages/ohbaby-agent/src/shell/shell.unit.test.ts`
- `apps/ohbaby-web/src/ui/App.unit.test.tsx` / `tool-card.unit.test.tsx`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

可新增聚焦的 `tests/integration/core/tool-progress-delivery.integration.test.ts`、`tests/integration/core/model-request-timing.integration.test.ts`；实现后必须能被Vitest实际收集。不要创建仅镜像实现细节的测试或新增测试框架。

## 4.2 验收矩阵

| ID | 场景及必须断言的行为 | 层次 / Stage | 追溯 |
|---|---|---|---|
| T01 | 默认权限下，同批无资源冲突的 A 待批、B 已获准：B 实际执行并保存/可见，A 仍未执行，模型未续轮；多个请求能独立选择回答。Full Access 另验首轮 D22：MCP、显式批准工具和敏感路径不产生人工 ask，明确 deny/禁止路径/命令仍拒绝，scheduler 不重开审批 | scheduler+permission integration / S1 | D1,D2、首轮 D22/P1 |
| T02 | 同一文件 read→write→read 保留冲突顺序；write 待批时后 read 不执行，也不提前做依赖文件状态的 preflight；前写改变路径时后项检查新状态。拒绝写不打乱其他冲突顺序；不同文件且无依赖的调用不被旧 write wave 挡住 | scheduler integration / S1 | D2,D17/P1,P9 |
| T03 | 消费 C 的容量及资源准入，不持槽等审批；同批 Bash 待批不阻止可独立派遣且已获准的 subagent，子代理实际工具仍受资源和来源限制；memory/subagent-control 保留适用的特殊规则 | scheduler+composition integration / S1 | D2,D18,D19/P1,P9 |
| T04 | A慢B快：B已落DB且实际事件消费者收到结果；刷新仍有B；下一模型请求直到A终态才发生，模型结果A/B原序 | 真实lifecycle+store+stream / S1 | D1/P2 |
| T05 | 参数无效、不可用、拒绝、取消、成功、普通失败、超时都恰好交付一次；迟到进度不复活终态，before/after hook次数和顺序不变；终态和正文一次提交，保存失败没有无结果的成功事件 | unit+integration / S1 | D1,D9/P2,P3 |
| T06 | 任一阶段/终态持久化失败：fatal 不被映射普通工具错误或 provider retry；无后续新工具启动或下一模型请求，同步取消先发 abort、撤销排队而不等待失败的数据库，已保存成功保留 | fault injection integration / S1 | D15/P7 |
| T07 | prepare 中途抛错、observer 抛错、Promise.all 首错：回收 controller/listener，接收其他 promise 异常，真实资源不被 finally 提前释放；慢消费者下阶段通知合并且终态一次保留，队列规模受本批调用数限制，fatal 不被队列等待卡住 | scheduler/lifecycle unit / S1 | D12,D15/P7 |
| T08 | 分别注入 SSE 断线、瞬时及持续 SQLite busy、耗尽有限重试后的保存失败：断线/消费慢不阻止后台；锁竞争下 Stop 和执行 deadline 仍可及时进入取消链路；最终保存失败中断且不重跑工具；投影失败不返回假健康快照，SSE 缺口走 1.1 恢复 | integration / S1,S2 | D15/P7 |
| T09 | 每次adapter请求有唯一requestId和真实身份；开始/首正文/结束时间顺序正确；reasoning/空delta/tool参数不触发firstTextAt；失败/取消也结束attempt | llm+lifecycle integration / S2 | D5,D6/P5 |
| T10 | 同step自动重试、压缩后重试：旧attempt结束、backoff独立、新attempt归零；既有SDK内部不可见重试不伪造记录；计时观察者保存错误不得触发模型重试；backoff中刷新不出现模型等待提示，新请求开始才重现；后台压缩不制造空白assistant消息 | integration / S2 | D6/P5,P7 |
| T11 | 在已验收 improve-1.1 上验证 snapshot/live 重建相同 tool/model 阶段；保存与发事件间刷新水位正确；迟到 start/firstText 不覆盖终态，旧 generation 不串会话；本轮不重建快照协议 | adapter+server integration / S2 | D3,D7/P3,P8 |
| T12 | 子代理请求/正文不改变父请求计时；两个run/callID可能相似仍正确隔离；不借父runId补不存在的子run ledger | inprocess contract / S2 | D3,D6/P3,P5 |
| T13 | prompt排队→审批→工具→最终流式回复：总耗时createdAt到endedAt，包含所有等待，且不叠加并行耗时；结束不得早于最终正文持久化 | prompt+lifecycle integration / S2 | D6/P8 |
| T14 | 终态prompt刷新/分页仍可关联最终回复，总时长不消失；失败/取消/中断固定endedAt；无prompt或缺时间历史不造数 | persistent-store+Web / S2 | D7,D8/P8 |
| T15 | 时长边界0/59/60/61/3599/3600/86399/86400秒；切页刷新延续；客户端时钟偏移按校准策略显示；终态不再增长 | format unit+Web / S2 | D7/P4 |
| T16 | 消费 C 的真实开始事实：审批、容量/资源/来源限制等待不计执行期限；持续 stdout 不续期、无输出不提前终止；默认值、最大值及覆盖规则不变 | scheduler+registry integration / S3 | D10,D14/P6,P9 |
| T17 | 以前置 C08 真实进程验证为基础，再贯通 Shell timeout→lifecycle→DB→UI：逻辑超时与清理进行中/已确认/未确认保存准确，正常清理不新增前端提示，TERM/KILL 和有界输出收尾不引发第二个模型结果 | shell+delivery integration / S3 | D11/P6 |
| T18 | 来源残留限制已建后，正常清理时冲突调用静默等待；清理异常实际阻塞时，已有等待者/已批准未execute/新调用均返回一次普通资源错误，execute计数为0；保护保留、独立主会话及控制入口可用；整批收齐交模型，无专门清理通知，不取消独立兄弟工具 | composition+delivery integration / S3 | D9,D22/P6,P9 |
| T19 | 两个残留乱序确认、timeout/取消竞争、迟到 close：仅更新各自清理事实，超时不改成功、不发第二结果；使用 C 的持有者验证逻辑终态/历史淘汰不丢清理 owner；持久清理投影与实时一致 | registry+delivery integration / S3 | D11,D22/P6 |
| T20 | 正常后台 Bash 派遣即返回 jobId，不占整段任务派遣槽、不触发来源限制；后台超时/取消未确认时限制来源，task_output 可看清理、task_kill 幂等；job 的后续超时不改写派遣 success、不追加模型结果；不宣称后台任意写入全程互斥 | registry+delivery integration / S3 | D11,D13,D22/P6 |
| T21 | 不合作进程内写工具逻辑超时后，同文件保护保留；正常观察期新调用等待，清理转未确认时仅尚未执行的新调用返回资源错误，不把旧写入判为未执行；不同文件可执行；fixture迟到结束只解除保护，不重放已报错调用 | controlled Promise integration / S3 | D12,D13,D19/P6,P9 |
| T22 | Web 保留现有工具卡布局、配色、展开及 CSS 主体：仅真实 executing 时工具名称有轻量 shimmer 和独立运行计时，等待、终态不扫光；异常走原结果，正常后台清理不新增通知；Stop原位反馈另验T28。刷新延续计时，后台派遣与 job 时间不混用；aria/键盘/reduced-motion 可用，减少动态效果时不播放扫光 | Web unit+browser / S4 | D3,D4,D32/P3,P4 |
| T23 | 当前模型无正文时提示与本次时间；正文后隐藏但后台继续计时；下次请求归零；工具/审批/启动/压缩不Thinking；正文短暂停顿不恢复 | Web+model integration / S4 | D5,D6/P4,P5 |
| T24 | 最终回复或结束提示淡色总耗时一次，中间消息不显示；失败没有最终回复时仍有结束提示；刷新不重复 | Web unit+compiled / S4 | D8/P8 |
| T25 | compiled Web：真实 serve+scripted provider 跑同批无冲突审批/快慢工具、资源等待、来源限制、刷新、故障和最终时长；服务端计数、DB、UI 同时断言 | compiled Web / S4 | D1–D35 |
| T26 | 默认 in-process TUI 用真实 composition 验证独立审批/工具结果及计时语义；只有后端确认真正 executing 时才转动并显示运行秒数，pending/审批/资源或容量等待均不转、不累计，终态立即固定。compiled PTY 实际操作并检查既有禁用动效设置；不 attach daemon，不被 Web 新协议破坏 | contract+compiled PTY / S4 | D32、第一轮拓扑 |
| T27 | 至少一个tests/models-4-tests.md真实模型，独立测试serve中复核普通工具、并发子代理工具返回、审批与最终回复；记录协议、revision和局限 | 有人值守真实E2E / S4 | 外部接线 |
| T28 | 现有Stop按钮点击即原位等待且重复点击不再发送；绑定原run，以可靠终态结束等待，accepted/RPC成功不冒充停止；终态先于RPC也结束等待，不等残留清理；错误/断线、自然完成竞争及旧run迟到回执按下述D34补充验证 | Web unit+真实接口+compiled Web / S4 | D34/P10 |

前置 C08 和本轮 T17 分平台执行：Unix进程组测试在支持平台跑；Windows taskkill链路需Windows runner或明确阻塞其平台验收，不把mock结果冒充Windows真实通过。测试只杀自己创建、可识别的进程，不扫用户已有进程；结束核对无fixture存活和端口残留。

D34补充（T28）：分别控制RPC回执、可靠终态和物理清理三个闸门。点击后立即有可访问的等待含义；可靠终态到达前不能只因收到accepted、过了1秒或本地计时器触发而宣告停止。主任务及必要登记已完成、残留清理仍未确认时结束按钮等待，旧资源保护继续有效。可靠终态先到、RPC后到也正常结束；自然完成抢先时保留成功。A的迟到成功/失败/终态不能清除B的pending、影响另一个会话或覆盖已确认终态。没有可靠终态时请求失败要退出本地转圈并用既有错误提示；断线不能假报已停，恢复后按1.1同源状态重建，不自动重发Stop。等待中可编辑草稿；reduced-motion保留静态等待含义。长等待文案用实现选定阈值及假时钟验证，不把该值或按钮完成耗时冻结为产品期限。不新增底部状态栏。TUI只回归原取消入口，不要求新增按钮。

开始与保存的交错补充（T06/T08/T09/T16）：一组延迟invoke前的必要保存，此时Stop后execute/provider计数为0、无虚构开始时间；另一组让操作已实际开始、开始事实保存尚未完成，再Stop或让保存失败，取消仍能立即传递、原Promise异常有人接收、终态按序处理。覆盖工具及惰性adapter请求，开始/首正文/结束均采集事实时刻，不以写库完成计时。T03另延迟终态保存，验证逻辑结算及清理交接后普通名额已归还；fatal一经发现，即使有空槽也不能再开始本轮新调用。

清理持久化竞争补充（T19）：分别让cleanup确认先于、后于工具终态提交，并在批次通知队列结束后再确认一次。最终phase/outcome/结果正文不变、cleanup不倒退，实时/刷新一致，模型结果和名额各只结算一次；不能用旧整份metadata覆盖新清理事实。

D31补充：T18验证交给模型的普通错误正文包含“新调用未执行、旧操作停止未确认、保护保留”及不循环重试/轮询/kill的指引；有权限且存在真实job时提供可用job_id，无权限/无job时不泄露身份也不编造控制指令。模拟模型再次请求同资源或改用Bash，后端仍按真实访问范围阻止冲突执行，无冲突调用继续；不以“模型会听从提示”代替此确定性验证。真实模型E2E观察其是否先完成可继续的工作、受阻时说明原因，记录偏差，不把一次正常表现宣称为所有模型行为保证。

D30补充：T17/T18/T21消费前置C.6的可注入观察预算，验证Bash200ms升级、强杀后1000ms及其他工具取消后1000ms到期转未确认；实际冲突项得到一次未执行错误，资源保护仍在，原工具不延长执行计时、不再次归还名额。提前真实结束可立即确认，明确失败可提前判未确认，查询/新等待者不重置观察期限。真实进程验证终止行为，受控时钟验证时间边界，不把同步事件循环下的计时器当成硬实时保证。

D29补充：在T03/T17/T19–T21中消费前置C.4.1的真实名额接口，验证每会话默认10且相互独立。满额时一个不合作工具超时，清理owner/必要保护建立后名额归还，无冲突等待项可继续而同文件/来源冲突项仍受保护；正常后台派遣在登记job并形成jobId结果后归还，job继续存活。迟到完成和重复取消均不二次还槽、不二次交付；T06继续验证fatal置位后空槽也不能启动新调用。这里只验证与交付/保存的接线，计数、保护及清理的独立正确性由C06/C10–C12验收，不复制实现。

T08 另用测试自己创建的独立 SQLite 连接持有写事务，连接到真实 `serve`，分别记录**本地测试客户端发出 Stop 的时刻**、服务器 handler 实际开始、Stop 被接受并发出取消信号、Stop RPC回复、执行 deadline 回调及清理开始的时间。事件循环被堵时 handler 可能根本进不来，所以从客户端发出请求开始计算，不能只从 handler 入口算。按 D33，锁竞争下须在 1 秒内受理 Stop 并发出取消信号；这不要求数据库关键登记或进程退出在 1 秒内完成，真实退出仍按前置 C 的清理预算。分别覆盖消息、run-ledger、prompt、session 的重试事务和 snapshot/workspace-registry 的直接 BEGIN 入口；降 busy_timeout 后另测正常短暂争用，不能用“Stop 变快但结果频繁保存失败”冒充修复。[2026-09-23诊断](../evidence/2026-09-23-sqlite-stop-contention.md)已用真实serve得到可变红场景：前置写入等锁使假模型流关闭观察点晚于1秒；只有锁时取消观察点可及时出现但RPC仍晚回复。该观察点不是内部AbortSignal的精确时刻，正式T08须定点记录；现有诊断也未覆盖所有写入口或改造后的保存回归。若超预算不能只记下数字就算通过，需按 02 §2.7 的最小候选修复再测；保存失败仍 fatal、不重跑工具。不能用异步 mock 的及时取消证明同步驱动同样及时。T07 同时验证合并后的终态不会被迟到旧阶段通知覆盖。

T08将Stop与deadline拆成独立场景：Stop场景把执行期限放到观察窗口之外；deadline场景不发送Stop，单独验证固定期限触发取消。先由独立持锁进程确认锁已持有，并通过被测写入口的观测闸门确认确实进入争用，再开始对应测量；不用任意sleep猜时序。真实时间测serve响应，fake clock仅用于纯逻辑时间边界。RPC、关键登记和按钮耗时分别记录，不以超过1秒单独判它们失败，也不把它们的完成时间替代取消信号时间。

## 4.3 发布门与命令

S0 必须取得 improve-1 的 05、improve-1.1 的验收及前置 C01–C15 的实际证据，核对接口与剩余平台阻塞。本轮T01–T26和T28对应实现均须通过，T27补真实接线证据；模型凭证不可用应标注真实E2E阻塞，不以scripted通过代替。TUI/Web 的动效适用阶段及 Web 卡片结构已按 D32 确认；扫光强弱在 S4 实际界面验收，语义、无重复信息与可访问性本轮必须通过。

定向基础命令（已有文件）：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts tests/integration/core/tool-scheduler-permission.integration.test.ts tests/integration/core/lifecycle-tool-scheduler.integration.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/tools/shell-job-registry.unit.test.ts packages/ohbaby-agent/src/tools/shell-job-registry.integration.test.ts packages/ohbaby-agent/src/shell/shell.unit.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx apps/ohbaby-web/src/ui/tool-card.unit.test.tsx
pnpm run typecheck
pnpm run lint
pnpm run test:e2e:compiled-web
```

新增测试（如4.1候选）及LLM-client、prompt、SDK格式测试由实施者添加到定向命令与CI步骤；不允许passWithNoTests，也不能运行旧runner却声称覆盖了新场景。最终合回按仓库既有强制检查执行。本次已构建当前CLI并跑诊断专用真实serve复现；尚未实施本轮产品改造，也未运行或通过T01–T28的完整产品验收命令。

### compiled Web最小可重放场景

1. build当前实施代码；独立OHBABY_HOME、DB、日志与scripted provider，启动 `pnpm --filter ohbaby-cli start serve --port 0 --no-open`。
2. 一次模型响应发出两个同批且无资源冲突的受控工具：A待批，B已准且由测试闸门放行。确认B已经执行/入库/浏览器显示完成，但第二次模型请求计数仍为0；刷新后仍成立。批准并结束A，再断言下一模型请求及原序结果。
3. 下一轮对同一文件发出 read→write→read，write 待批时第三项不启动；另加不同文件调用证明不受旧全局写屏障影响。拒绝/批准两条变体分别验证。不能用两个不真实经过scheduler的UI mock替代。
4. 模型流先reasoning，后正文，再工具，再新模型请求；检查提示的出现/消失和时间起点。用服务端时间事实断言，不靠精确截图秒数。
5. 独立场景注入一次数据库结果保存错误，检查无续轮、已有结果保留、在途取消；再单独断开浏览器，确认后台继续并可恢复。
6. 固定短 timeout 跑专用测试子进程，验证 TERM/KILL 和清理；用可控探测注入未确认，检查来源及子代理受限、独立根会话继续，确认后恢复。不能仅 mock UI 状态。生产默认值不改；失败和取消提示仍只有一个总耗时。
7. TUI使用实际CLI默认启动、隔离环境及scripted provider，以真实按键回应审批；不要用RPC代替终端审批。实际默认入口无server连接由既有CLI bootstrap测试复核。
8. 在浏览器点击真实Stop，控制回执、可靠终态及清理的先后，完成T28的主要路径；完整旧任务树与下一queued交接仍由第四轮组合验收。
9. 停止自己的服务和进程，保存去凭据的执行计数、DB状态、事件、截图/PTY输出。T27另用.env凭据注入，绝不打印或保存凭据。

## 4.4 回归和验收材料

- 完整重跑第一轮权限核心场景：主/子请求刷新、双页回答、断线不撤销、终态不可批准、根范围隔离、default/full-access及外部目录规则；Full Access 依据第一轮 D22 包括 MCP 免人工审批，明确 deny 仍生效。
- 复核 improve-1.1 的恢复/续传与前置 C 的资源、来源限制组合，不能用第一轮审批刷新代替整页一致性。
- 不改变模型tool-call/result配对顺序、缓存/native replay消息形状；新观测字段不进入provider上下文。
- 旧历史JSON缺字段仍可读；无时间显示空缺而非0s。已增加字段的记录在回滚版本中的行为需验证。
- 显式后台job保原派遣语义，default TUI保in-process，不新增跨runtime审批共享。

实施后05逐项记录T01–T28通过/失败/阻塞、命令、revision、产物及实际偏差。不得回写02为进度日志。自检不新增05-document-review等文件，规划审查不等于实施通过。

## 4.5 对抗性重点

| 最可能的失败 | 测试防线 | 诚实保留的限制 |
|---|---|---|
| 异步observer失败被bus/catch吞掉 | T06–T08/T10 | 数据库全坏时不能保证终态已落盘，只能尽力通知和取消 |
| 放开全局写屏障时丢失同目标顺序 | C02–C07 + T02–T03 | 本轮消费 C 的共享资源保护，不新建第二套锁 |
| timed_out后提前释放真实副作用 | T17–T21 | 无法确认的进程内操作仍占有资源；受影响新调用按T21返回普通错误，不提前放锁或自动重放 |
| 旧模型请求/子代理事件重置父计时 | T09–T12/T23 | provider内部隐藏重试不宣称可观测 |
| 刷新拿到旧事实、新序号 | T11/T14/T25 | improve-1.1 整页一致性必须先实际通过 |
| 后台 job 被误改成长占写槽，或来源限制误伤所有会话 | C10–C12 + T18–T20 | 独立主会话继续不等于与未知 Bash 副作用隔离 |

## 4.6 前置与本轮验收分工

[前置 C01–C15](../prerequisite-follow-ups.md)独立证明文件锁真实释放、访问范围、跨会话准入、Bash 局部顺序及清理 owner。第二轮 T01–T28 使用其实际接口证明审批、保存、投影和计时组合；不能靠复制锁/清理实现让本轮测试通过。

两个主会话、父子代理、同进程不同 backend 的资源边界先由 C 验证；第二轮增加状态交付、授权过滤和刷新验证。不可读的阻塞来源只显示通用原因，不泄露其他会话的标题/命令/路径。跨进程锁和未知 Bash 任意文件隔离仍不在保证内。

## 与第四轮的后继验收

本轮 T06/T08 验证保存 fatal、原执行取消及不重放；第四轮 [T09、T38～T40](../improve-4/04-test-and-acceptance.md) 验证原 owner 保留关键事实、有限重试、恢复检查和 B 的条件领取。本轮的“不再请求模型”限定失败的原 turn；第四轮成功修复后新 Run 可正常请求。不要为通过第二轮验收提前实现第四轮恢复协调，也不能在第四轮吞掉本轮 fatal 继续原 turn。
