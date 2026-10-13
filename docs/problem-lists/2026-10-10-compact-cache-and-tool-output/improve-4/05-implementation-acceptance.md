# improve-4 实施与验收

> 实施日期：2026-10-13。依据本目录 00、02、04 和 plan/discussion-notes §17 的最终决策。原始讨论用于理解取舍，不恢复已撤回的比例尾段、40K 第二档或零尾段。
> 当前记录：实施、全量回归、三协议实网、子代理审查与 Pi 最终复核均已完成；保留本地分支，等待用户审查，不 merge、不 push。

## 1. 基线与前批回顾

从本地 `codex/context-improve-3` 的 `651d400a` 创建 `codex/context-improve-4`，开工时工作区干净。未修改 improve-1～3 的历史验收结论。

- improve-1：沿用同源输入估算、完整普通输出预留、可选 reasoning usage 和现有 request observation，不另建 tokenizer 或用量表。
- improve-2：沿用持久化工具结果与稳定模型投影，不重复裁剪工具输出，不改变原生工具状态、错误 metadata 和重启回放。
- improve-3：沿用 prepared 摘要分叉、同源缓存、独立摘要输出和 Context 唯一重试 owner。既有完整摘要请求已会读到旧摘要，本批补齐全部旧摘要退场，不能把前批写成“不读旧摘要”。

基线定向回归覆盖 summary request、原子提交、serializer、native context、SDK retry、wire cache、prepared summary 和 model profiles：8 文件、141 项通过。随后按第 4 批合同实现尾段、容量恢复、原子切换和运行保护。第 5 批的 mask 清理及全入口贯通仍未实施。

## 2. 实施对照

以下源码路径相对 `packages/ohbaby-agent/src/`。

| 计划阶段 | 实际实现 | 主要代码 |
| --- | --- | --- |
| 4.1 一次候选计划 | 同一 attemptId/compactionId，保存来源、读入集合、保留集合、受保护 input IDs 和精确提交快照；生成、复测、提交消费同一候选 | `core/context/context-manager.ts` |
| 4.1 固定尾段 | 固定 20000 tokens，按真实 user/assistant 起点形成完整组；最新超大组整组保留，未闭合依赖向前保留；移除 preserve ratio 分支 | `core/context/compaction-policy.ts` |
| 4.2 单滚动摘要 | 合并全部活动旧摘要；提交时旧摘要与被替代 parts 一起退场，原文和旧摘要仍留库 | `generateSummaryCandidate`、`reviseCandidate` |
| 4.2 模式 A | 只裁临时摘要请求中较老完整组；保护旧摘要、尾段、当前输入和未闭合依赖；本地缺口或可解析 provider 缺口决定裁剪量，与网络重试共用两次实际请求额度 | `generateSummaryCandidate` |
| 4.3 模式 B | 仅在完整普通请求放不下时，扣除完整普通输出、安全额与固定材料后一次计算尾段预算；最少保留最新完整组，不重新发摘要、不为收益缩尾 | `runCompactionCore` |
| 4.3 正文预算 | 最终正文最多 16384 tokens；模型生成前预扣宿主文件操作和遗漏附注，包括模式 B 可能新增的文件操作；不事后截断正文 | `candidateText`、`summaryRequest` |
| 4.4 原子提交 | 摘要正文、成功 modelRequests、遗漏 metadata、提交前估算前后值和旧 parts 退场同事务；校验相关消息及其全部 parts，能发现组内新增 part | `core/message/{types,manager,store,database-store}.ts` |
| 4.4 Stop 与并发 | 两 store 在真正事务写入口检查 signal，覆盖提交队列等待；新独立消息不冲突；相关组变化使本次失败且零写；提交后 Stop 或新输入不抹掉成功事实 | Context/Message 原子与并发测试 |
| 4.5 运行保护 | 同批移除次数帽和 thrash；最终失败/无收益终止本次运行；force 标志调用前置位，同一步输入重入不补额度；成功绝对占用地板按 session/scope 保持 | `core/lifecycle/lifecycle.ts`、Context floor |
| 4.6 轻量 UI | 复用摘要消息的持久化投影给灰色单行提示，显示 estimated 压前/压后和遗漏数；手动立即刷新 usage/composition；无重复成功 toast、无假 run/step | `adapters/ui-state/persistent-store.ts`、`ui-inprocess.ts`、CLI/Web |

请求记录用 `purpose` 区分普通与摘要所有权：普通仍必填 runId/messageId/step；摘要必填 compactionId/messageId，不新增外键。成功摘要记录只存到对应摘要消息，失败、中断和未应用尝试保留逐请求诊断。UI spinner、输入账本与恢复消费者只接受普通请求，摘要不会被误算为普通 model step。

## 3. 测试证据

| 验收项 | 覆盖与断言 |
| --- | --- |
| D1 | 同一 scope 无 force 连续三次自动成功；占用未增长不再生成；增长后可再压；窗口缩小、输出增大和 force 不受旧地板阻挡；多份旧摘要合并为一份 |
| D2/D3 | 64K、200K、1M 离线窗口用同一 20K 规则；最新超大组、synthetic input 边界、native call/result、非 native pending/running 工具完整保留 |
| D4/E7/E8 | 模式 A 精确 omittedPartIds；provider 报告 13K 缺口时一次移除足够完整组；网络/overflow 混合失败合计至多两次；模式 B 包含完整 ordinary output 和校准后的 protected input，仅发送一次摘要；宿主后缀预扣、最小尾组仍不适合则失败 |
| D5/D6 | 新输入不退场，相关组新增/修改发生冲突；队列等待 Stop 两后端零写，提交后 Stop 保留事实；SQL 故障注入、重开与事务中途 SIGKILL 回归 |
| E3/E4 | 自动失败/无收益不发送普通请求；force 失败/not-needed 不重发；同一步 stale input 重入不重新获得 force；结束后用户新 run 可继续，已完成工具结果不重跑 |
| E6/A4 | SDK/manual/slash、CLI、Web、持久化重开；composition.summarized-conversation 当场刷新；摘要 records 与正文同提交、usage 未知不伪造零、没有假 run/step |

新增主要测试：`core/context/compaction-plan.integration.test.ts`、`core/message/compaction-store.integration.test.ts`、`tests/integration/core/context-compaction-lifecycle.integration.test.ts`，以及 CLI/Web 的组件合同测试。旧 manager、concurrency、goals、长任务、native 重开与 diagnostics 夹具按固定 20K 扩大，保留原业务断言；冲突结果按本批合同由 stale/not-needed 改为 failed。没有增加生产兼容分支来迎合旧测试。

最终验证命令与结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm test -- --reporter=dot` | 535 个文件通过、6 个文件跳过；5993 项测试通过、17 项跳过、零失败；210.27 秒 |
| `pnpm build` | 通过；在 Pi 修复后重新构建，与全量测试串行执行 |
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 通过，0 errors；108 项既有 warnings，本批不扩展清理范围 |
| `pnpm exec prettier --check`（全部变更及新增 TS/TSX） | 通过 |
| `git diff --check` | 通过 |

全量回归包含单元、集成、编译后模型合同、CLI 打包及真实 serve 进程/RPC/终端测试。完整日志在 `/tmp/ohbaby-improve4-tests-verified.log`；build、typecheck、lint 与格式检查日志也保存在 `/tmp/ohbaby-improve4-*.log`，不纳入提交。

首轮全量暴露旧夹具和审查修复的中间状态；同时运行外部 build 会与打包测试的 dist 清理竞争，最终验收串行执行构建和全量测试，不采用这轮失败作为最终结论。

第二轮全量仅剩权限淘汰测试超时。加上“审批结束即报错”的诊断后，确认第 896 次拒绝后触发摘要，旧 fake provider 仍返回 tool_calls，新的失败终止规则正确结束了运行。仅让测试 provider 按 purpose 返回有效摘要，保留 1026 次真实审批、跨作用域隔离和零工具执行断言；权限文件 18 项全部通过。没有调高超时、修改生产权限逻辑或屏蔽测试。

### 3.1 UI 视觉核验

通过临时 Vite 入口加载真实 MessageRow、StructuredCommandOverlay 与生产 CSS，用 Playwright 检查 1280×900 和 360×800。完成提示为 13px 灰色，桌面一行，窄屏自然换为两行且没有横向溢出。窄屏 overlay 宽 324px；完成后从 92000/72% 刷新为 12000/9%。已移除失去作用的 force checkbox，手动入口始终执行显式 compact；重复点击在 busy 时禁用。

截图 `/tmp/ohbaby-improve4-ui-{desktop,mobile}.png` 和 `/tmp/ohbaby-improve4-overlay-{desktop,mobile}.png`。临时入口、Vite 和浏览器已清理，不纳入仓库。

## 4. 独立服务实网

使用 `tests/models-4-tests.md` 对应的真实凭据，在本代理进程启动三个独立 HTTP daemon，随机本地端口、独立 HOME/项目/SQLite，通过远程 JSON-RPC client 创建会话和提交请求。没有占用或停止用户服务。key 只在进程内加载，报告、参数和提交不含凭据。

三协议均经 ZenMux。普通输出 4096，摘要输出 16384，关闭 thinking，本地窗口 128000。Chat 流程为 seed → 普通确认 → compact → 用户修正和新增材料 → compact → 再增长 → compact → 回忆；另两协议各一次 compact。合计 16 次生成 HTTP，全部 200，摘要均成功落库且为 stop。每次核对普通和摘要共享前缀、tools/reasoning/cache 身份、成功 request record 归属、单活动摘要、旧摘要留库和即时 composition。

| 模型/协议 | 次数 | 本地估算压前 → 压后 | 摘要实际 input/output | cache read/write |
| --- | ---: | --- | --- | --- |
| deepseek-v4.1-flash / Chat | 3 | 34075 → 9092；33952 → 8724；33387 → 8620 | 32955/518；33425/538；33289/548 | 32512/未知；33024/未知；32896/未知 |
| gpt-5.6-luna / Responses | 1 | 32899 → 8323 | 31390/290 | 31057/330 |
| claude-sonnet-5 / Anthropic | 1 | 45749 → 11534 | 48712/389 | 48192/5 |

实际 provider input 不是内部启发式值。cache write 未观测与明确零分开；Responses、Anthropic reasoning 明确为零，Chat 未返回。实测命中不承诺固定命中率。样本没有触发模式 A，omittedParts 均为零；Mode A/B 的故障和精确容量风险用可控离线测试验证，不靠重复实网撞限额。

逐条检查了五份摘要和三份最终回答：Cedar、release 17、`src/context.ts`、`E_CHECK_41`、不改文件、`job-47` 仍运行且结果未知、测试未执行、投产只是助手建议而未批准均保留。Chat 第二次起继承负责人 Lin → Mia 的明确修正，后续回忆回答 Mia。没有执行工具或将未完成任务冒称完成。语言和措辞不要求逐字一致，不能用此样本宣称摘要语义永不丢失。

脱敏证据 `/tmp/ohbaby-improve4-live.json`，临时 runner `.ohbaby/improve4-live.ts` 位于忽略目录，不纳入提交。三个服务和测试目录已在 finally 清理。64K/200K/1M、thinking B/effort、网络混合失败和 Stop 均属于离线覆盖，未声称本批实网发送过这些场景。

### 4.1 Pi 修复后的实时提示复验

在最新构建上另启一个独立 Chat daemon，再跑连续三次压缩。RPC 客户端同时订阅实时事件，断言每次收到 `session.changed` 中的压缩提示以及 `context.window.updated` 的新 composition；不是仅依赖事后查库。历史提示条数依次为 1、2、3，模型活动摘要仍各为 1，旧摘要记录依次为 1、2、3。后续普通请求仍能恢复 Mia、17、文件、错误、运行中任务和未批准状态。

8 次生成 HTTP 全部 200，三次摘要各只请求一次。本地估算 34076→8783、33773→8522、33317→8428；摘要 input/output 分别为 32957/466、33375/510、33262/518，cache read 为 32512、33024、32896，cache write 未观测。报告 `/tmp/ohbaby-improve4-live-timeline.json`。本批累计 24 次真实生成请求；所有测试服务与临时数据均已清理。

## 5. 独立审查与取舍

子代理分别审查前批基线、原始讨论/固定决策、Context/Lifecycle 与 UI。已按复现修复：排队 Stop 仍落库、manual 无旧段却超预算误报 not-needed、提交后 protected input 增长使已提交成功未传播。最后补齐 Mode B 可能增加宿主文件附注的生成前预扣。

本地参考：Pi 的 `settings-defaults.ts:11` 和 `compaction.ts:446,704`，ZCode 的 `compact-selection.ts:359`，Gemini 的 `chatCompressionService.ts:660,703`。采用固定 20K、完整组、旧摘要继承和无收益拒绝的思路；不复制 entry 体系、固定保留组数、20% 兜底倍率或跨任务失败锁。

没有新增依赖、数据表、迁移、召回系统、永久失败锁或新压缩框架。候选是一次函数调用的数据，不是持久化计划系统。无法解析 provider overflow 缺口时只移除下一个可裁完整组，剩余一次仍失败即终止，不新增猜测倍率或第三次请求。

Pi `github-copilot/claude-opus-5.5`、medium 首轮只读检查合同和生产 diff，并自行运行 4 文件 52 项测试。它复现了旧摘要退场后 UI 提示消失并变成空 assistant 的问题；另提出提交后占用刷新失败可能反转成功状态的风险。按用户允许的前端协作方式，随后将六个 UI/adapter 文件交给 Pi，要求先复现再最小修复。四个新用例先红后绿，三文件共 178 项通过。主代理检查了实际 diff，并在最新真实服务上补查实时提示和占用事件。

具体修复：摘要 UI 提示从所有 durable summary parts 识别，不取决于模型活动状态；占用重查异常只降级到已完成 compact 的 `usageAfter`，不沿用旧 composition，也不将真实业务失败改成成功。没有增加自动重试或通用错误吞噬。占用刷新失败目前没有新增专用诊断事件，是可观测性上的已知限制。

采纳提前容量保护的简短注释，不采纳删除第二个容量条件，因为 improve-3 已证明需要在普通请求前为完整普通输出留出后续摘要空间。未做两项非必要重构：provider 缺口解析搬层、折叠候选派生字段；前者目前只有此处使用，后者的完整 durable 快照与活动投影并非同一集合。没有收益时不会永久锁住会话，用户明确开启新 run 仍可能再次遇到同一失败，这符合最终决策。

Pi 最终只读复核自行重跑 5 文件、202 项测试，全部通过，确认上述两项回归已关闭；在其实际检查范围内未发现剩余产品阻塞。它读取了修复后的 Chat 实网报告，但没有重放 SSE 原始事件，也没有自行执行全量测试、fresh build 或三协议实网；这些由主代理完成，证据见第 3、4 节。复核中列出的全量收尾和验收文档事项已补齐，非必要重构建议不再作为阻塞。三轮 Pi 完整回复均已在会话中原样呈现。它首轮看到的视觉临时文件已清理，不纳入交付。

## 6. 兼容与边界

无数据库表或 schema 迁移。已有原文与历史摘要不删除；新摘要沿用 `time.compacted`，遗漏原因和精确 IDs 存在正文 part metadata，老摘要没有估算 metadata 时仍显示通用压缩提示。scope 清理释放 floor，进程重启不持久化估算地板。

`modelRequests` 的摘要所有权是新联合变体。当前版本及其 UI/恢复消费者已贯通，不能据此保证旧二进制理解新记录；直接降级生产数据库前需备份并评估旧消费者，未执行反向迁移。没有做通用 provider 硬输出上限探测或摘要语义完整性保证。

## 7. 本地交付

分支 `codex/context-improve-4`，基于 `651d400a`，按三批保留本地提交：

| 提交 | 范围 |
| --- | --- |
| `fa0260f2` | 固定尾段与单滚动摘要、模式 A/B、原子存储、生命周期失败终止、请求所有权、手动压缩刷新与回归测试 |
| `8017a8f8` | CLI/Web 灰色摘要边界、失败反馈、去重通知及组件测试 |
| 本文所在文档提交 | 同步 Context 当前契约、议题入口和本批实施验收记录 |

前两批提交钩子的 lint、typecheck 均通过；完整工作树的测试证据见第 3 节。凭据扫描未发现真实 key 进入变更或新增交付文件，临时实网 runner、报告和截图不纳入提交。未 merge、未 push，等待用户审查。improve-5 仍需清理 mask 并执行完整入口贯通，不将本批阶段结果当成整个议题结束。
