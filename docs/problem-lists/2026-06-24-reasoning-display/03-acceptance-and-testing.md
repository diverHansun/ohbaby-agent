# 03 · 验收与测试标准：reasoning（CoT）显示与 context 处理

> 日期：2026-06-24
> 依赖：[01-problem-analysis.md](./01-problem-analysis.md) · [02-design-and-implementation.md](./02-design-and-implementation.md)

## 1. 验收标准（Acceptance Criteria）

### AC-1 实时流式显示
- **CLI**：openai-compatible 模型返回 `reasoning_content` 时，CLI 在当前 assistant 回答上方**逐字流式**显示 reasoning。
- **web**：同一会话在 web 端以可折叠区块**逐字流式**显示 reasoning。

### AC-2 完成后折叠
- 本轮正式 content 开始输出 / 本轮结束后，reasoning 区块**自动折叠**为摘要行（CLI）/ collapse（web）。
- **无显示开关**；默认折叠（折叠后仍可手动展开，若 UI 支持）。

### AC-3 不落盘
- 一次包含 reasoning 的完整会话后，sqlite 中**不存在** `type = "reasoning"` 的 part 记录。
- 会话重载（reload）后**不重现**历史 reasoning，且不报错。

### AC-4 跨轮不进 context
- 第二轮及以后的模型请求 body 中，**历史 turn 的 assistant 消息不含** `reasoning_content`。
- reasoning 文本**不混入** assistant 消息的 `content`。

### AC-5 同轮回传（DeepSeek 兼容）
- 在「reasoning → tool_call → tool_result → 下一步」的同一轮内，携带 `tool_calls` 的 assistant 消息在**下一步请求**中**携带 `reasoning_content`**。
- 针对 DeepSeek thinking + 工具调用场景：**不再出现 400（"reasoning_content must be passed back"）**。

### AC-6 无 reasoning 模型 no-op
- 对不返回 `reasoning_content` 的模型：无 reasoning 事件、无折叠区块、请求 body 无 `reasoning_content`；**行为与改造前一致**。

### AC-7 不破坏既有行为
- 既有 text / tool 的流式、落盘、context 组装、compaction / prune 行为**完全不变**。
- 全量 `pnpm test` 通过；新增改动不降低既有覆盖。

## 2. 测试矩阵（按现有 vitest 分层）

项目分层：`*.unit.test.ts(x)` / `*.contract.test.tsx` / `*.integration.test.ts` / e2e（[vitest.config.ts](../../../vitest.config.ts) · [vitest.e2e.config.ts](../../../vitest.e2e.config.ts)）。

| ID | 层级 | 位置（建议） | 覆盖点 | 关联 AC |
|---|---|---|---|---|
| T-1 | unit | openai-compatible.test.ts | `reasoning_content` 与 `reasoning` 两种字段都被识别为 `reasoningDelta`；二者皆空时不产事件 | AC-1 |
| T-2 | unit | streaming（新增 test） | 纯 reasoning delta **不再被丢弃**；累积到 `StreamResponse.reasoning`；**不进** `accumulatedContent`/`completeMessage` | AC-1, AC-4, 不变量1 |
| T-3 | unit | lifecycle（新增 test） | 产出带 **`messageId`** 的 `llm:reasoning-delta` / `llm:reasoning-end`；事件归属到正确 assistant message id；写入 turn-local map；turn 结束清空；**无 `appendPart` 调用** | AC-1, AC-2, 不变量2 |
| T-4 | unit | serializer（新增/扩展 test） | 含 `tool_calls` 的 assistant 消息在 map 命中时附加 `reasoning_content`；无 tool_calls 或不在 map 时**不附加**；跨轮历史消息**不附加** | AC-4, AC-5 |
| T-5 | integration | database-store.integration.test.ts | 跑含 reasoning 的会话后，**查不到** `type="reasoning"` 的 part 行 | AC-3 |
| T-6 | unit | context-manager（扩展 test） | prune / compact 候选集合**不含** reasoning；改造后 prune 行为不变 | AC-7 |
| T-7 | contract | app.contract.test.tsx（CLI） | 模拟 reasoning 事件流：上方区块流式追加 → `reasoning-end` 后折叠为摘要行；重载不重现 | AC-1, AC-2, AC-3 |
| T-8 | e2e（web） | web 结构化命令同款 e2e | reasoning 事件经 server/snapshot 通道到达 web，渲染可折叠 `.ohb-reasoning`，完成折叠 | AC-1, AC-2 |
| T-9 | unit | streaming / lifecycle | **无 reasoning 输入**时所有事件与输出与改造前一致（快照/对比） | AC-6, 不变量4 |

## 3. 关键回归 / 边界用例

- **交错顺序**：reasoning 与 content 交替到达（部分模型先吐少量 reasoning 再吐 content 再继续 reasoning）——确保 reasoning 不污染 content，content 不被并入 reasoning。
- **多步多段**：一轮内多次 reasoning（step1 reasoning→tool，step2 reasoning→tool，step3 text）——每步 map 正确按 messageId 归属；仅含 tool_calls 的步骤回传。
- **中止 / 错误**：用户中止或 provider 报错时 turn-local map 被清空，无泄漏到下一轮。
- **空 reasoning_content**：DeepSeek 直接作答时返回 `reasoning_content: ""`——确认空字符串场景不误触发显示，但若该 provider 要求回传空串则仍能回传（与参考库一致，按需实现）。
- **极长 reasoning**：超长 CoT 流式不卡 UI、不被持久化。

## 4. 验收手段

- **自动化**：`pnpm test`（unit + contract + integration）+ web e2e 全绿，覆盖 T-1~T-9。
- **手动验证**：
  1. 配置一个返回 reasoning 的 openai-compatible 模型（如 DeepSeek R1 / thinking），CLI 与 web 各跑一次带工具调用的多步任务，肉眼确认 AC-1/2/5。
  2. 任务后用 sqlite 客户端查 part 表确认 AC-3。
  3. 抓取第二轮请求 body 确认 AC-4（历史无 reasoning_content）、AC-5（同轮含）。
  4. 换一个不返回 reasoning 的模型回归 AC-6。

## 5. 完成定义（DoD）
- AC-1 ~ AC-7 全部满足且有对应自动化测试。
- 4 项不变量（见 02 文档 §6）均有测试守护。
- 文档 01/02/03 与最终实现一致（实现若偏离设计需回写文档）。
