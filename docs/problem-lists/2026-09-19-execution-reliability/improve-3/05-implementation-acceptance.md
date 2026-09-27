# improve-3 实施与验收（2026-09-27）

已在本地临时分支 `codex/improve-3` 完成 S0→S1→S2→S3a→S3b→S4，实现基于开发分支 `codex/improve-2.2` 的 `88e31a1fd162b9b80b8af62e943117c5259f0b6a`。最终受测代码为 `a240eaa71da42852371288566374b9bff6e5e719`（生产代码收口 `123a2d05`），其后仅提交本验收文档及证据。全仓测试、构建、真实 LLM 与最终 compiled TUI 已通过；原生子代理审查及 Pi 两轮审查已闭合。尚未合并、推送或发布。

以下“通过”仅指所列断言；“部分”列出尚未连通或未执行变体。实现完成不等于 T01–T62 的所有排列都做过端到端验证，本文保留其覆盖边界。

## 实施结果与参数

accepted先持久化再启动child；结果/终态原因/交付分别记账。父在原lifecycle续跑，provider每attempt登记inputIds，成功请求精确ack，不赠step。

- 等待60→120→120秒；结果/Steer成功后回60。独立reconcile/检查期限各5秒，失败3次退出；纯审批暂停模型复查及子额度，未知/截断不暂停。
- 子额度默认/上限1,800,000ms，可配置更短；不延长父硬期限。自动事实≤16KiB、最多20执行/近期5工具；完整过程另分页。
- 结果≤51,200 UTF-8 bytes内联，超过给完整文件；导出失败最多3次，无假路径。保护集总量超窗明确context错误，不丢正文、不承诺自动分批。
- Steer复用消息身份，保留排队记录createdAt；消息created/updated均用acceptedAt；最后step前事务sealSteer，迟到拒绝且留普通队列。migration020增加封口及request→message派生PK索引，一次回填/删除级联。
- 冷SQLite恢复中断旧child，不重放/请求provider；额度只订阅相关工具结构/审批变化。Web/TUI子视图只读、TODO隔离，根草稿/租约保留。

## 阶段提交

基线`88e31a1f`；`771634b8`终止原因、`96a933f0`execution持久化、`757d08ed`attempt gate、`c1b9cb05`host接线、`dcbeec1d`context/lifecycle、`0637edba`输入/Steer、`9ada130b`结果文件、`96e5fe20`continuation/审批额度、`a75d96f6`SDK/Web/TUI、`4cbd65ed`CLI控制修复、`123a2d05`最终步/恢复/审查修复。生产代码收口`123a2d05`；`a240eaa7`更新旧审批超时期望并补真实暂停/Stop验收。

## 证据索引

以下路径相对仓库；A=`packages/ohbaby-agent/src/`，S=`packages/ohbaby-sdk/src/`。引用均为实际测试文件。

|代号|文件|
|---|---|
|E|A`agents/subagents/execution-store.integration.test.ts`|
|H|A`agents/subagent-execution.integration.test.ts`、`agents/subagent-host.unit.test.ts`|
|R|A`agents/subagents/result-artifacts.integration.test.ts`；`tools/read.unit.test.ts`|
|I|A`runtime/prompt-scheduler/current-run-inputs.integration.test.ts`|
|C|A`core/context/runtime-inputs.integration.test.ts`|
|L|A`core/lifecycle/lifecycle.unit.test.ts`；`core/llm-client/request-observation.unit.test.ts`|
|W|A`agents/subagents/continuation-coordinator.unit.test.ts`|
|Q|A`agents/subagents/approval-blocking.unit.test.ts`、`execution-budget.unit.test.ts`、`execution-facts.unit.test.ts`|
|P|A`core/tool-scheduler/admission.integration.test.ts`、`delivery.unit.test.ts`|
|B|A`adapters/ui-inprocess.contract.test.ts`（含新增wave两变体、child触顶两变体、最终步封口）|
|D|A`adapters/ui-persistent.integration.test.ts`、`services/database/database.integration.test.ts`|
|V|A`adapters/ui-inprocess/subagent-views.integration.test.ts`；S`subagent-reader.unit.test.ts`|
|U|`apps/ohbaby-web/src/ui/session/SubagentView.unit.test.tsx`、`ui/composer/SteerButton.unit.test.tsx`；`packages/ohbaby-cli/src/tui/app.contract.test.tsx`|
|X|`packages/ohbaby-server/src/coordination/session-recovery.integration.test.ts`；A`adapters/ui-runtime/composition.unit.test.ts`、`core/agents/runner.unit.test.ts`|
|Y|`tests/integration/agents/permission-run-lifecycle.integration.test.ts`（实际根/子执行、权限生命周期与受控时钟）|
|N|`tests/smoke/subagent-continuation.real.e2e.test.ts`；`scripts/run-subagent-continuation-e2e.mjs`|

B/D为真实装配+scripted provider；W为fake clock/事实fixture/手写ack；Q为分类/额度算术；C为字符计数，不等于真实token。

## T01–T62 实际覆盖

|项|结论、证据与未执行变体|
|---|---|
|T01|部分 E/W/V：rootRun过滤；昨日未交付+新父等待未组合。|
|T02|通过 E/H：accepted先创建、幂等/封口；容量耗尽+父等待未专测。|
|T03|部分 H/E/R：同实例多报告/历史导出；status→两报告→Read未串测。|
|T04|通过 R/N：51199/51200/51201字节边界，compiled76027字节实际Read。|
|T05|通过 E/H/R：唯一终态、持久后发布、ready路径；终态竞态未穷尽。|
|T06|部分 H/R：DB/projection/导出失败；父不再请求模型的故障全链未齐。|
|T07|通过 E/H/B：前台正文、后台receipt、无重复交付与旧行为回归。|
|T08|部分 R：真实sandbox/Read/deny/精确授权；artifact的ask批准链未专测。|
|T09|通过 R：删除tombstone、重启/迟到写；会话删除事件接线非同测。|
|T10|通过 B/N：实网root结束后普通队列另起run，时间顺序已核验。|
|T11|通过 I/B/N：原ID、一次接受消费、同run及真实provider正文。|
|T12|通过 I/U：claim/封口/lease/旧run冲突；双远程同时操作未专测。|
|T13|部分 I/U：幂等、丢响应同key、不重排；失败+刷新+丢响应未组合。|
|T14|通过 B/N：实网A/B、compiled ABC；自然模型省略mode三子未测。|
|T15|通过 W/N：到期前无请求、实网首60秒复查；非任意长时保证。|
|T16|通过 W/N：A先处理/B继续、ABC完成；A引发后续并行工具未专测。|
|T17|通过 W/E/I：丢signal补投/唯一input；所有订阅交错未穷尽。|
|T18|通过 I/L/B/N：busy接收、同wave Steer安全消费、实网同run。|
|T19|通过 B：child/Steer到达双write闸门；整批持久后才请求，配对有序。|
|T20|通过 W/I/N：pending阻结束，实际success后processed；错误见T25。|
|T21|部分 W/I/H：Stop退出/无timer/旧run隔离；同tick保存竞态未穷尽。|
|T22|部分 L/H：length/filter/retry/硬出口；均带活跃child的组合未齐。|
|T23|部分 P/H：容量/禁嵌套回归；父等待锁与残留写保护未合测。|
|T24|通过 C：两份各可装、合计超限报错，pending/正文不丢不摘要；非分批。|
|T25|部分 I/H/R/L：回滚/冻结/精确ack/错误；逐故障点重启未穷尽。|
|T26|通过 D/E/I：冷SQLite旧child中断、零provider、不重放；非无缝接管。|
|T27|通过 V/B/U/X：分页/后代scope/全文、拒child控制；compiled入口。|
|T28|部分 U/X：root审批/真实等待；duration与child ask联合计数未测。|
|T29|通过 V/U/N：刷新双页/取消补读/generation/分页；双页同刻Steer未测。|
|T30|通过 L/N：同run流式与最终推进；completion/elapsed未逐事件对账。|
|T31|通过 U/N：默认compiled TUI协作/只读/根控制；长时SSE失败另列。|
|T32|部分 N：实网2子、compiled3子大文件；非真实自然语言默认三子同场。|
|T33|通过 W/N：受控60→120→120；TUI仅60→120，实网首60。|
|T34|通过 W/Q：活动不推迟、结果后回60；高频事件+父busy未全组合。|
|T35|通过 W/I：无signal补投/原子admission；SQLite同刻多结果未专测。|
|T36|部分 W/Q/L：到期不取消/不赠步、Stop优先；硬期限竞争未穷尽。|
|T37|部分 Q/B：有限事实/status；字段逐项对照与过时基线未齐。|
|T38|通过 Q/V/U：有界无秘密/完整reasoning与tool/TODO隔离；非泄漏全矩阵。|
|T39|部分 Q：进展/失败/资源/未知事实；六类真实模型决策矩阵未齐。|
|T40|部分 W/Q/I：成功说明后暂停/旧版不确认；真实UI+失败request未合测。|
|T41|部分 W/Q：纯阻塞与丢wake恢复；批准/拒绝/撤销/混合child未全测。|
|T42|部分 W/Q/Y：真实审批挂起超过短额度仍运行，根Stop撤销审批并取消child，迟到always不写规则；父fatal与child额度未同场。|
|T43|通过 H/Q：30min/短配置/旧实例规范化；排队不扣额度为分层证据。|
|T44|通过 Q：10m+40m审批+5m算术、多暂停不续额度；非55分钟真权限长跑。|
|T45|部分 Q/P：前序/独立工作反例、立即扣时；真实并行quota竞态未齐。|
|T46|部分 L/H/X：reason/fatal/封口；provider暂败与耗尽child对照未专测。|
|T47|通过 E/H/D：root归属/创建queued封口/冷恢复；树深度排列未穷尽。|
|T48|通过 E/H：唯一终态/迟到隔离/不误伤新run；外部残留退出为分层。|
|T49|通过 I/C/N：来源/user投影/provider正文membership；标题摘要保护分层。|
|T50|部分 L/B/I：child触顶全链、父最终步封Steer；父触顶整树中断未专测。|
|T51|通过 I/L/N：集合冻结/retry不改/精确ack；late结果+失败retry未合测。|
|T52|通过 C：压缩保全文一次/不进summary/计预算；真实多批压缩未实测。|
|T53|通过 W/Q：暂停仍5秒检查/丢wake恢复；真permission+SQLite未合测。|
|T54|部分 Q/P：真实前序发布+分类反例；同时影响协调器/额度未合测。|
|T55|通过 B/X：child触顶两分支→host→父通知→UI；retry耗尽另分层。|
|T56|通过 I/C/L/N：接受/尝试/成功分账，旧未发不回放；网络未知保守记。|
|T57|通过 I/W/L：过期撤销/业务优先/同step重备；所有邻接竞态未穷尽。|
|T58|通过 H/X：旧A不取消B、evicted身份回ledger；真实B工具仍跑非同测。|
|T59|通过 E/H：绑定/唯一终态/同实例历史；文件链限制见T03。|
|T60|通过 R/N：>1MiB/UTF8分页/非法拒绝/实际Read；artifact ask仍未测。|
|T61|部分 N/Q：最终实网首deadline、全程96.125s/15请求/0status/usage链；30min质量样本未测。|
|T62|通过 L/N：一次start/end/step不重置/deadline实网；usage细项未独立对账。|

## 执行记录与审查状态

- 最终 `a240eaa7` 全仓444文件通过/6文件跳过，4855测试通过/17跳过（195.49秒）；本分支早一轮为4840通过。审查修复综合209通过、database22通过，native1–4 Approved。
- 本轮五个组合新增，两文件137通过；fixture收尾后context4通过，局部noEmit通过。日志`/tmp/improve3-combination-regression.log`、`/tmp/improve3-combination-context-final.log`。首轮wave失败为测试误认UI保存时机，非产品RED/GREEN。
- Pi复审无新阻断，接受1–5修复、6–7不改。慢IO受5秒检查/3失败期限约束：可见root失败、完整DB结果保留。Stop交错仍有分层非端到端证据；冷恢复是真DB close/reopen，非kill-9故障注入。beforeStep实际顺序为check→seal→get。
- migration020不采用重复requestId的OR IGNORE：跨消息重复owner应明确迁移失败，不静默挑一个，也不删除原消息。坏数据/导入恢复不做自动修复；非阻断限制。
- compiled Web：ABC均completed/processed，C76027bytes→artifact→Read→rootfinal→普通队列；刷新/双页/只读reasoning通过。证据 [compiled-web.json](evidence/2026-09-27/compiled-web.json) 及 [截图](evidence/2026-09-27/compiled-web.png)，该入口证据对应 `a75d96f6`，不冒充最终 HEAD；harness等待已退出child的清理错误已修，PID/端口已释放。
- 最终 `a240eaa7` compiled默认TUI协作、根审批、Steer一次接受、子页Ctrl+C只读不退出、根草稿保留、76027字节Read及根完成后普通队列推进通过。长时实测60→120，随后SSE300秒failed收尾，**不能记第三档成功**；第三档仅受控测试证明。PTY成功路径：[compiled-tui.json](evidence/2026-09-27/compiled-tui.json)；长等待与流中断分开记录于[compiled-tui-deadlines.json](evidence/2026-09-27/compiled-tui-deadlines.json)。
- 最终 `a240eaa7` 实网：96.125秒、15次请求、0次 `subagent_status` 调用；模型 `openai/gpt-5.6-luna` / `openai-responses`，上下文窗口1,050,000 tokens（detected）。生产首60秒deadline实际进入provider并成功确认；A先交付时B仍运行，Steer保留原消息ID；全部结果处理后根结束、普通队列另起任务，清理成功。见 [real-background-steer.json](evidence/2026-09-27/real-background-steer.json)。早一轮102.650秒/17请求证据另存为 [pre-review](evidence/2026-09-27/real-background-steer-pre-review.json)，不混淆版本。

- 全仓中旧测试曾期待“权限等待超过短额度就超时”，与已确认的纯审批暂停额度契约冲突。改为真实权限挂起500ms、短额度50ms仍存活，随后根Stop及迟到权限回复验收；6/6通过、原生复审通过，再执行全仓得到上述4855通过。
- Pi 使用 `calling-pi-agent`，请求的 `opencode/opus-5.5` 映射为可用模型 `opencode/claude-opus-5-5`，会话 `improve3-final-20260927`。第一轮指出的 Steer 消息排序、最终步迟到接收、旧child冷恢复、请求owner查找及事件订阅成本已修复并验证。复审接受修复与既定审批/lease取舍，无新阻断。两轮原始回复已完整展示在实施会话，本文只记录结论。

## 可复验命令与运行证据

|命令|最终结果|
|---|---|
|`pnpm test`|444文件通过/6跳过；4855测试通过/17跳过；195.49秒，包含单元、契约、集成、真实子进程及打包安装烟测。|
|`pnpm build`|全部包及Web构建通过。|
|`pnpm run lint`、`pnpm run typecheck`|正常提交钩子执行，lint零错误（48条警告），类型检查通过；未绕过钩子。|
|`pnpm --filter ohbaby-agent prompt:check`|生成的system prompt资产一致。|
|`OHBABY_RUN_REAL_SUBAGENT_CONTINUATION=1 pnpm exec vitest run --config tests/smoke/subagent-continuation-real.vitest.config.ts`|最终1/1通过，96.125秒，凭据读取本地.env，证据不包含密钥。|
|`node scripts/run-compiled-web-e2e.mjs`|实际浏览器基线UI/后端请求/诊断及PID、端口清理通过，见[日志](evidence/2026-09-27/compiled-web-baseline.log)与[截图](evidence/2026-09-27/compiled-web-baseline.png)。|
|`node scripts/run-subagent-continuation-e2e.mjs`|交互式compiled Web协作验收；脚本打印本地URL和控制命令，需实际UI操作，详见上述Web证据。|
|`node scripts/run-subagent-continuation-e2e.mjs --tui --no-animation --approval`|启动脚本后，另一个PTY运行 `node scripts/run-subagent-continuation-e2e.mjs --attach-tui <打印的manifest.json路径>`，执行审批/只读/Steer/草稿/大结果场景；最终TUI及harness退出码均0。|

实网证据保存请求身份、inputIds成员关系、成功ack、正文哈希/字节数、usage、时间顺序与cleanup；没有把API调用次数当成模型理解正确性的通用保证。交互脚本需要操作者执行，不是无人值守的单条测试命令。

## 局限与收口

不承诺跨崩溃无缝续跑、跨进程接管、副作用重放、子页独立控制、模型理解或免费复查；计时依赖事件循环。残余主要为T39–45真权限/模型决策组合、T50父触顶整树、artifact ask链、双页同刻Steer；未执行不等于已知缺陷，也不能将62行全记无条件通过。

本次未合并、未push。迁移前停止旧协调器并等待在途写完成；旧代码不应直接读取含steered的新库，不删结果数据制造回滚成功。

## SWE 改动面复核

沿既有 host、lifecycle、context、prompt scheduler 和权限边界扩展，以小型领域接口连接事实持久化与执行；没有另开父循环、添加 wait 工具或第二调度器。结果正文、交付意图、请求尝试与成功处理分别记录，避免用单一成功布尔值代替状态。request-owner 表只是原 message.modelRequests 的查找索引，不保存第二套请求结果。

刻意保留有限 context error、可见存储错误和明确中断，不为了追求表面成功做无限重试/自动重派。当前最大的维护成本仍是跨层竞态；用原子边界测试和少量真实装配/入口验收保护，不为尚未要求的跨进程恢复/A2A引入通用框架。
