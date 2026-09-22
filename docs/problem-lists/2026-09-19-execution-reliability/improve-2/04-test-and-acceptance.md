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
| T01 | 同批无资源冲突的 A 待批、B 已获准：B 实际执行并保存/可见，A 仍未执行，模型未续轮；多个请求能独立选择回答 | scheduler+permission integration / S1 | D1,D2/P1 |
| T02 | 同一文件 read→write→read 保留冲突顺序；write 待批时后 read 不执行，也不提前做依赖文件状态的 preflight；前写改变路径时后项检查新状态。拒绝写不打乱其他冲突顺序；不同文件且无依赖的调用不被旧 write wave 挡住 | scheduler integration / S1 | D2,D17/P1,P9 |
| T03 | 消费 C 的容量及资源准入，不持槽等审批；同批 Bash 待批不阻止可独立派遣且已获准的 subagent，子代理实际工具仍受资源和来源限制；memory/subagent-control 保留适用的特殊规则 | scheduler+composition integration / S1 | D2,D18,D19/P1,P9 |
| T04 | A慢B快：B已落DB且实际事件消费者收到结果；刷新仍有B；下一模型请求直到A终态才发生，模型结果A/B原序 | 真实lifecycle+store+stream / S1 | D1/P2 |
| T05 | 参数无效、不可用、拒绝、取消、成功、普通失败、超时都恰好交付一次；迟到进度不复活终态，before/after hook次数和顺序不变；终态和正文一次提交，保存失败没有无结果的成功事件 | unit+integration / S1 | D1,D9/P2,P3 |
| T06 | 任一阶段/终态持久化失败：fatal 不被映射普通工具错误或 provider retry；无后续新工具启动或下一模型请求，同步取消先发 abort、撤销排队而不等待失败的数据库，已保存成功保留 | fault injection integration / S1 | D15/P7 |
| T07 | prepare 中途抛错、observer 抛错、Promise.all 首错：回收 controller/listener，接收其他 promise 异常，真实资源不被 finally 提前释放；慢消费者下阶段通知合并且终态一次保留，队列规模受本批调用数限制，fatal 不被队列等待卡住 | scheduler/lifecycle unit / S1 | D12,D15/P7 |
| T08 | 分别注入 SSE 断线、瞬时 SQLite busy 与耗尽既有重试后的保存失败：断线/消费慢不阻止后台，busy 按既有存储策略处理，最终失败中断且不重跑工具；投影失败不返回假健康快照，SSE 缺口走 1.1 恢复 | integration / S1,S2 | D15/P7 |
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
| T22 | 默认工具行显示执行标记与独立running计时或既有异常结果；等待不冒充执行、不累计执行秒数，取消后计时固定；正常Stop/清理静默，异常准入只走原工具结果，无专门提示；刷新延续计时，后台派遣与job时间不混用；aria/键盘/reduced-motion可用 | Web unit+browser / S4 | D3,D4/P3,P4 |
| T23 | 当前模型无正文时提示与本次时间；正文后隐藏但后台继续计时；下次请求归零；工具/审批/启动/压缩不Thinking；正文短暂停顿不恢复 | Web+model integration / S4 | D5,D6/P4,P5 |
| T24 | 最终回复或结束提示淡色总耗时一次，中间消息不显示；失败没有最终回复时仍有结束提示；刷新不重复 | Web unit+compiled / S4 | D8/P8 |
| T25 | compiled Web：真实 serve+scripted provider 跑同批无冲突审批/快慢工具、资源等待、来源限制、刷新、故障和最终时长；服务端计数、DB、UI 同时断言 | compiled Web / S4 | D1–D22 |
| T26 | 默认in-process TUI用真实composition验证独立审批/工具结果及计时语义，compiled PTY实际操作；不attach daemon，不被Web新协议破坏 | contract+compiled PTY / S4 | 第一轮拓扑 |
| T27 | 至少一个tests/models-4-tests.md真实模型，独立测试serve中复核普通工具、并发子代理工具返回、审批与最终回复；记录协议、revision和局限 | 有人值守真实E2E / S4 | 外部接线 |

前置 C08 和本轮 T17 分平台执行：Unix进程组测试在支持平台跑；Windows taskkill链路需Windows runner或明确阻塞其平台验收，不把mock结果冒充Windows真实通过。测试只杀自己创建、可识别的进程，不扫用户已有进程；结束核对无fixture存活和端口残留。

## 4.3 发布门与命令

S0 必须取得 improve-1 的 05、improve-1.1 的验收及前置 C01–C15 的实际证据，核对接口与剩余平台阻塞。本轮T01–T26对应实现均须通过，T27补真实接线证据；模型凭证不可用应标注真实E2E阻塞，不以scripted通过代替。图标/动效的精确视觉验收需后续设计决定，语义、无重复信息与可访问性本轮必须验收。

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

新增测试（如4.1候选）及LLM-client、prompt、SDK格式测试由实施者添加到定向命令与CI步骤；不允许passWithNoTests，也不能运行旧runner却声称覆盖了新场景。最终合回按仓库既有强制检查执行。本次纯文档工作不运行这些产品验收命令。

### compiled Web最小可重放场景

1. build当前实施代码；独立OHBABY_HOME、DB、日志与scripted provider，启动 `pnpm --filter ohbaby-cli start serve --port 0 --no-open`。
2. 一次模型响应发出两个同批且无资源冲突的受控工具：A待批，B已准且由测试闸门放行。确认B已经执行/入库/浏览器显示完成，但第二次模型请求计数仍为0；刷新后仍成立。批准并结束A，再断言下一模型请求及原序结果。
3. 下一轮对同一文件发出 read→write→read，write 待批时第三项不启动；另加不同文件调用证明不受旧全局写屏障影响。拒绝/批准两条变体分别验证。不能用两个不真实经过scheduler的UI mock替代。
4. 模型流先reasoning，后正文，再工具，再新模型请求；检查提示的出现/消失和时间起点。用服务端时间事实断言，不靠精确截图秒数。
5. 独立场景注入一次数据库结果保存错误，检查无续轮、已有结果保留、在途取消；再单独断开浏览器，确认后台继续并可恢复。
6. 固定短 timeout 跑专用测试子进程，验证 TERM/KILL 和清理；用可控探测注入未确认，检查来源及子代理受限、独立根会话继续，确认后恢复。不能仅 mock UI 状态。生产默认值不改；失败和取消提示仍只有一个总耗时。
7. TUI使用实际CLI默认启动、隔离环境及scripted provider，以真实按键回应审批；不要用RPC代替终端审批。实际默认入口无server连接由既有CLI bootstrap测试复核。
8. 停止自己的服务和进程，保存去凭据的执行计数、DB状态、事件、截图/PTY输出。T27另用.env凭据注入，绝不打印或保存凭据。

## 4.4 回归和验收材料

- 完整重跑第一轮权限核心场景：主/子请求刷新、双页回答、断线不撤销、终态不可批准、根范围隔离、default/full-access及外部目录规则。
- 复核 improve-1.1 的恢复/续传与前置 C 的资源、来源限制组合，不能用第一轮审批刷新代替整页一致性。
- 不改变模型tool-call/result配对顺序、缓存/native replay消息形状；新观测字段不进入provider上下文。
- 旧历史JSON缺字段仍可读；无时间显示空缺而非0s。已增加字段的记录在回滚版本中的行为需验证。
- 显式后台job保原派遣语义，default TUI保in-process，不新增跨runtime审批共享。

实施后05逐项记录T01–T27通过/失败/阻塞、命令、revision、产物及实际偏差。不得回写02为进度日志。自检不新增05-document-review等文件，规划审查不等于实施通过。

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

[前置 C01–C15](../prerequisite-follow-ups.md)独立证明文件锁真实释放、访问范围、跨会话准入、Bash 局部顺序及清理 owner。第二轮 T01–T27 使用其实际接口证明审批、保存、投影和计时组合；不能靠复制锁/清理实现让本轮测试通过。

两个主会话、父子代理、同进程不同 backend 的资源边界先由 C 验证；第二轮增加状态交付、授权过滤和刷新验证。不可读的阻塞来源只显示通用原因，不泄露其他会话的标题/命令/路径。跨进程锁和未知 Bash 任意文件隔离仍不在保证内。

## 与第四轮的后继验收

本轮 T06/T08 验证保存 fatal、原执行取消及不重放；第四轮 [T09、T38～T40](../improve-4/04-test-and-acceptance.md) 验证原 owner 保留关键事实、有限重试、恢复检查和 B 的条件领取。本轮的“不再请求模型”限定失败的原 turn；第四轮成功修复后新 Run 可正常请求。不要为通过第二轮验收提前实现第四轮恢复协调，也不能在第四轮吞掉本轮 fatal 继续原 turn。
