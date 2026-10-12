# improve-1 测试与验收

> 依据：[00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md)、[02](./02-optimization-plan-and-change-scope.md)，整体验收目标见 [`../plan/04`](../plan/04-test-and-acceptance.md)。本文件是**待实施**目标，不是已通过结果。
> 使用仓库已有 Vitest 与集成测试，不新建测试框架，不以覆盖率数字代替风险验证。

## 1. 范围与分层

第 1 批只验三类：**预算与计数算对**、**能力与偏好分离**、**未读历史不退场**。请求形状／缓存（第 3 批）、工具投影（第 2 批）、容量分流与原子切换（第 4 批）不在本批断言。

- 单元／契约：预算解析、投影计数、可选字段结构、前缀表删除后的解析结果。
- 内存集成：用内存存储与模拟摘要客户端复现“超窗恢复”路径，断言退场范围。
- 真实 API 探测：本批收尾动作（见 §4），本次未执行。

## 2. 本批用例（对应整体 plan 的 A1～A5）

### A1 计数同源，不重算、不漏计

- 同一份历史材料，普通请求估算、尾段估算（`estimateHistoryForCompaction`）与最终回传表示一致。
- **显示用 reasoning 不重复算**：给人看的 reasoning part 不进入模型输入，也不额外计入估算。
- **兼容内存 reasoning 不漏计**：在“缺少原生状态、仍有 `activeReasoningByMessageId` 回传”的场景，尾段估算与完整请求估算得出同一量级（修复前会少算）。构造样本：一条 assistant 消息带工具调用、无原生状态、有内存 reasoning。
- **opaque 代理有来源**：opaque 状态的估算来自已声明的保守来源（真实 reasoning 用量／总输出／该次 maxTokens），不是密文字符数；未知时标不确定性，不冒充精确值。
- 复用位置：`core/context/token-estimation.unit.test.ts`、`core/context/native-context.unit.test.ts`；新增覆盖 `estimateHistoryForCompaction` 的入参用例。

### A2 预算解析层：发送额度 = 预留额度；能力 ≠ 偏好

- 对**无 thinking／fixed B／effort-only** 三类输入，解析出的**发送额度与预留额度相等**，且无 `reservedOutputTokens` 被 50% 帽缩小的漂移。
  - 注：“三类最终输出满足实际协议 wire”属第 3 批，不在本批断言；本批只验解析层。
- **删表验证**：未配 `models[]` 时，`resolve()` 结果等于探测值／默认值，不再被 `BUILTIN_PROFILE_RULES` 前缀覆盖（如 `gpt-5`、`claude-*` 不再命中内置窗口／输出）。
- **`maxOutputTokens` 只来自 `llmParams.maxTokens`**：`apply-active-model-config` 在未配 maxOutput 时不再回填 builtin 输出上限。
- **缺省统一 8192**：未配 maxOutput 时，`writer` 与 `modelProfiles` 的缺省都是 8192。
- 复用位置：`services/llm-model/modelProfiles.unit.test.ts`、`services/llm-model/tokenCounting.unit.test.ts`、`config/llm/__tests__/apply-active-model-config.unit.test.ts`；按要求改写（见下 §3 的删除清单）。

### A3 不新增 32K 帽、不暗降 B

- fixed B 达到或超过 32K、但实际模型能力允许时，**不被人工 32K 帽拒绝**；本次输出额度按“正文基础 ＋ B”形状解析（正文基础数值由第 3 批设定，本批只保证解析机制不额外加帽）。
- 实际能力（cap）不大于 B 时，**明确失败**（沿用 `reasoning.ts:341` 的校验），不自动压低 B。
- **无发送漂移**：不能出现“本地按 50% 预留小值、发送按真实值”的不一致。
- 复用位置：`services/interface-providers/reasoning.unit.test.ts`；新增/改写预算一致性用例。

### A4 可选 usage 结构；缺失 ≠ 0

- `ModelRequestRecord` 新增的 `usage` 是**可选**字段；缺失保持 `undefined`，不写 0。
- `InterfaceProviderTokenUsage` 的可选 reasoning 子项：是 output 的子项（`reasoningTokens <= outputTokens`），**不参与 total 再求和**；缺失与 0 区分；不合理值（大于 output）丢弃或标未知。
- **不新建用量表，不生成假的普通消息或 run**；`ModelRequestRecord` 对普通请求的必填所有权不变。
- 本批只验结构；“摘要成功时随摘要消息的 `modelRequests` 同事务落库、失败／中断只写一行日志”属第 4 批。
- 复用位置：`services/interface-providers/token-usage` 相关单测、`core/message/database-store.integration.test.ts`（记录持久化路径）。

### A5 未读历史不退场（本批 bug 修复）

- **模拟摘要超窗**：在隔离前置 prune 的样本中，让首次摘要调用抛超窗错误；预设第二次会成功，用调用次数断言它根本没有发生。
- 断言直接返回失败，没有摘要候选、摘要消息或摘要覆盖退场；原始 parts 不变。第 1 批尚未删除前置 prune，不把其独立行为混进本用例；第 3 批再验完整流程失败不留 prune 副作用。
- 成功样本另验摘要候选的覆盖范围等于实际发送范围。后续模式 A 的显式遗漏退场按第 4 批 E7 验证。
- 复用位置：`core/context/compaction-atomic.integration.test.ts`（原子／退场语义）、`core/context/context-manager` 相关集成测试；新增超窗恢复用例。

## 3. 与删除清单对应的测试改写

按 [`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §9.3，删表要**连测试一起改**，不留“断言 builtin 数值”的旧用例：

- 删：`services/llm-model/modelProfiles.unit.test.ts:8-45`、`:75-94`（断言 builtin 来源与具体数值）；`services/llm-model/tokenCounting.unit.test.ts:37`、`:47`（断言 `gpt-4`→8192、`gpt-4o`→128K 这类前缀派生值）；`config/llm/__tests__/apply-active-model-config.unit.test.ts:160` 一带断言 builtin 回填的用例。
- 改验：**探测／默认值不被前缀表覆盖**；**未配 maxOutput 时统一缺省 8192**。
- 不受影响：用显式 user profile 的用例。

## 4. 真实 API 收尾（本次未执行）

- 每批完成时用 `tests/models-4-tests.md` 里的模型与真实 api-key，在 agent 自己启动的独立 ohbaby 服务、独立测试会话和数据目录里发真实请求；不占用用户现有服务，凭据不写进规划、命令行参数、日志、fixture 或审查提示。来源：讨论记录 §17.8、[`../plan/04`](../plan/04-test-and-acceptance.md) §4。
- 本批探测内容：核对**真实 usage、reasoning 子项是否存在、模型能力与实际输出参数**；记录提供商**未返回哪些明细**（未知保持未知）。
- 依据：`tests/models-4-tests.md`（不读取、不复制凭据）。
- **本轮规划未执行**任何真实请求；上面是实施完成后必须补做的收尾。

## 5. 定向命令（示例）

在仓库根执行；这是**待实施的定向命令**，不是“验收项已被现有测试覆盖”的声明：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context/token-estimation.unit.test.ts \
  packages/ohbaby-agent/src/core/context/native-context.unit.test.ts \
  packages/ohbaby-agent/src/services/llm-model/modelProfiles.unit.test.ts \
  packages/ohbaby-agent/src/services/llm-model/tokenCounting.unit.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/reasoning.unit.test.ts \
  packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts
```

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context/compaction-atomic.integration.test.ts \
  packages/ohbaby-agent/src/core/message/database-store.integration.test.ts
```

实施后按实际变更记录真实命令、通过／失败、尚未覆盖范围与证据；改行为必须跑对应风险用例与必要静态检查（typecheck）。

## 6. 验收判据与对抗性检查

- **算对**：A1～A4 的断言全部通过，且没有任何“缺失写成 0”“total 多算一次”“发送 ≠ 预留”的反例。
- **真生效**：删表后写用例证明探测／默认值确实生效，不能只看代码里删了函数。
- **不残留**：没有为删表、缺省统一、移除分支留下临时开关或无操作兼容壳（[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §9 共同纪律）。
- **不越界**：没有顺手改工具投影、请求形状、缓存、prune／mask、重试次数、压缩次数上限或抖动锁。
- **对抗性审查**：先独立找反例（尤其是“预算语义改动”对 mask／overflow 消费者时序的间接影响），主代理验证关键事实并记录取舍；模型意见不是通过证明。

## 7. 记录去向

本批实施与验收记录后续写进本目录；实施完成后由验收模式产出 `05-implementation-acceptance.md`（规划期不存在）。plan 不提前生成验收通过结论，也不新建自检报告文件。
