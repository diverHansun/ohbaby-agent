# Context 模块：测试策略

当前契约已同步 [Compact 议题第 5 批](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/02-optimization-plan-and-change-scope.md)（2026-10-13）。测试范围见[本批测试与验收标准](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/04-test-and-acceptance.md)，实际结果见[本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/05-implementation-acceptance.md)。文末先前批次章节仅保留历史设计；与当前正文冲突时，以当前正文为准。

本文定义 Context 的长期测试职责。improve-4～5 联合回归的完整 ID、故障矩阵和发布门见 [04-test-and-acceptance.md](./improve-4-to-5-regression/04-test-and-acceptance.md)。

## 一、测试回答什么

1. 测量和 Provider 是否消费同一 `PreparedModelRequest`？
2. summary/retry/restart 后模型可见 history 是否唯一、tool pairing 是否合法？
3. primary、child/sibling scope 是否隔离？
4. 部分写、并发、abort 和 hard crash 后 durable truth 是否可恢复？
5. 同 run/epoch 的 system、runtime、tools 前缀是否稳定？
6. 模式 A/B 是否保护必留内容、保持工具配对，且未读又未保留的原文仅随成功摘要明确记为遗漏？
7. Context event 是否属于正确 scope/attempt，且不会冒充 durable truth？

## 二、分层职责

| 层 | 典型对象 | 目标 |
|---|---|---|
| unit | compaction policy、cut point、usage、serializer、reference reducer | 快速验证纯逻辑和边界 |
| contract | `PreparedModelRequest`、Context event、Message atomic/idempotent port、Provider cache usage | 防止消费者可见语义漂移 |
| integration | Context + MessageStore + Lifecycle + ToolScheduler/MCP + Bus | 验证真实数据流、并发和重建 |
| smoke/e2e | build、serve/Web、真实 Provider | 验证发布产物和外部 capability |
| property/fault/soak | 上述层的运行方式 | 扩大动作组合、故障点和序列长度 |

E2E 不替代 unit/contract/fault；real-provider skip 不等于 pass。

## 三、关键不变量

- measured `{ messages, tools }` 与 adapter 实际输入深等价。
- `PreparedModelRequest` 创建后不可被 MCP load、permission change、retry 或调用方 mutation 改写。
- `ContextUsage.usageRatio` 使用完整输出预留后的 input budget；无半窗触发计算。summary 使用 `currentTokens / contextLimit >= 0.90`，并验证 `ordinaryInput >= ordinaryInputBudget || summaryInput + ordinaryMaxTokens >= summaryInputBudget`；成功地板只抑制相同容量且未增长的自动重复触发。
- cache read/write/uncached 是 inclusive input breakdown，不改变窗口占用总量。
- summary 与被替代原文不同时 active；失败不声称成功。
- 同 initiating message 的 runtime part 基数不超过 1，包括并发/多 manager/restart。
- 同 scope compaction/prompt mutation 串行，store 在实际写入口检查 Stop 并校验退场 parts 和相关完整 messages；冲突返回 failed，异 scope 可并发，新建独立输入消息不误冲突。
- restart 后 canonical model view 与 deterministic repair 等价；恢复零 LLM、零历史 event。
- primary/subagent 的 history、calibration、compaction floor、tool epoch、cache identity 和 event 不串。

## 四、重点场景

### 4.1 Request

- ordinary primary/subagent step；
- final-step `tailDirectives` 只出现一次且 tools=`[]`；
- overflow → 一次 force prepare → 容量与收益通过后发送新 request；同一步输入快照重入不重新获额，二次 overflow 终止；
- prepare 后 lazy MCP/permission change 不改当前 request，只改下一 request；
- active reasoning/tool loop 不修改已发送 prefix。

### 4.2 Budget ladder

| 输入 | 预期 |
|---|---|
| 完整窗口占用 `0.89999` 且普通输入、摘要输入加普通 maxTokens 均未到边界 | 不进入 summary |
| 完整窗口占用 `0.90`，无成功地板抑制 | `summary` |
| 占用 `<0.90`、普通输入到自身预算或摘要输入加普通 maxTokens 到摘要预算 | `summary`，仍检查同容量成功地板 |
| 成功后仍高于触发线，相同容量且占用未高于地板 | `none`，不重复调用摘要 |
| 占用严格高于地板或窗口／输出预留等容量条件变化 | 重新判断触发与完整容量，不受旧地板阻挡 |
| ordinaryMaxTokens 小于 summaryMaxTokens，当前输入均放得下但摘要输入加普通 maxTokens 到界 | 在发送普通请求前触发 summary |
| 摘要完整输入已超过自身可用容量 | 模式 A 只裁请求副本的较老可裁完整组；仍放不下则 Provider 零调用、原历史不变 |
| 手动 compact／显式 `force=true` | 豁免成功地板，但仍受容量、收益、保护集合及请求总额度约束 |

### 4.3 Compaction/failure

- 64K／200K／1M 窗口均使用固定 20,000-token 尾段，保留完整组、未闭合依赖和至少最近一组；全部活动旧摘要进入新的单滚动摘要；
- 模式 A 的本地超窗与 Provider overflow、transient/overflow 混合顺序共用最多两次实际请求；保护旧摘要、近期内容与新输入，不拆工具配对；
- 模式 B 覆盖输入单独可放、加普通输出才超窗，固定材料及受保护输入只计一次；不另发摘要，最近完整组仍装不下则零提交；
- 最终正文包含宿主文件操作和遗漏说明，合计不超过 16,384 tokens；遗漏精确 part IDs、原因和成功 request ownership 随摘要同事务保存，SQLite 重开可查；
- 无旧段不请求摘要但检查普通容量；摘要失败、无收益、abort 不提交候选，自动最终失败终止运行，保留原历史与已完成工具结果；
- create summary、append part、第 N 个 compacted update、commit 后 event 前故障；
- hard SIGKILL 等待 marker 精确内容，不只等待文件存在；
- auto+auto、manual+auto、manual+manual、manual+prompt；后端手动准入拒绝忙和重复请求，不等待、不停止工具；
- primary 与 child 同时 compact；
- 既有 mutation lane 等待期间 Stop 零写入，手动／自动都能在摘要网络重试等待中取消；提交后 Stop 保留成功；退场 parts 或相关工具组变化时冲突失败，新输入消息保持 active；
- 同一 run 随占用增长连续成功三次，无增长不重复触发；不展开已经退场的旧 summary。

### 4.4 Scope/event/replay

- primary 缺省 scope 只归一为 primary；child 带精确 scope；
- sibling event 交错可按 session/scope/attempt 唯一分组；
- accepted attempt 的 progress/terminal 共用 ID 且 terminal 恰好一次；
- event publish/subscriber 失败不回滚 durable commit；
- reopen 不重发 event、不调用 summary LLM；旧摘要、完整工具原文及 `time.compacted` 均按原契约读取，退场内容不复活。
- `CompactionThresholds` 仅含 summary；类型检查与事件目录契约共同覆盖常量、导出、调用方和登记的一致性。

### 4.5 说明文件与 prefix/cache

- global/project `OHBABY.md` 路径边界、失败降级、run 内稳定；
- 主、子共用说明，选中文件只注入一次，历史字面 `<memory>` 不改写；
- runtime metadata 不进入 UI/title/export；摘要请求继承普通 prepared 中模型可见的 runtime context，不额外复制或重建；
- 同 tool epoch wire order 稳定，有意 epoch 变化只失效一次后重新稳定；
- cache key 基于 session + scope，tool epoch 不写入 key；
- Provider usage 的 observed zero 与 unavailable 区分。

## 五、测试支撑件

| Fixture | 作用 |
|---|---|
| deterministic `TokenCounter` | 构造精确预算/cut point |
| scripted `ContextLLMClient` | summary success/failure/inflation/overflow/abort |
| request-capturing Provider | 对比 measured/sent wire input |
| failpoint Message adapter | 在 durable boundary 第 N 次失败 |
| store conformance suite | 同一契约跑 in-memory/SQLite |
| barrier/latch | 控制 snapshot/MCP/compact/tool 时序 |
| fail-on-resume client | 恢复期调用 LLM 立即失败 |
| fake clock | 验证 metadata/event/lease，不使用 sleep |
| canonical model-view serializer | live/restart 可稳定 diff |

fixture 必须实现真实 typed port；禁止万能 mock、test-only production getter 或预置 `usageAfter` 自证成功。

## 六、测试组织

- co-located unit/contract：`packages/ohbaby-agent/src/core/context/*.unit.test.ts`、`*.contract.test.ts`；
- Context serializer/store integration：同源码目录的 `*.integration.test.ts`；
- 跨模块集成：`tests/integration/core/`；
- 外部 gate：`*.real.test.ts`、`scripts/run-real-cache-smoke.mjs`、compiled Web runner。

真实故障必须以问题形状命名，不使用 `case1`。属性失败必须输出 seed、shrunk trace、session/scope、expected/actual canonical diff。

## 七、执行门禁

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run test:smoke
pnpm run build
```

联合回归新增入口实施后应包括：

```text
test:context:regression
test:context:property
test:context:restart
test:context:soak
test:context:eval
```

这些脚本不存在时不得在验收报告中宣称已运行。

## 八、防假绿规则

- 不只断言“不抛错”或 `toBeTruthy()`。
- 不在同一 manager/store 对象里模拟 restart。
- 不用 wall-clock `sleep()` 制造竞态。
- 不自动 retry flaky 测试后报绿。
- 不把 real-provider skip 写成 pass。
- 不只测 primary 后宣称 subagent 覆盖。
- 不只比较 cache key 字符串而忽略 Provider-relevant prefix。
- 不用不同 model/tools/tail directives 的 usage 比较证明压缩成功。

## 九、验收关系

本文件描述长期模块规则，不表示所有门禁已经运行。既有联合回归见 `improve-4-to-5-regression/04-test-and-acceptance.md`；本次 Compact 议题的执行范围见[第 5 批测试合同](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/04-test-and-acceptance.md)。实际命令、实网结果与未覆盖范围由本批验收记录说明。

## improve-1 新增回归（2026-10-13）（历史记录）

- 尾段计数严格对照正式请求投影，覆盖工具 metadata、活动 reasoning、展示副本和原生 opaque 状态；逐消息切点也接受同一 Map。
- 输出超过半窗与输入预算为零时，完整预留不缩小，mask/thrash 仍按旧阈值触发和解锁。
- 正常摘要成功后的精确退场 part IDs 等于发送历史；超窗失败没有缩水请求或摘要提交。
- usage reasoning 保持可选、缺失不填零、总量不重复相加；本批真实三协议服务结果见[验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-1/05-implementation-acceptance.md)。

## Compact 议题 improve-2 回归（历史记录）

`serializer.integration.test.ts` 用真实 MCP adapter、scheduler、lifecycle 和 SQLite 验证 error metadata 接回、错误与结构化内容不重复、两个大结果完整、预算变化下的稳定性、普通／摘要工具投影及计数在重开后相同；另验 aborted 部分输出与错误各一次。adapter 单测覆盖媒体文本表达和 resource URI，scheduler 单测覆盖非法 metadata 及注册来源。Read 多字节分页与子代理文件引用／Read 授权沿用既有回归。真实独立服务的分页、工具错误、子代理与重启结果见 [本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-2/05-implementation-acceptance.md)。

## Compact 议题 improve-3 回归职责（历史记录）

- 验证摘要派生自普通 prepared：system、tools、model、reasoning、tail directives、native state 和同一 mask 投影保持，只有追加 user 指令、输出预算与 purpose 为允许差异；不使用 transcript 重建。
- 容量测试同时覆盖等于边界、比边界少 1、普通输出小于摘要输出，以及 thrash/cap 不被容量压力绕过；摘要实际发送只按独立 summaryInputBudget 校验，单次巨型输入跨窗时零 Provider 调用。提前预留仅使用已申请普通 maxTokens，不引入预测增长或新 ratio。
- 三协议最终 wire 断言 cache key／标记及 thinking 字段稳定；正文 16,384 与数字 B／effort 预留分别验证，budget 大于半窗也不得静默缩小。
- Context transient 首次失败可再试一次，总实际 HTTP 请求最多两次；第三次预设成功不能调用。overflow、abort、空白、length、工具调用、协议缺终态不重试；三个 SDK `maxRetries: 0`。
- 逐次 requests records 保留 usage、attempt 和 compaction／summary identity；成功仅随结果返回，SQLite 不新增摘要 assistant.modelRequests。失败、无收益和 stale 不提交摘要，不把日志观测当作持久化。
- prune 返回值、事件、bridge、UI／SDK 消费链均不再存在；已有 compacted marks 仍正常读取。mask 本批保留并验证普通／摘要一致性；旧尾段算法与次数规则不按第 4 批目标冒写为已完成。

本节列出本批测试职责，不代表实网验收已通过。实际执行与三协议证据由 Compact 议题第 3 批验收文档记录。
