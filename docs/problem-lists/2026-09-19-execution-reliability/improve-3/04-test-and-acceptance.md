# 4. 测试与验收标准

> 这是后续实施验收契约，不是测试执行结果。本次只做方案审查和独立请求探针；实测范围见文末证据链接，不代表本矩阵已执行。前两轮与独立前置修复须先提供实际验收证据，第三轮按实际基线复核。

## 4.1 测试分工

沿仓库现有 Vitest unit/contract/integration 和 compiled Web、真实模型 E2E 分类，不另创通用测试体系。未发现独立命名的 `docs/test-blueprint.md`，沿 package scripts 和前两轮测试口径。

- unit：受控 Promise/时钟验证等待、幂等、预算、状态转换；不靠 sleep 猜竞态。
- contract：SDK/backend/REST/JSON-RPC/in-process 同语义、能力不支持与结构化错误、快照和事件兼容。
- integration：真实 SQLite、storage、host、lifecycle、prompt-scheduler、permission/sandbox；故障点在真实事务或读写边界注入。
- compiled Web/PTY：构建后的真实入口，scripted provider 可重放；浏览器/终端、事件、DB 同时断言。
- real E2E：按 `tests/models-4-tests.md` 使用至少一个真实测试模型；凭据从环境注入，不写入记录。验证自然语言任务下实际调用和等待行为，不取代确定性竞态测试。

候选新增测试可以分别放在 host 的 execution-result integration、runtime run-input integration、lifecycle continuation integration、prompt-scheduler Steer integration 及 Web compiled 场景；名称由实施时按实际模块定，不能为文档杜撰已存在文件。

## 4.2 场景矩阵

| ID  | 场景与必须断言                                                                                                                                                                                     | 层/Stage                                         | 对应问题 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------- |
| T01 | 本会话历史子代理可查询；新任务只等待本任务 execution，昨日未交付结果不混入                                                                                                                         | DB+host/S1                                       | P4       |
| T02 | background accepted 后立刻有归属，即使未获容量/同实例排队仍计入待办；重复请求不多建                                                                                                                | host+DB/S1                                       | P1/P4    |
| T03 | 同一实例继续两次保留不同正文、run/execution 和路径；同 session 不同 scope 不串结果；历史短结果在新任务中经 status 定位、懒导出后可 Read                                                            | DB+artifact/S1                                   | P4/P6    |
| T04 | 短结果原文全量交付；长结果只有稳定入口/大小/身份，无截断预览；中文及阈值边界按最终确定的计数口径                                                                                                   | unit+integration/S1                              | P1/P6    |
| T05 | 结果保存成功先于通知；文件 ready 先于发布路径；重复 completed/error/abort 最多生成一个终态交付                                                                                                     | 故障注入/S1                                      | P1       |
| T06 | DB 失败不能发布成功或续模型；文件写失败有明确交付错误、原文保留、无假路径、无永久等待                                                                                                              | integration/S1                                   | P1/P6    |
| T07 | 前台结果通过工具交付后不再重复自动注入；后台只返回 accepted                                                                                                                                        | host+lifecycle/S1/S3                             | P1       |
| T08 | 同父会话历史结果可读；其他会话、伪造ID、路径越界/链接目标、直接写结果目录被拒绝；显式 deny/ask 保留                                                                                                | permission+lease/S1                              | P6       |
| T09 | 会话删除清理与撤权；归档/切页不清理；删除和迟到导出竞争不留下可访问产物；同实例新结果不误删                                                                                                        | storage+session/S1/S4                            | P6       |
| T10 | 普通 Send 在当前任务等待时仍 queued，不进入当前模型输入；原任务终态后推进一次                                                                                                                      | scheduler/S2                                     | P3       |
| T11 | Steer 原子迁移且保留原 userMessageId；当前任务收到一次，下一任务不再执行这条                                                                                                                       | DB+scheduler/S2                                  | P3       |
| T12 | Steer 与结束/claim/edit/delete 竞争只有一个接受；旧 expectedRunId 不自动改投新run                                                                                                                  | contract+integration/S2                          | P3       |
| T13 | Steer 重复点击、响应丢失再试，receipt 幂等；已接受后父失败保留事实、不自动重新排队                                                                                                                 | contract/S2                                      | P3       |
| T14 | 派出 A 后仍能派 B/C 或做独立工具工作，没有立即阻塞父模型                                                                                                                                           | lifecycle/S3                                     | P2       |
| T15 | 模型不调用任何等待/status 工具，输出结束后仍保持主任务；单次等待未到期且无事件时请求数恒定，到期自动携有限事实恢复模型，无 busy loop                                                               | fake model+controlled clock/S3                   | P2/P9    |
| T16 | A先完成，B/C继续：A正文进入父下一步，可汇报/安排后续；无需等B/C全部完成                                                                                                                            | host+lifecycle/S3                                | P1/P2    |
| T17 | 已完成事件先于等待订阅、检查后紧接完成、多个同时完成，均不丢醒/重复正文                                                                                                                            | deterministic race/S3                            | P1/P2    |
| T18 | 等待时Steer唤醒；模型/工具忙时Steer保留到安全边界；不启动第二父循环、不修改在途请求                                                                                                                | integration/S2/S3                                | P2/P3    |
| T19 | 子结果到达同wave工具执行中：UI可更新，父模型仍等批次保存完整后消费，工具配对/顺序不破坏                                                                                                            | improve-2联测/S3                                 | P8       |
| T20 | 所有子执行已终态但还有未交付/未进入后续模型步骤的结果，不能先正常结束                                                                                                                              | finalization race/S3                             | P1/P2    |
| T21 | Stop在等待/接收/终态竞争中均退出；监听清理；迟到通知不调用模型、不落到下一任务                                                                                                                     | integration/S3                                   | P2/P3    |
| T22 | provider失败、length/filter、硬预算/最大步数不被continuation变成无限续写；等待不重置预算                                                                                                           | lifecycle/S3                                     | P2/P8    |
| T23 | 保持子代理不能调用subagent_run/status/close；后台父等待不占住子执行必须的容量或输入锁，不释放在途写入保护，不新增嵌套调度                                                                          | host+scheduler/S3                                | P2/P8    |
| T24 | 按后续定稿的批量策略验收超量结果，不静默丢失；单条放不下有完整文件入口；压缩后仍能定位待处理结果                                                                                                   | context integration/S3                           | P1/P6    |
| T25 | 故障发生在“待交付→持久输入→下一模型步”各边界，既不提前标记已处理，也不重复创建上下文输入                                                                                                           | DB+lifecycle/S3                                  | P1       |
| T26 | 重启保留结果与归属，按既有规则中断；不自动新开用户任务/重放副作用，不把旧通知投给新run                                                                                                             | recovery regression/S3                           | P4/P8    |
| T27 | 子树有当前/历史状态，子过程按scope分页只读，无用户单独停止/关闭/重启入口；伪造子会话prompt/Steer/取消请求由服务端拒绝，主代理经合法工具继续/关闭仍可用，根任务Stop不受影响                         | SDK+Web+backend/S4                               | P5       |
| T28 | 子审批只在根可答，保真实来源；子事件不重置父请求计时；等待状态不是Thinking                                                                                                                         | improve-1/2联测/S4                               | P5/P8    |
| T29 | 刷新、断线、双页同时Steer/看子会话，snapshot/live同源；未拿确认不能消失队列消息                                                                                                                    | compiled Web/S4                                  | P3/P5    |
| T30 | 中间主代理文字流式展示；自动等待期间原prompt/run未终态，elapsed继续；最终完成标记/总耗时仅一次                                                                                                     | UI+lifecycle/S4                                  | P2/P8    |
| T31 | 默认TUI实际in-process操作普通排队、Steer、等待退出与根审批；不需要serve、不自动attach                                                                                                              | compiled PTY/S4                                  | 拓扑     |
| T32 | system prompt和默认mode实测：不用wait/status轮询即可三子并行→先到先处理→全部交付→最终答复                                                                                                          | scripted+real E2E/S4                             | 全链路   |
| T33 | 首次真实等待满60秒后复查；继续等待为120秒、120秒，不出现300秒；模型/工具忙时不积累计时提醒；自动复查和手动status不重置第一档                                                                       | controlled clock+lifecycle/S3                    | P2/P9    |
| T34 | 子代理持续产生日志/工具事件不能推迟复查；父处理新终态结果或Steer后下一等待回到60秒；采集状态不能伪造最近活动时间                                                                                   | host+lifecycle/S3                                | P9       |
| T35 | 丢弃内存唤醒但保留真实DB结果/交付意图，程序到期核对并幂等补投；到期与终态/Steer竞态合并、不重复请求、不重跑子任务                                                                                  | fault injection+DB/S3                            | P1/P9    |
| T36 | 单次等待到期不取消子任务，真实模型步骤计入原run预算；Stop/预算/错误和计时竞争不复活任务，旧等待回调无效；子执行硬期限独立                                                                          | controlled clock+integration/S3                  | P2/P8/P9 |
| T37 | 自动复查和增强status基于同一事实投影，含执行归属、真实阶段/工具、耗时、采集/最近活动时间、有限近期成功失败和增量统计；基线缺失/过时显式未知，不串昨日或其他scope                                   | host+contract/S1/S3                              | P4/P9    |
| T38 | 快照条目及文本预算有界；子代理未完成正文、reasoning、完整工具参数/输出和历史日志不进入父自动输入/status，用户子视图仍能查看授权的完整只读过程                                                      | context+SDK+UI/S4                                | P5/P9    |
| T39 | 有进展、重复失败、安静长命令、待审批/资源、状态不可用分别生成准确有限事实；脚本父模型可继续等待/查status/经工具关闭，程序不凭running或静默强制决定；不调用额外模型做进度摘要                       | scripted model+integration/S3/S4                 | P9       |
| T40 | 全部剩余子执行仅等审批：先向父提供事实并说明阻塞，再暂停重复模型复查；越过多个120秒仍无重复请求，程序检查继续；同一审批快照不反复提醒                                                              | controlled clock+permission/S3/S4                | P2/P9    |
| T41 | 部分子任务待审批但其他子任务仍活动，不暂停整体复查；纯审批暂停中批准/拒绝/撤销、Steer、子终态恢复安全边界处理，补投不丢；解除后旧计时回调作废、不补跑积压提醒                                      | integration+race/S3                              | P1/P2/P9 |
| T42 | 纯审批暂停不绕过Stop/父硬预算/致命错误；模型复查暂停与子执行额度暂停独立，未满足纯审批阻塞条件不能停止子执行计时                                                                                   | controlled clock+integration/S3                  | P8/P9    |
| T43 | 前后台子执行默认及最大额度1800000ms，较短自定义有效，超过上限明确拒绝；旧实例两小时配置的新执行不绕过新上限，历史记录不篡改；尚未启动排队不扣额度                                                  | host+schema+DB/S1/S3                             | P2/P9    |
| T44 | 执行10分钟、纯审批40分钟、恢复后执行5分钟：额度消耗15/剩余15分钟，elapsed55分钟；多次及重叠审批区间不重复扣除，批准/拒绝/撤销不重置额度                                                            | controlled clock+permission/S3                   | P8/P9    |
| T45 | 一工具待审批而同一子执行其他工具仍工作时继续扣额度；只有完全审批阻塞才暂停；到期/批准/Stop竞态不会复活超时执行或重复终态交付，父硬期限不自动延长                                                   | integration+race/S3                              | P1/P8/P9 |
| T46 | 父provider短暂失败但仍允许重试，子任务继续；重试耗尽/确定致命错误/父预算耗尽时关闭新派遣并中断本次未完成执行，父原因准确且无额外收尾模型请求                                                       | lifecycle+fault/S3                               | P2/P8    |
| T47 | 终止覆盖运行、排队、已接受创建中及本次已有内部执行树；创建/批准迟到不得启动；历史及其他任务执行不受影响，实例可用新输入复用且不消费旧待办                                                          | host+race+DB/S3                                  | P4/P8    |
| T48 | 父终止与子完成/保存/补投竞争：已保存完整结果保留，终态只认领一次；迟到结果归原执行、不把中断改成功、不唤醒下一任务；残留工具保护不提前释放                                                         | integration+race/S3                              | P1/P4/P8 |
| T49 | 通知持久来源/任务归属保存加载一致，实际provider请求为带来源正文的user内容；不伪造tool调用或system正文；不创建新任务或冒充用户气泡，标题/压缩/最新用户轮次保护识别来源；恶意正文标签不改变归属      | context+provider-contract+UI/S1/S3/S4            | P1/P3/P8 |
| T50 | 内置及自定义maxSteps不被本轮改写；受控小上限验证等待/程序检查/仅信号不扣step、父子独立、真实续模型不重置；触顶未完子执行中断且结果保留，必要报告未处理时收尾文字成功不冒充任务完成，无额外赠送请求 | controlled clock+scripted model+projection/S3/S4 | P2/P8    |
| T51 | 父请求已冻结/发出后子结果到达：前一请求成功只确认其实际纳入的输入，新结果仍待处理；失败/重试不重复插入，不提前正常完成                                                                             | context+lifecycle+DB/S3                          | P1/P2    |
| T52 | 通知入库后、首次模型请求前触发压缩：请求仍含完整正文或确定性文件入口，不能只剩生成摘要；请求纳入集合与实际序列化内容一致                                                                           | context integration/S3                           | P1/P8    |
| T53 | 纯审批暂停60/120秒复查后故意丢批准/终态信号：独立程序检查在有界时间内发现并恢复处理；无变化无模型请求；Stop后检查退出                                                                              | controlled clock+permission+DB/S3                | P1/P9    |
| T54 | 同一子执行内工具A待批、工具B等该前序，且无其他可执行工作：暂停父重复复查和该子执行额度；对照同一子执行内A待批、B独立执行/独立资源等待，不能错误暂停                                                | improve-2联测+controlled clock/S3                | P8/P9    |
| T55 | 子代理小maxSteps触顶：限制原因穿过lifecycle/run completion/AgentRunResult/host到父通知；正文保留，不能只由success推成任务完整成功                                                                  | scripted model+host+projection/S3/S4             | P1/P8    |
| T56 | Steer接受/组装/发送与Stop竞争：accepted不冒充发送；未尝试可确认，已登记尝试后故障只能未知，失败不倒推未发送；原输入退消费留审计，B实际provider请求不把未发送A输入作为新指令；刷新可恢复证据，无重复用户消息 | context+lifecycle+DB/S2/S3 | P3/P8 |

T04/T24 使用 §2.2 审查后的参数；数值尚未确定时不能宣称阈值验收已通过。T08 必须穿过真实执行环境，不能只 mock permission 返回 allow。

## 4.3 可重放的真实入口场景

1. 构建实施代码。使用独立 `OHBABY_HOME`、DB、日志、scripted provider 启动 `pnpm --filter ohbaby-cli start serve --port 0 --no-open`，不接管用户已有服务。
2. 父模型依次派出三个 background 子执行；测试闸门控制完成顺序。让父输出进展后自然结束本次模型回复，不生成 wait 调用。
3. 确认后端主任务仍活动、页面显示等待、三个子代理可见。记录模型请求数，在单次等待期限内且无事件时不增加。用受控时钟验证60秒到期自动附有限执行事实让父判断；父继续等后验证120秒、120秒，普通子进度不延后复查，也不因到期取消子任务。真实模型变体保留实际等待证据，不用改短生产默认值冒充验收。
4. 只结束 A，检查先保存结果再注入父上下文；父流式汇报 A，B/C仍运行。对子审批检查根入口，子视图只读。
5. 普通发送“下一任务”，确认保持队列。再普通发送“本次只保留校招宣讲会”，点击该行 Steer；确认它进入当前任务且不会随后再执行，上一条普通消息仍排队。
6. 分别完成 B/C，其中一个输出超过最终确定阈值，验证 `.output` 位于独立应用目录；主代理使用 read 分段取得所需内容，项目目录无该产物。
7. 刷新/双页验证等待、子状态和队列；所有结果处理后才最终完成，再推进普通排队项。
8. 独立变体覆盖 child failed/interrupted、Stop、目标过期Steer、DB/导出失败；对比父模型暂时失败继续重试与确定失败/预算耗尽，验证子执行收尾、结果保留和后续实例复用。错误场景不靠伪造成功结果结束。
9. 另用 `tests/models-4-tests.md` 的真实模型执行“多个子代理分别调查北京海淀不同高校近期秋招活动”等较长任务。网页事实随时间变化，验收依据是协作/交付链路，不是某条招聘消息是否存在。至少一次等待中普通发送、Steer，记录协议、模型、revision、事件/DB与UI证据。
10. 结束时仅停止自己启动的服务/子进程，核对无端口、进程和凭据残留。

### 交付大小的后续 E2E 取证（策略待定）

不以固定 10,000 token 作为预期。按用户指定的50 KiB参考限制增加51,200 UTF-8字节前、等于、超过边界的结果样本，涵盖中文/英文/长单行；完整结果不被裁剪，也不把这项单份基准当批量总上限。后续使用 `tests/models-4-tests.md` 中的模型及 `.env` 的API凭据，日志/报告不得记录密钥；核验实际上下文配置（本次目标1M）。记录：每份最终正式正文的 UTF-8 字节数及估算 token、同一安全边界待交付结果合计、父请求注入前后的输入估算及 provider usage（可用时）、当前窗口/输出预留/安全余量、压缩次数、文件读取次数和响应耗时。provider 总 usage 不直接等同某份报告的 token；与估算值分别记录。子代理累计输入、reasoning 和工具过程只计统计，不作为应返给父模型的正文。

覆盖日常报告、真实超过 10,000 估算 token 的报告、多子执行同时完成、父上下文已大量占用四类情况。正常真实任务用于观察分布，受控大正文用于检验边界，两者不能混成同一性能结论。比较全文交付和文件按需读取的代价后，再决定策略与必要参数；一次成功不构成所有负载下的推荐阈值。完整协作E2E仍是后续计划；2026-09-22已先行完成的独立流式请求/文件往返探针见[请求证据](evidence/2026-09-22-model-request-probes.md)，不代表本节全部场景已执行。

步数出口另用scripted provider及小maxSteps覆盖，不通过缩小生产默认值或等待真实任务跑满1,000步验收。

## 4.4 命令与回归

基线已有测试入口，实施时追加新测试文件，不允许用 passWithNoTests 证明新增契约：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/agents/subagent-host.unit.test.ts packages/ohbaby-agent/src/agents/subagents/database-store.integration.test.ts packages/ohbaby-agent/src/tools/subagent.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts packages/ohbaby-agent/src/runtime/prompt-scheduler/database-store.integration.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx
pnpm --filter ohbaby-agent prompt:check
pnpm run typecheck
pnpm run lint
pnpm run test:e2e:compiled-web
```

回归必须包括：显式 foreground、subagent继续/关闭、原生 provider tool-call/result 及 model-state 回放、第一轮审批范围与刷新、第二轮工具波次/计时/取消保护、普通 prompt 顺序、默认 TUI in-process、旧记录缺新字段可读。前置提取/read 的验收不能用本轮测试代替，接口有变需要重跑相关回归。

## 4.5 验收与残余风险

S0 明确依赖、剩余讨论项和快照预算等参数；S1 对应 T01–T09/T37 的事实查询及T43参数/旧记录；S2 对应 T10–T13/T18；S3 对应 T14–T26/T33–T37/T39–T48/T50–T55；S4 对应 T27–T32/T38–T41/T49–T50/T55 并重跑前阶段集成。最终合入前完成整套组合验收，阶段通过不自动等于整轮通过。步数边界按已确认规则由T50覆盖；50 KiB分流及批量适配仍以先行取证定稿，不把建议参数或未执行用例写成已通过。

| 风险                     | 必要防线                                       | 本轮不承诺                 |
| ------------------------ | ---------------------------------------------- | -------------------------- |
| 完成检查和通知/Steer竞争 | 持久输入、唯一键、先订阅再检查、同边界最终认领 | 外部模型/副作用恰好一次    |
| 大结果保存失败仍发路径   | DB结果依据、artifact ready、明确错误           | 磁盘/数据库损坏下无损继续  |
| 按应用目录粗放授权       | 登记归属、真实路径、双层只读校验               | 向整个app目录授予读写权    |
| 旧任务输入跑到新任务     | expectedRunId、原子迁移、不自动改投            | 已终态任务偷偷新开一轮     |
| UI看起来结束但后端还等   | 区分模型步/原任务终态、状态持久投影            | 撤回已经流出的模型措辞     |
| 恢复时重放旧工作         | 保留事实、既有中断规则、禁止副作用重放         | 第四轮完整恢复策略提前完成 |

实施后在本轮 `05-implementation-acceptance.md` 记录 revision、实际命令、各 T 项通过/失败/阻塞、截图/日志位置和偏差；不改写 02 为进度表，不生成文档自检报告文件。真实模型凭据/环境不可用时明确标阻塞，不能以 scripted 通过冒充实网通过。

## 与第四轮的联合验收边界

T21/T46～T48先证明本轮基本终止传播、创建中委托收口及迟到结果隔离；T51～T53/T56证明请求纳入、独立核对和Steer证据。第四轮 [T03～T08、T25、T41](../improve-4/04-test-and-acceptance.md) 组合根Stop、服务退出、原owner重试和冷恢复。第四轮不得重新派一个“收尾模型请求”来代替终态登记，也不得把本轮的持久交付误记为已经处理。T56是本轮验收门的一部分，英文提示位置及正常queued继续由第四轮T41验收。
