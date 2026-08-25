# 2. 联合回归方案与改动面

> 本文是后续实施会话的执行契约。规划会话不据此修改生产代码。
> 总原则：先建立能失败的证据，再修复；每批纵向闭环、测试、审查、独立提交。

## 2.1 方案总览

推荐采用“测试硬化 → 证据驱动修复 → 选择性抽边界”的路线：

```text
R0 规格/状态所有权
  ↓
R1 核心参考状态机 + 属性不变量
  ↓
R2 primary/subagent + Lifecycle/MCP 并发集成
  ↓
R3 summary 自溢出 + 压缩 failpoint + 重建恢复
  ↓
R4 请求/投影/幂等差异修复
  ↓
R5 Memory/cache prefix/summary eval
  ↓
R6 soak + 真实 Provider + compiled Web
```

每批遵循同一闭环：

1. 先补该批能失败的 targeted test；
2. 记录失败是实现缺陷、测试设计错误还是规范未决；
3. 只有实现缺陷才修改最小生产面；
4. 跑 targeted + unit + contract + integration（按批次）+ lint/typecheck；
5. 独立审查该批是否偏离 00/01/04；
6. 原子 commit 后再进入下一批。

## 2.2 方案选择与取舍

| 方案 | 内容 | 收益 | 代价/风险 | 结论 |
|---|---|---|---|---|
| A. 只重跑现有 suite + E2E | 不新增状态机/failpoint | 最快 | 只能重复已有证据，无法验证部分失败和恢复 | 拒绝 |
| B. 测试优先硬化，按失败最小修复 | 新增属性、并发、故障、恢复测试；生产修改由红测试触发 | 风险对准真实，改动可逆，易分批审查 | `ContextManager` 暂时仍大 | **推荐** |
| C. 先拆 ContextManager 再测试 | 先抽 assembler/policy/committer | 文件结构更清楚 | 容易把未经证明的边界固化，测试会绑定新实现 | 暂缓 |
| D. 全量事件溯源重写 | Context 全部改为 replayable events | 恢复模型统一 | 数据迁移、兼容与控制流复杂度巨大 | 当前拒绝 |

路线 B 不排斥后续抽取三个窄边界，但必须由测试压力证明：

- 纯 request assembly/measurement；
- 纯 compaction policy/projection；
- 原子或可恢复的 compaction commit。

## 2.3 Design Goals 到工程护栏的映射

| Design Goal | 实施护栏 | 禁止的捷径 |
|---|---|---|
| 正确性 | 比较 Provider 实际输入中的 `{ messages, tools }` 投影与 Prepared request；cache fields 另按 capability/policy 校验 | 只比较消息数量或 stringify 长度 |
| 可靠性 | failpoint 后销毁 manager、重开存储、再 materialize | catch 后在同一内存对象上断言 |
| 隔离性 | 每个 action/invariant 都带 session/scope；primary/child 对称用例 | 只测 primary 后推断 child 一样 |
| 可测试性 | fake clock、scripted provider、barrier、seed、typed store fake | 随机 sleep、深层无类型 mock |
| 可观测性 | 失败输出 seed、最小 trace、模型视图 diff、scope/event | 只报 `expected true` |
| 可维护性 | 测外部行为；抽取只围绕独立变化原因 | 为测试增加 production-only getter |
| 简单性 | 新依赖/新状态必须有当前失败用例支撑 | 为未来 Provider/Memory 预留插件框架 |
| 缓存效率 | 先保证正确请求，再验证稳定 prefix 与真实 cache read | 为命中缓存保留过期权限或工具 |

## 2.4 关键设计决策

### D1：测试状态，而不是测试单个方法

建立一个小型 Reference Model。它不复制生产压缩算法，只维护规范中最小状态：

- durable message/part ledger；
- active/compacted/summary model view；
- session/scope identity；
- run snapshot identity；
- tool epoch 与 stable tool order；
- compaction attempt terminal state。

真实系统和 Reference Model 接收同一动作序列，每步比较不变量。这样测试对准行为，不会因合理的函数拆分而碎裂。

### D2：属性测试库优先推荐 `fast-check`

仓库当前没有属性测试依赖。两个选择：

| 选择 | 优点 | 代价 |
|---|---|---|
| `fast-check` | 成熟 generator、seed、shrinking、Vitest 集成；DeepSeek 已有成功参考 | 新增 dev dependency 与 lockfile 变化 |
| 自研 seeded runner | 无依赖；完全定制 | shrinking、分布控制和最小反例需要自己维护，易制造偶然复杂度 |

推荐 `fast-check`，因为本轮最需要的恰是 shrinking；自研完整属性框架比一个成熟 dev dependency 更复杂。若用户拒绝新增依赖，则退化为固定 seed + trace replay，不自造通用 property library。

### D3：压缩阈值先统一公式，不在回归中调参

正式契约：

```text
needsSummary =
  usageRatio >= summaryThreshold
  OR remainingInputTokens < minRemainingInputTokens
```

- ratio 的分母是模型 input budget；无 budget profile 时才回退 context limit。
- cached input 仍属于 `currentTokens`；cache hit 不降低窗口占用。
- 本轮以当前代码 `summaryThreshold=0.95`、`minRemainingInputTokens=4096` 为行为基线。
- mask 仍可在更低阈值启动；summary 参数优劣属于后续基于 telemetry/eval 的调参，不在联合回归顺带改变。

代价：旧 85% 产品目标需要在 R0 明确标记为 superseded/history；好处是回归不混入行为调参，失败容易归因。

### D4：failpoint 决定是否修复；修复时优先窄原子提交端口

如果 R3 证明部分写入可以形成歧义，候选如下：

| 候选 | 做法 | 优点 | 代价 | 推荐条件 |
|---|---|---|---|---|
| 窄原子提交端口 | Context 定义一次性 commit 输入，由 Message adapter 在同一事务写 summary + compacted marks | 终态简单；复用现有 SQLite 事务；不把恢复逻辑扩散到 ContextManager | 需要 in-memory/DB 两种 store conformance；端口形状需谨慎 | **红测试成立时的默认选择** |
| Durable operation marker | begin → summary/mutations → end；重建识别 orphan 并恢复/前滚 | SIGKILL 可检测；跨非事务介质也成立 | 新 durable state、版本/清理/恢复复杂度 | 只有真实存储无法提供原子边界时使用 |
| catch 中手工 rollback | 写失败后逆向更新 | 局部改动小 | SIGKILL 时无效；rollback 也会失败 | **拒绝** |

不可在测试前声称当前实现已经损坏，也不可选择“全量事件溯源”。但修复取舍已经收敛：若 failpoint 变红，优先窄原子端口；只有真实介质证明事务不足时才升级 durable marker。

若使用 marker，不能把所有 unmatched begin 一律当 stale 或一律当 busy。marker 至少包含 operation id、`sessionId + contextScopeId`、lifecycle epoch 和 phase；当前 lifecycle 的 unmatched begin 是 active/busy，旧 epoch 的 unmatched begin 才是 stale/orphan。恢复策略必须前滚到唯一合法 view 或明确封堵，不能在重建时重新调用 LLM，也不能靠 catch-only rollback。

### D5：runtime 注入幂等应落在写边界

如果 barrier test 复现重复 runtime part，优先为 `(messageId, metadata.kind)` 提供原子 append-if-absent/唯一写语义，而不是在 `ContextManager` 再加一个 process-local Set。原因：

- Set 不能覆盖多 manager/重启；
- 真正不变量属于 durable message；
- primary/subagent 都能复用同一语义。

如果测试证明上层 run ledger 已严格禁止该并发，则补跨层 contract 固化不可达条件，不重复增加存储约束。

### D6：manual 与 automatic 共用投影契约，而不是增加布尔开关

R4 先用 metamorphic test 比较同 history/tools/scope 的两条路径。如果不等价且非产品意图，优先复用同一纯 projection/measurement helper；不增加 `manualMode` 分支继续扩大控制耦合。

### D7：Summary 结构测试与语义评测分层

- commit/PR：确定性验证合法结构、隐私过滤、体积下降、file ops 和错误处理。
- nightly/release：固定长会话语料，验证目标、约束、决定、文件状态、未解决错误的语义保留。
- LLM-as-judge 不能成为唯一判断；先做规则断言并以小规模人工校准 judge。

### D8：同 scope compaction/mutation lane + 提交前 revision 复核

- prompt scheduler 仍可快速返回 accepted receipt，不让长时间 summary 生成卡住 Web 请求。
- 同 `sessionId + contextScopeId` 的 auto+auto、manual+auto、manual+manual 和 prompt Context durable mutation 必须进入同一 exclusive lane；不同 scope 不因此全局串行。
- lane 必须位于 primary/subagent 共用的 Context/request 写边界，不能只在 Web primary 的 `compactSessionInternal()` 打补丁。
- 一次 logical compaction 从 candidate snapshot 到 commit/terminal 持有本 scope lease；它可以跨 summary Provider await，但只阻塞该 scope 的 Context mutation。auto compact 若在已有 prompt owner 内触发，必须复用 owner token 或由协调器安全转交，不能嵌套加锁死锁。
- 获得候选后、提交前仍必须复核 durable revision/选中历史身份。这层检查用于防御多 manager、legacy/out-of-lane writer 和未来入口；若已变化，则跳过或基于新快照重算，不能提交 stale candidate。
- UI scheduler 负责“何时接纳”，Context lane 负责“何时写 durable state”；两者职责不能混成 session 级全局 mutex。

### D9：summary overflow 使用有界、turn-aware 的输入收缩

summary 请求的恢复算法必须满足：

1. 首次请求使用当前合法 `historyToCompress`；只对明确分类为 context overflow 的错误进入收缩。
2. 每次从最旧端删除至少一个完整 turn/API round，并清理由此产生的前导 tool result；不得拆散 tool call/result pairing。
3. 保留最近用户边界和当前任务所需尾部；不足以继续收缩时明确失败。
4. 最大尝试次数与最小 token/消息进展有硬上限；abort 立即终止，不与普通 transient retry 叠加成乘法预算。
5. 每次尝试的输入规模、删除单元数和 terminal reason 可观测，但不记录敏感全文。

这条恢复只解决“摘要请求无法装入真实窗口”，不在本轮持久化 Kimi 式 observed provider ceiling。

### D10：确定性 repair 与事件事实源

- 任意 synthetic tool repair 的 ID、文本、status 必须由 durable call id/status/schema version 纯函数生成；禁止使用当前时间或随机数破坏 replay/prefix 稳定性。
- 真实 tool result 到达时优先于 synthetic projection；不得把 unknown/interrupted 写成成功。
- 所有 Context event 携带 scoped identity：`sessionId` 必填，`contextScopeId` 仅 primary wire payload 可省略且必须被消费者归一为 primary，不能表示“聚合所有 scope”。
- compaction progress/terminal event 另带 opaque `attemptId`；同一 accepted attempt 的所有 progress 与唯一 terminal 共用该 ID。terminal `outcome` 只能是 `success/failed/inflated/skipped/aborted`；`success` 另以 rung/result 区分 mask、prune、summary。
- durable store 是事实源；事件 publish 或 subscriber 失败不回滚已提交历史，resume/replay 不重新发历史 observable event。

## 2.5 分批实施

### R0 — 规格、状态所有权与权威文档对齐

**目标**：消除测试判定依据的歧义，不改运行行为。

工作：

- 确认 D1～D10 与 04 的不变量。
- 在 Context 模块文档中统一：`PreparedModelRequest`、`tailDirectives`、input budget、95% + 4096、primary/subagent scope、run snapshot、durable/ephemeral 状态。
- 删除或改写不存在的 assembler/compressor/pruner 文件布局与旧接口示例。
- 将 `manager.unit.test.ts` 中“85 percent compression threshold”重命名为只描述 ratio calculation，另以 `decideCompactionRung` 用例证明触发公式。

主要改动面：

- `docs/core/context/{goals-duty,architecture,data-model,dfd-interface,test}.md`
- `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`（仅测试名称/契约用例）

DoD：文档与当前代码无 85/95、接口、文件布局冲突；lint/typecheck/unit 不因纯文档/测试基线改坏。

### R1 — 核心 Reference Model 与确定性属性测试

**目标**：第一次跨动作序列验证 Context 不变量，不改生产行为。

工作：

- 引入已确认的 `fast-check`，记录 seed 并使用 shrinking；只有依赖安装被客观阻塞时才退化为固定 seed runner，且验收必须显式记录能力降级。
- 建立合法 action generator、reference reducer、invariant assertions、trace serializer。
- 核心 generator 只覆盖 message/request/usage/tool pairing、mask、auto/manual compact、overflow、abort、restart；先证明最承重的模型视图与 durable 不变量。
- MCP load、permission、session switching、memory edit、spawn/dispose scope 不塞进首个 generator；分别在 R2/R5 的 scoped property/integration suite 扩展并复用同一 canonical model-view assertion。
- PR 跑固定 seed/较小 runs；nightly 扩大 runs。

建议新增：

- `packages/ohbaby-agent/src/core/context/testing/context-reference-model.ts`
- `packages/ohbaby-agent/src/core/context/context-state-machine.unit.test.ts`
- 只供测试使用的 fixture/helper 放在 Context 最小公共测试目录，不导出到生产 API。

DoD：核心动作失败输出 seed + shrunk actions + expected/actual model view diff；100% 可重复；没有 wall-clock sleep；扩展动作未接入不能被报告成“全状态模型已覆盖”。

### R2 — 主/子代理、Lifecycle、MCP 并发集成

**目标**：证明 improve-4.1/5 的“同一 Agent 链路、不同 scope 隔离”在真实编排中成立。

工作：

- 同一 child session 两个 scope 并发 tool loop；一个 lazy load MCP，一个保持原工具集。
- primary 与 child 同时触发接近阈值；只压各自 scope。
- prepare/send 间加载工具，证明 immutable request 不变、下一 step 新 epoch 生效。
- close scope 时 Context/MCP/tool sequence/sandbox 清理幂等；兄弟 scope 不受影响。
- final-step、overflow retry、abort 与动态 tool set 组合。
- 用 barrier 分别交叉同 scope auto+auto、manual+auto、manual+manual、manual compact+prompt；按 D8 验证唯一提交、revision 复核与执行顺序，异 scope 仍允许并发。
- 固化 Context event 的 scope/attempt terminal contract；primary、两个 sibling child scope 的事件不可按 session 聚合混淆。

主要改动面：

- `tests/integration/core/context-subagent-scope.integration.test.ts`
- `tests/integration/core/lifecycle-tool-scheduler.integration.test.ts`
- `packages/ohbaby-agent/src/mcp/integration/*test.ts`
- 必要时新增专门的 `context-agent-concurrency.integration.test.ts`

DoD：primary 与至少两个 sibling subagent 的 model request、history、cache key、tool order、events 均按 scope 验证；三类 compact 并发与 LIF-08 中同 scope 写串行、异 scope 可并发；stale candidate 不提交；不以 session-only 断言代替。

### R3 — Summary 自溢出、压缩 failpoint、真实存储重建与证据驱动修复

**目标**：验证 durable truth 在每个部分失败点后仍唯一、合法、可恢复。

工作：

- 为测试提供 failpoint-capable Message port/adapter，按第 N 次 create/append/update 失败。
- 使用真实临时数据库执行 summary/prune，失败后销毁全部 manager/store 实例并重新打开。
- scripted Provider 让首次/多次 summary request 返回 context overflow，验证 D9 的输入严格收缩、tool pairing、abort 和最大尝试；增加真实 Provider capability 用例作为最后佐证。
- 增加 child scope 与 primary 对称用例。
- 在可控子进程中增加至少一个 hard-crash/SIGKILL 场景；父进程必须等待预创建 marker 的**确定内容**而非仅等文件存在，再执行 SIGKILL。平台不支持时明确分类为 platform-gated integration，不让普通确定性用例 skip。
- 若红测试成立，按 D4 选择最小可恢复提交方案，并为 Message store 增加 conformance suite。

故障点：

1. summary message create 后；
2. summary part append 后；
3. 第 N 个旧 part compacted 更新后；
4. prune 第 N 个 part 更新后；
5. durable commit 后、event publish 前；
6. tool intent 持久化后、tool result 前；
7. summary Provider stream 中断/abort；
8. summary Provider 在完整输入及前若干次收缩后返回 context overflow；
9. 原子 commit 或 marker close 完成前 hard crash；若采用 marker，分别构造 current-lifecycle busy 与 prior-lifecycle stale orphan。

主要改动面（由测试结果裁剪）：

- `packages/ohbaby-agent/src/core/context/context-manager.ts`
- `packages/ohbaby-agent/src/core/message/{types,manager,store,database-store}.ts`
- Context/Message unit + database integration + 新 restart/fault integration tests

DoD：所有 failpoint 重建后都满足 04 的 `CMP` 场景与相关 `INV` 不变量；CMP-13 能在有界次数内成功或明确终止；resume 期间 summary LLM 调用数为 0、observable replay event 为 0；没有 catch-only rollback；production 修改由对应红测试解释。

### R4 — runtime 并发幂等与 manual/automatic 同量纲

**目标**：处理 01 的 PR-02/PR-03，不扩大请求链分叉。

工作：

- 用 barrier 同时启动同一 initiating message 的两次 snapshot 创建。
- 覆盖同 manager、两个 manager、重开 store 三种形状。
- 对同 history/tools/scope 比较 manual compact 与 forced prepare 的最终 model view/usage。
- 验证正常、final-step、overflow retry 仍只消费一份 PreparedModelRequest。
- 若测试失败，按 D5/D6 做窄修复。

主要改动面：

- `packages/ohbaby-agent/src/core/context/{context-manager,types}.ts`
- 可能的 Message 原子 append-if-absent 端口及其 conformance tests
- `core/context/manager.unit.test.ts`
- `core/lifecycle/lifecycle.unit.test.ts`
- 对应 integration tests

DoD：同一 initiating message 的 runtime kind 基数恒为 1；manual/automatic 的 intended-equivalent 视图一致；无 process-local 幂等假修复。

### R5 — Memory、稳定前缀、cache 诊断与 Summary eval

**目标**：验证既有 Memory 分层和 improve-5 cache 能力在长会话/压缩前后仍成立。

工作：

- global/project OHBABY.md 合并、路径边界、安全扫描、run 内稳定/下一 run 刷新。
- primary 加载、subagent 不自动加载；后续若要 child 使用记忆，必须另行设计显式 `MemoryView`。
- stable system/runtime/tool prefix 差分；tool epoch 有意变化只 miss 一次后稳定。
- compaction 后重置 cache-break baseline，不把合法 prefix 缩短误报为异常。
- 建立 summary eval corpus 与规则/judge 输出格式；不存真实 secret。

主要改动面：

- `packages/ohbaby-agent/src/core/memory/*test.ts`
- `packages/ohbaby-agent/src/core/context/{manager,serializer}*.test.ts`
- `packages/ohbaby-agent/src/services/interface-providers/*test.ts`
- `scripts/real-cache-*` 和可选 eval runner

DoD：04 的 `MEM`/`PFX`/`EVAL` 场景全绿；缓存诊断按 session/scope/source 隔离；Memory 没有能力扩张。

### R6 — Soak、真实 Provider 与 compiled Web

**目标**：用长序列和真实发布形态验证确定性层没有覆盖的最后集成风险。

工作：

- 多 seed 100～500 actions soak，跨多个 session/scope、重复压缩、MCP epoch、abort/retry/restart。
- OpenAI-compatible 与 Anthropic 真实 cache hit/miss/write 观测。
- compiled Web 从本次构建产物、仓库外临时 workspace、隔离平台目录启动。
- Web 检查 Context 粗略占用、cache breakdown/observed、压缩状态和 primary projection；subagent 不显示伪精确静态值。
- 记录 Provider endpoint/model/时间/结果，不记录 API key 或完整敏感 request。

主要入口：

```bash
pnpm run test:cache:real:openai-compatible
pnpm run test:cache:real:anthropic
pnpm run test:cache:real:m13
pnpm run test:e2e:compiled-web
```

DoD：外部门禁在提供凭据时真实运行而非 skip；compiled Web 使用本次 build；失败能区分产品缺陷、Provider 不支持和环境问题。

## 2.6 按包/目录的改动面

| 包/目录 | 规划动作 | 说明 |
|---|---|---|
| `docs/core/context/` | 修改 | 对齐权威目标、接口、状态所有权、阈值和测试策略 |
| `docs/core/context/improve-4-to-5-regression/` | 新增 | 本轮 00～04 与实施后 05 |
| `packages/ohbaby-agent/src/core/context/` | 先新增测试；按红测试最小修改 | Reference Model、failpoint、projection/request/compaction |
| `packages/ohbaby-agent/src/core/message/` | R3/R4 条件修改 | 只有原子提交或幂等写证据成立时扩端口 |
| `packages/ohbaby-agent/src/core/lifecycle/` | 主要补测试 | 防止 request bypass、retry/final/abort 回归 |
| `packages/ohbaby-agent/src/core/memory/` | 只补既有契约测试 | 不新增主动 Memory 能力 |
| `packages/ohbaby-agent/src/mcp/` | 主要补集成测试 | tool epoch、顺序、scope cleanup、prepare/send race |
| `packages/ohbaby-agent/src/services/interface-providers/` | 补 contract/诊断 | TokenUsage/cache 语义不变 |
| `packages/ohbaby-agent/src/runtime/`、`adapters/ui-*` | 补集成/E2E；按 LIF-08 红测试条件修改 | run identity、scope events、manual compact/prompt 串行、primary UI projection |
| `packages/ohbaby-agent/src/bus/`、`core/context/events.ts` | R2 修改 + contract | Context event scope、attempt identity、terminal outcome；subscriber 失败不改变 durable truth |
| `tests/integration/core/` | 新增/扩充 | 跨模块、真实存储、restart、primary/subagent |
| `scripts/` | 条件新增 | context soak/eval/真实外部门禁编排 |
| `package.json`、`pnpm-lock.yaml` | 条件修改 | 引入 `fast-check` 与便捷测试脚本时 |

## 2.7 API、存储、兼容与迁移

- R0～R2 默认不改变 production API/schema。
- R3 若需要原子提交端口，它应是内部 Context↔Message port，不扩公开 SDK/UI 协议。
- R3 若需要 durable operation marker，必须单独说明旧数据库兼容、orphan 恢复、清理与回滚；这是本计划中唯一可能接近单向门的决策，需要用户二次确认。
- R3 的 summary overflow 收缩是内部恢复行为，不改变 Provider wire protocol；普通 transient retry 与 overflow shrink 分开计数，防止重试预算相乘。
- runtime part、summary part 和旧 `time.compacted` 数据必须继续可读；不得为测试方便清空历史。
- TokenUsage、PromptCachePolicy、cache key 和 `PreparedModelRequest` 的已发布语义不得破坏。
- primary/subagent 不新增两套外部接口；公开静态 window 查询仍不接受不可信 child identity。

## 2.8 风险与回滚

| 风险 | 防御 | 回滚 |
|---|---|---|
| 属性 suite 过慢 | PR 固定较小 runs，nightly 扩大；记录时长预算 | 降低 runs，不删除不变量 |
| 随机测试 flaky | 固定 seed、shrinking、fake clock/barrier、无 sleep | 隔离有问题 generator；不能靠 retry 隐藏 |
| 新事务端口扩大 Message 职责 | Context 定义窄 port；Message adapter 实现；conformance suite | 保留测试，回退生产抽象并重新选 durable marker |
| per-scope lane 变成全局锁 | key 强制为 session+scope；异 scope barrier 必须证明真实并行 | 回退实现，保留并发契约测试 |
| summary overflow shrink 丢 tool pairing/近期约束 | 只删除完整 turn/API round；每轮重新 normalize/校验 | 停止提交，保留原文并返回明确 terminal failure |
| event schema 扩展影响消费者 | primary wire scope 可选以兼容旧 payload，但内部先归一为 primary identity；event catalog/adapter contract 全跑 | 保留 durable 改动，兼容投影旧 payload 读取 |
| failpoint test 绑定实现步骤 | 故障点按 durable boundary 命名，不断言私有 helper | 重写 fixture，不降低终态不变量 |
| Summary eval 不稳定 | 规则断言为主，judge nightly + 人工校准 | judge 不阻塞 commit，保留结构硬门 |
| 真实 Provider 波动 | 明确 opt-in、记录 provider capability 与响应 | 不回退确定性 gate；外部失败单独归因 |
| 文档与代码再次漂移 | R0 更新权威文档；验收对照 02/04 | 阻断验收，不以代码现状偷偷改目标 |

## 2.9 批次提交与审查纪律

建议每批至少一个逻辑原子 commit：

1. `test(context): define joint regression invariants`
2. `test(context): add scoped state-machine coverage`
3. `test(context): cover compaction failure recovery`
4. `fix(context): bound summary overflow and serialize scoped compaction`（仅红测试成立时）
5. `fix(context): make proven state transitions recoverable`（仅红测试成立时）
6. `test(context): verify memory and cache prefix stability`
7. `test(context): add context soak and release gates`

每批独立审查问题：

- 是否仍同时覆盖 primary/subagent？
- 是否把 hypothesis 误写成事实？
- 测试是否能在旧实现上因目标缺陷而失败？
- production 修改是否有对应红测试？
- 是否引入了超出本批的 Memory/事件溯源/SDK 能力？
- 是否保持 `PreparedModelRequest` 单一真相源？

## 2.10 不在本批

- 自动长期记忆、Memory 工具、RAG/embedding。
- 基于 telemetry 的压缩阈值重新调优。
- Provider overflow 后的 observed-window adaptive ceiling、持久化和过期策略。
- 全仓库测试规范重写；本轮沿用既有 unit/contract/integration/smoke 分类。
- 无证据的 Context 全量拆包或事件溯源迁移。
- improve-4～5 之外的全产品回归。
- merge main、push 或发布；由后续实施/交付指令决定。
