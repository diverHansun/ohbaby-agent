# 5. 实施与验收记录

> 日期：2026-08-25
> 分支：`codex/context-improve-4-to-5-regression`
> 基线：`301de2da7996703e2c4254b330f981bf51507e1f`
> 实施提交：`69865e7..a084218`
> 结论：**条件通过**。Context 确定性门禁和 compiled Web 主路径通过；仓库级 integration 的 packaging smoke 在本机临时 registry 安装阶段稳定超时，不能据此声称全仓门禁、04 的全部扩展矩阵、真实 Provider cache gate 或 improve-4～5 后续人工回归已经完成。

## 5.1 结论边界

本轮达成的核心目标是：用测试把 improve-4、4.1、5 串成同一条 Context 数据链，并对已经复现的正确性、并发、崩溃恢复和隔离缺陷做最小修复。

以下结论已经有自动化证据：

- primary 与 subagent 使用同一套 request/context 能力，但以 `sessionId + contextScopeId` 隔离；primary 只读取精确 primary scope，不聚合 child history。
- measured/sent request、manual/automatic compaction 和 retry 路径使用同一份准备后视图；准备后的 request 不被后续动态变化原地修改。
- 同 scope 的压缩写入串行；跨 `ContextManager` 的竞争在数据库事务内按选中 `Part` 快照复核，赢家提交，过期候选以 `stale` 收敛且零写入。
- summary/create/prune 是一个原子 Message Store 命令；进程重启后不会留下“新 summary 与旧 active parts 同时可见”的半提交视图。
- summary 请求自身 overflow 会按完整 turn/tool pairing 有界收缩；abort 在提交前仍能阻止历史改写。
- pending/running tool 在重启投影中得到确定性的“结果未知、可能已有副作用”提示，不会被静默删除或伪报成功；真实 terminal result 会自然覆盖该投影。
- runtime initiating context 在同一 manager/scope 内进入与 compaction/prepare 共用的 mutation lane，跨 manager 仍由 store 原子幂等兜底；重建 manager/store 后不会重复注入。
- JSON/文本形式的常见 credential 会在 summary 流前脱敏；project Memory 不能越过项目根目录或通过 symlink 逃逸。
- compiled Web 使用本次构建产物完成工具调用、续聊、刷新恢复和清理；UI 中 context 粗略占用可见，runtime/title 内部文本不可见。

以下内容仍不是本轮完成事实：

- 没有凭据时的 OpenAI-compatible、Anthropic、M13 真实 cache hit/write/miss 不是 pass，而是 external gate skip。
- compiled Web runner 没有结构化验证 cache breakdown/observed、compaction progress/terminal UI；粗略占用标签不能替代这些证据。
- 04 中 permission change、完整 MCP disconnect/reconnect、cache-break source detector、全部 summary 语义 judge、全部 sibling/多 session soak 组合没有逐项完成。
- improve-4～5 的后续人工全量回归不属于本批次，不能由当前绿灯代替。

## 5.2 实际修复与数据流

### A. 请求与 scope

1. primary history 查询改为精确 primary scope；child 继续按自己的 `contextScopeId` 查询。
2. per-scope mutation lane 统一 auto/manual compaction、`prepareTurn` 与 initiating runtime part 写入，不引入全局锁；runtime 的 system/memory 只读构建仍在 lane 外，避免无意义串行；不同 scope 仍可并发。
3. manual/automatic compaction 用例直接比较最终 request 投影，避免只比较中间 helper。
4. 预算、阈值、压缩梯级和 cut-point 计算从 `ContextManager` 抽成无 I/O 的 `compaction-policy.ts`；旧导出路径保持兼容，没有增加 service、依赖容器或数据字段。

### B. 原子压缩与恢复

1. Message Store 增加窄的 `commitCompaction` 原子端口，一次提交可选 summary 与被选中 parts 的 `compacted` marks；summary/prune 共用该端口。`maskCutoffs` 仍是进程内 model projection，不写入 durable store。
2. 最终实现没有持久化 revision/marker。命令携带本次实际选择的 `expectedParts` 快照，store 在事务内逐个复核：
   - 快照一致：提交并返回结果；
   - 已变化、已 compact 或缺失：返回 `undefined`，调用方发布 `stale`，不写数据；
   - scope 错误、重复输入或基础设施错误：抛错。
3. safe tail append 不使合法 prefix summary 失效；被选择 part 的内容变化则使旧候选失效。
4. summary overflow 收缩保证每轮严格进展并受最大次数约束；signal 在 summary 返回后、commit 前再次检查。

### C. 重启、工具与隐私

1. unfinished tool 不新增 durable repair 记录，只在 serializer 投影时生成固定文本，保持 call id/tool/input 不变，避免恢复动作反过来污染事实源。
2. prompt sanitizer 覆盖 JSON `apiKey`/`password` 形态，summary LLM 与最终 summary 都使用脱敏内容。
3. Memory 路径验证同时约束 lexical path 与真实路径，阻止 `..` 和 symlink 逃逸。

### D. 事件语义

1. `CompactionProgress.inputTokens` 更名为 `estimatedHistoryTokens`，明确它只是序列化 history 的启发式估算，不是 Provider inclusive `inputTokens`。
2. `droppedRounds` 改为累计值；测试验证 0、1、2 的进展序列和估算单调下降。
3. primary 的 `contextScopeId` 可省略并归一为 primary；child 必须携带精确 scope。事件目录不再把它错误声明成所有事件的必填公共字段。

## 5.3 最小设计约束

本轮特意没有引入下列能力或状态：

- 没有新增数据库 schema、持久化 compaction revision、orphan marker 或全局 coordinator。
- 没有新增 cache-break detector、baseline 表、额外 telemetry 字段或自适应窗口调参。
- 没有扩展 Memory CRUD、主动召回、向量检索或 subagent 自动 Memory 注入。
- 没有为测试模型保留无行为作用的 `toolEpoch`、`runSnapshotRevision`、`compactionAttempts` 等字段。
- 没有把 `ContextManager` 机械拆成 `RequestAssembler / CompactionPolicy / CompactionCommitter` 三个 class。只抽取已经由独立变化原因和纯函数边界证明成立的 `compaction-policy.ts`；事务提交仍由既有 `MessageManager.commitCompaction` 负责，不增加转发中间层。

`expectedParts` 是一次性、非持久化的提交前置条件，并替代旧的 `compactedPartIds + sourceRevision` 双重语义；它不是新增的长期状态。

## 5.4 分批验收

| 批次 | 状态 | 实际证据与边界 |
|---|---|---|
| R0 规格/状态所有权 | 通过 | 权威 Context 文档已对齐 95% + remaining floor、prepared request、scope、原子提交与事件语义 |
| R1 核心 Reference Model | 核心通过、扩展部分 | `fast-check` 固定 seed/shrink、长 primary/subagent trace 已通过；generator 只声称覆盖核心动作，不冒充完整 MCP/permission/memory 状态机 |
| R2 主/子代理与并发 | 部分通过 | exact scope、事件 identity、同 scope 竞争、异 scope 并发、subagent E2E 有证据；REQ-07、SCP-04/05/10、PFX-02/04/05 仍缺逐项专测 |
| R3 failpoint/restart | 主要路径通过、矩阵部分 | in-memory/SQLite 原子提交、stale 零写入、SIGKILL/reopen、overflow、abort、unfinished tool restart 已通过；child 对所有数据库 failpoint 的完全对称矩阵未全部展开 |
| R4 runtime/request 等价 | 通过 | 同 manager、跨 manager、reopen 的 runtime 幂等；manual/automatic request equivalence 与 retry/final 路径通过 |
| R5 Memory/cache/eval | 部分通过 | project path 与发现时现存 symlink 越界、summary/title privacy、runtime filtering、稳定 prefix 和 Provider contract 通过；显式 export projection 无专测，PFX-07/08 detector 不存在且本轮不新增，EVAL-01/02/04/05 未跑 judge |
| R6 soak/provider/Web | 部分、外部门禁待补 | seeded long traces 与 compiled Web 通过；真实 Provider 因当前安全环境无 credential 而 skip；完整多 session/sibling/MCP/restart soak 未建立 |

## 5.5 测试证据

### 本地确定性门禁

| 命令 | 结果 |
|---|---|
| `pnpm run lint` | pass |
| `pnpm run typecheck` | pass |
| `pnpm run build` | pass |
| `pnpm run test:unit` | 224 files；2028 passed，2 个既有 skip |
| `pnpm run test:contract` | 14 files；245/245 passed |
| `pnpm run test:integration` | 48 files、319 tests passed；1 个 packaging smoke failed：本地临时 registry 的 `npm install -g` 固定 180 秒超时 |
| subagent runtime E2E | 3/3 passed |
| changed-file Prettier + `git diff --check` | pass |

仓库级 `pnpm run format:check` 仍命中 43 个基线文件；这些文件不属于本轮改动，未进行机械格式化。验收边界是“本轮 changed files 格式通过”，不是伪报全仓 format gate 通过。

packaging smoke 已脱离全套 integration 单独重跑，第二次仍在同一条本地 registry `npm install -g` 上超时。完整 build、其余 48 个 integration 文件和 319 个用例均通过，因此将其记录为可复现的测试基础设施门禁，不通过放宽 timeout 或修改 Context 代码伪造绿灯。

### Compiled Web

`pnpm run test:e2e:compiled-web` 使用 `a084218` 重新 build 后由 runner 正式通过：

- UI evidence：会话刷新前后同一 session；tool/follow-up user/final 各 1 条；tool panel 为 completed；runtime/title marker 不可见。
- Backend evidence：3 个主请求；cache key 存在且稳定；tool result 被下一请求消费；runtime part counts 为 `[1, 1, 2]`。
- Cleanup evidence：服务停止，pid 与端口释放。
- UI 粗略 context 占用：首轮 `5.4k / 32.8k`；续聊和刷新后 `4.6k / 32.8k`。

这里的占用值只证明 aggregate label 可见和刷新稳定，不证明 cache breakdown 或 compaction event UI。

### 真实 Provider

`pnpm run test:cache:real` 在当前进程中得到：

- OpenAI-compatible：skip（无可用环境凭据）；
- Anthropic：skip（无可用环境凭据）；
- M13：skip（无可用环境凭据）；
- aggregate：skip（partial evidence）。

仓库中旧日期的 provider artifact 不能替代本分支当前 HEAD 的实时 pass。曾在对话中暴露的 credential 应轮换；本文和测试日志不记录其值。

## 5.6 独立审查与整改

实施后进行了 architecture/minimality、acceptance matrix、security/release 三路只读审查，并对 OpenCode 的独立复核逐项回查。第一轮发现并已整改：

1. JSON `apiKey/password` 脱敏缺口；
2. unfinished tool 在 restart 后被过滤，可能诱发重复副作用；
3. summary 已返回但 abort 发生在 commit 前时仍可能提交；
4. manager-local lane 加事务外 revision 不能解决跨 manager TOCTOU；
5. progress token 字段与 dropped round 语义不准确；
6. Reference Model 中存在无行为作用字段和名称夸大的测试动作。

整改均先有失败用例，再做窄修复。二次审查确认 JSON 转义 blocker 已关闭，跨 manager 原子提交和事件语义无 blocker，也未发现真实 credential 进入 Git 历史、HEAD 或当前 diff。

OpenCode 复核指出 runtime part 写入绕过 lane、overflow 分类过宽、lane 无直接单测，以及 `ContextManager` 从约 1550 行增长到 1820 行后的 SRP 风险。本轮按证据完成以下收尾：

1. 先用并发测试复现同 scope 的两个 runtime builder 同时执行，以及 runtime 写入与 `prepareTurn` 交错；随后只把 initiating runtime read/build/append 放入既有 per-scope lane。不同 scope 并发和跨 manager store 幂等语义不变。
2. 为 lane 补同 key FIFO、异 key 并行和 reject 后释放三个直接单测。
3. `isContextOverflowError` 不再把任意 `token limit` 当成输入上下文 overflow；结构化 code 和 context/input/prompt token limit 仍识别，output token limit 明确不识别。
4. 将纯 compaction policy 抽出后，`context-manager.ts` 从 1820 行降到 1658 行。行数不是验收目标；关键是策略变更不再与 I/O 编排、summary provider 和事务提交共同修改一个文件。

没有继续抽 `CompactionCommitter`：原子性已经封装在 `MessageManager.commitCompaction`，再包一层只会转发。也没有在本轮抽 `RequestAssembler` 或整体搬走 `runCompactionCore`：它们仍共享 manager 的真实编排状态，贸然抽取会形成庞大依赖参数包。下一次出现独立 request assembly 变化，或 compaction 编排再次需要新增一种外部依赖时，再以失败测试为前提重评边界。

审查同时保留以下边界：

- Memory 的 `realpath → readFile` 拒绝发现时现存的 symlink 越界，不声称抵御同机恶意进程在两次操作间并发换链。
- 显式 export projection 尚无独立隐私专测，因此 INV-15 的全投影矩阵仍记为部分。
- 真实 Provider、cache/compaction 结构化 Web UI 和全仓基线 format 仍未达到最终发布门。
- in-memory/SQLite 还没有共用 store conformance suite；`expectedParts` 仍采用 fail-closed 的字节比较；`manager.unit.test.ts` 仍较大。这三项属于可维护性债，不在没有错误证据时顺带引入 canonical serializer、测试框架或文件搬迁。
- OBS-05 的 failed/orphan reopen 静默性、排队 compaction 重算后二次提交、真实 result 覆盖 synthetic 的两阶段路径仍缺更窄的命名专测；现有组合测试不能冒充这些探针已经齐全。

## 5.7 剩余风险与后续门禁

后续 improve-4～5 全量回归应优先补：

1. 提供已轮换且安全注入的 credential，分别跑 OpenAI-compatible、Anthropic、M13 当前 HEAD 的真实 cache gate。
2. 为 compiled Web 增加可机器断言的 cache breakdown/observed 与 compaction progress/terminal UI，而非人工从 aggregate label 推断。
3. 补 REQ-07、SCP-04/05/10、PFX-02/04/05 的组合专测；PFX-07/08 在没有产品级 detector 前标记 N/A/deferred，不为凑矩阵临时加字段。
4. 增加 primary/child 对称的 database failpoint/reopen 组合，以及多 session、sibling scope、MCP epoch、abort/retry/restart 的长 soak。
5. 跑 EVAL-01/02/04/05 summary corpus/judge；隐私、结构和恢复仍保持确定性硬门，judge 不作为唯一正确性依据。
6. 单独诊断 packaging smoke 的临时 registry 安装超时；在根因闭合前，全仓 integration 仍为红，不能把 319 个通过用例改写成 320/320。

在这些门禁完成前，本轮可以作为代码集成候选，但不能标记为 04 所定义的“最终发布门全部通过”。
