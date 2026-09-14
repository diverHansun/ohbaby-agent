# 2. 方案与改动面

> 规划草案，等待用户审核后由实施会话执行。依据 00；现状证据见 01；测试门见 04。不是实施进度表。

## 2.1 架构与数据流

保留现有模块，不新增 TokenManager、通用计量层、统一状态枚举、样本存储或关联 ID。先把目前正确但容易误用的合同写清并用测试保护，再做必要参数命名与注释。

```text
context：准备实际请求快照 + 原始 sentHeuristic
  → provider adapter：投影请求、接收响应、归一单次 TokenUsage
  → llm-client / lifecycle：消费最终结果
       ├─ 单次 inputTokens + 对应 sentHeuristic → context 校准
       ├─ 单次 TokenUsage → 本次 Run 累计
       ├─ 单次 TokenUsage → message metadata（有承载 Part 时）
       └─ 单次事件 → worker / stream bridge（观察，不重新计量）
context：后续测量按原系数规则 → window usage
```

这是职责图，不承诺四个消费者的数据库事务或副作用原子性；具体事件、写库、校准时机保留现状。不得为了让图变成串行管道而移动代码。

### 核心用例

1. 正常多步：每次请求原始估算配本次响应输入；Run 累计单独累加。一个响应带多个工具不多算 usage。
2. 同一步重试：context overflow 后重新 prepare B，响应必须配 B 的 sentHeuristic，不能配最初 A。失败尝试不新增账本。
3. 缺失/失败：有 finalEvent 无 usage 时走现有 incomplete 累计；无 finalEvent/抛错按原路径退出。已处理 usage 后发生取消或 length 不回滚校准或累计。

## 2.2 精确数据合同与命名

### 字段表（本轮唯一替换表）

| 现有项                                                                            | 本轮目标             | 含义/限制                                                           |
| --------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `ContextManager.updateCalibrationFactor` 的 `realPromptTokens` 参数及实现局部变量 | `actualInputTokens`  | 单响应归一后的 inclusive 输入；仅参数名，不改位置参数签名或调用数据 |
| `PreparedTurn.request` / `sentHeuristic`                                          | 保留名称、补必要注释 | 同一实际请求准备结果；不是供应商 wire 的精确 token 计量             |
| `PreparedTurn.usage.currentTokens`                                                | 保留                 | 校准后占用，不能回填为原始估算                                      |
| `TokenUsage` / `InterfaceProviderTokenUsage`                                      | 保留                 | 单响应 provider 报告值，不搬迁 owner，不新增同义类型                |
| `LifecycleResult.usage` / `LifecycleTokenUsage`                                   | 保留、说明 Run 范围  | 本次 Lifecycle.run 的累计，不是 Session 总账或单次样本              |
| `usageComplete`                                                                   | 保留、补覆盖范围注释 | 只覆盖进入现有 aggregate 流程的结果，不承诺所有失败/重试尝试        |
| `inputBreakdown` / `observed`                                                     | 保留                 | 明细可用性独立于响应终态、累计完整性                                |
| metadata 旧 `promptTokens/completionTokens`                                       | 保留 reader 兼容     | 不是 improve-3 已删除的公开 Chat 别名，不再新写旧形状               |
| SDK/UI `UiContextWindowUsage`、`promptCacheUsage`                                 | 保留全部字段         | 不因本轮核对而重命名公开 DTO                                        |

`actualInputTokens` 是供应商报告值，不代表独立 tokenizer 或费用核算。以上是封闭改名清单；其他生产字段改名须先更新规划并由用户确认，不在实施中自由扩展。

### 不变量 K1–K8

- **K1 请求配对**：使用实际返回结果对应的 prepared；不用重算历史、最早 prepared、累计值、输出值或已校准占用作为分母/分子。
- **K2 归一口径**：input inclusive；total = input + output；有效 breakdown 三项相加 = input。cache 命中仍占窗口。保留各协议已有缺字段/冲突/累计处理，core 不解析原始字段。
- **K3 状态分离**：终态、usageComplete、明细 observed 分开；单步缺 usage 不造零对象。累计可有已知零小计且 incomplete，不能只检查数值。
- **K4 时机与范围**：保留校准输入过滤、EMA/clamp、调用顺序及 scopedSessionKey、dispose 行为；不添加 model/Run 维度、自动重置、重启恢复训练。
- **K5 持久化**：新写 canonical，reader 兼容 legacy；每步最多一个 Part 携带 usage，无 Part 不造 Part；不承诺累计与所有历史 Part 之和永远相等。
- **K6 传输与辅助隔离**：worker/bridge 传递原 canonical；summary/title 不混入 agent-step 校准或 Run 累计；父子 scope 不串用。
- **K7 数值基线**：相同输入、初始状态、provider 事件序列下，估算、系数、累计、占用、七桶、预算与压缩决策保持。七桶无需等于校准总量。
- **K8 工程约束**：不增加生产网络请求、数据库表、长期 Map、事件或日志框架，不额外扫描历史；测量和发送仍消费同一请求快照。

### 异常行为冻结表

| 输入/退出点                                                   | 必须保持的行为                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| finalEvent 存在，tokenUsage 缺失                              | 本次 aggregate 标记 incomplete；不校准、不造该步 metadata     |
| 有已知累计，下一次无 finalEvent 或 providerFailure 等受控返回 | 返回已有累计；不新增一次 aggregate(undefined)                 |
| 未分类异常原样抛出                                            | 保持 throw，不新增兜底 LifecycleResult 或聚合；不承诺返回小计 |
| 有效 usage 已处理，随后 abort/length                          | 保留原累计和校准时机，不因 Run 失败撤销                       |
| input/output 有效，breakdown 不合法                           | 按已有 normalizer/reader 丢明细保总量；不新增过滤策略         |
| sentHeuristic 非正/非有限，actual 非有限                      | 保留当前不更新；不增加其他拒绝条件                            |
| reasoning-only / 没有可承载 Part                              | 不为 usage 造空 Part；运行时 usage 与持久化覆盖范围不同       |

## 2.3 三个实施批次

### A：固定合同与行为基线

- 在现有 `core/lifecycle/lifecycle.unit.test.ts` 补足 P2/P3：差异明显的两步样本、强制 prepare A/B 后配 B、有终态缺 usage 与无终态退出的区别、usage 处理后取消/length。
- 新增 `tests/integration/core/usage-calibration.integration.test.ts`：真实 Lifecycle、ContextManager、llm-client、message manager 与内存 store；只替换外部 provider 网络，固定三协议原生响应经真实 adapter 后进入链路。用公开边界记录请求准备和校准入参，记录同时调用原实现，不 mock 掉被测算法。
- 在该集成文件验证分支配对/跨步实际系数效果；允许复用已有 provider 测试 fixture 的最小必要事件，不新增通用测试框架。
- 复用已有 estimator、manager、metadata、transport、scope 回归；能用现有断言证明的，不重复造测试。
- **DoD**：04 的 T1–T8 对应基线可重复，标明新增保护/既有复用。纯行为保护用例可在基线通过；若有失败，先分类，不能为了红绿过程主动改坏生产代码。

### B：最小命名与接口说明

- `core/context/types.ts`、`context-manager.ts` 仅替换上述参数名及必要注释；不改参数数量/顺序、默认值、公式或调用位置。
- `core/lifecycle/types.ts` 说明单次/Run 累计及 usageComplete 边界；必要时在 `lifecycle.ts` 原调用点补注释，不移动分支。
- `services/interface-providers/types.ts` 补 input inclusive 与 breakdown/observed 语义说明，不改类型成员。
- 核对 exports/worker/SDK/UI 消费，保留其签名及 DTO。metadata、tokenCounting、window、cache 生产文件不改；无已证实接线 bug，不预授权功能性修复。
- **DoD**：A 全绿；T9 证明封闭改名和公开接口不变；每项生产差异均能归入参数名/注释，T10 数值基线不漂移。

### C：生产链路与最终验收

- 扩展既有 `tests/smoke/responses-migration.real.e2e.test.ts`，被动记录本步 prepared 和 updateCalibrationFactor 入参，调用原实现；检查单步 usage、Run 小计、可承载 Part 的 metadata 及下一步关系。保留原请求/工具/预算断言，不新增生产钩子。
- 原 runner 的内存 store 和测试 TokenCounter 不等于真实 SQLite/真实估算精度；SQLite reopen 与固定算法由本地 T7/T10 单独证明。不能把 live 结果包装成精确计数或落库全链路验收。
- 各批定向测试、unit/integration/相关 contract、子代理审查后分批 commit；最后 T11 全量 preflight、T12 三协议 live。失败和补跑分次记账。
- **DoD**：全部 04 门满足，独立验收生成 05，用户复核后才讨论合入集成分支。不得回写本 02 为进度表。

## 2.4 包与文件改动面

| 范围                                                  | 新增/修改                             | 不做                                 |
| ----------------------------------------------------- | ------------------------------------- | ------------------------------------ |
| agent context/lifecycle/provider types                | 参数名、注释；现有单测补断言          | 新框架、算法或状态类型               |
| tests/integration/core                                | 一个聚焦的 usage-calibration 集成文件 | 新通用 harness/package               |
| tests/smoke 既有 real runner                          | 被动配对证据和断言                    | 新计费请求、放宽模型终态或原生限制   |
| message、tokenCounting、cache、window、worker、SDK/UI | 只核对和回归，必要测试补断言          | 生产公式/DTO/schema 变更             |
| 本目录                                                | 00–04 规划；未来实施后 05             | 重写原 llm-client 平铺设计或历史验收 |

## 2.5 兼容与实施前置

没有公开 API 删除、数据库迁移、版本号或新依赖。`realPromptTokens` 为位置参数名称，不是 JSON key；旧 metadata reader 继续接收 unknown。外部参考中的 uncached/disjoint 输入不能直接替代 ohbaby inclusive input。

实施前记录集成分支与临时分支 SHA、检查工作区；确认 improve-3 合入前置及本轮用户授权。未通过前只可规划。后续实现不把旧的 05 测试数字当成本轮执行。

## 2.6 风险与回滚

基线失败先定位为环境/存量/合同问题。算法或时机差异必须给出最小复现、改前改后值及影响消费者，暂停受影响改动等待用户决定；不自动调整冻结合同。其余不受影响的文档/检查可继续。

三批分别提交，便于按批准范围 revert 本轮提交；不重置共享历史，不删除用户变更。无 schema 迁移，无需重写数据库。若任何改动需要新增网络/状态/存储或改公开字段，先回到规划，不视作普通实现细节。

## 2.7 与 00 对齐

00 的目标由 K1–K8 和 T1–T12 覆盖；所有冻结算法及兼容路径留存。改动不以精度、占用下降、缓存提升作为成果。测试发现问题不自动扩大本轮权限。

## 2.8 后续候选，不在本轮

1. 独立 cache 命中处理：公式、控制策略与缺失策略需另定合同。
2. cache 议题完成后，再检查已有窗口占用、压缩机制及其准确度；本轮不提前调整。
3. 更准确的 estimator/tokenizer、真实 wire 材料、替换 legacy 桥、anchor + trailing 算法、模型维度校准另排。
4. 全部失败/重试尝试用量完整性、费用和长期账本、持久化校准另排。
5. 原生 reasoning/phase/签名续接、previous_response_id、Conversations、hosted tools、默认 Responses 另排。
6. improve-3 T2 完整请求联合矩阵、Qwen 偶发根因、CLI packaging 超时属于已知独立限制，不当作本轮接口整理的既成修复。

新轮需按本轮实际 05 和用户决定开启，不预创建目录。所有迁移、token、cache、context、lifecycle 总体验收后才讨论集成分支合 main。

## 2.9 关键改动清单

> 用户已要求。行号为生产基线 `734f2ef6` 快照，定位以符号为准；不是进度表，不在实施中同步行号或勾选。其他被扫描文件不因此变成必改。

| ID  | 路径                                                            | 符号/行号快照                                          | 必要动作                                       | 验收        |
| --- | --------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- | ----------- |
| C1  | packages/ohbaby-agent/src/core/context/types.ts                 | PreparedTurn:203、updateCalibrationFactor:228          | 解释配对；realPromptTokens → actualInputTokens | T2–T5、T9   |
| C2  | packages/ohbaby-agent/src/core/context/context-manager.ts       | updateCalibrationFactor:299                            | 同步参数名和注释，不改过滤/clamp/EMA/Map       | T4、T5、T10 |
| C3  | packages/ohbaby-agent/src/core/lifecycle/types.ts               | LifecycleResult:239、LifecycleTokenUsage:250           | 说明 Run 和有限的 usageComplete 含义           | T3、T9      |
| C4  | packages/ohbaby-agent/src/services/interface-providers/types.ts | InputTokenBreakdown:40、InterfaceProviderTokenUsage:50 | 说明 inclusive、明细可用性，不改结构           | T1、T9      |
| V1  | packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts | 校准:599、overflow:1745                                | 补同 Step 重准备和异常时机保护                 | T2、T3      |
| V2  | tests/integration/core/usage-calibration.integration.test.ts    | 新增                                                   | 原生三协议响应至真实校准链                     | T1、T2、T4  |
| V3  | tests/smoke/responses-migration.real.e2e.test.ts                | PROFILES、真实 lifecycle runner                        | 不增请求地补配对/metadata证据                  | T12         |

连带项：lifecycle.ts 原调用点可补注释；已有 metadata/scope/transport/window/cache 单元与集成测试复用或补断言，具体见 04。权威合同是本 02 和 04；原模块历史文档不批量改写。
