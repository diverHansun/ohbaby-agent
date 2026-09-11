# Improve 1 实施验收

## 1. 结论

Improve 1 已按审核范围完成，并通过本地自动化验收。

- OpenAI SDK：`7.13.0`
- Anthropic SDK：`0.124.0`
- OpenAI 调用协议：继续使用 Chat Completions
- Anthropic 调用协议：继续使用 Messages
- Responses：未引入
- lifecycle/context/cache/SQLite：无行为或 schema 迁移

## 2. 实际改动

### 依赖与 runtime 适配

- 更新 `packages/ohbaby-agent/package.json` 与 `pnpm-lock.yaml`。
- 移除 OpenAI adapter 中旧 SDK 所需的自定义 fetch 类型断言，使用 Node.js 24 与新版 SDK 的标准 fetch 支持。
- 保留 `chat.completions.create()`、`messages.stream()`、abort 识别和现有 cache wire 字段。

### 类型边界

- 新增 `InterfaceProviderFunctionTool` 与可空集合类型 `InterfaceProviderFunctionTools`。
- agents、llm-client、lifecycle、context 不再引用 OpenAI SDK 的 `ChatCompletionCreateParams["tools"]` 开放联合。
- 本地契约只表达项目实际支持的 function tools；OpenAI 和 Anthropic adapter 在边界转换。
- `ChatCompletionMessageParam` 仍是当前消息边界，没有提前实施 Responses IR。

### 测试 fixture

- Anthropic message delta fixture 补齐新版 `output_tokens_details` 字段。
- Anthropic tool 断言显式验证 custom tool 结构，不再假定 SDK `ToolUnion` 的所有成员都有 `.name`/`input_schema`。
- OpenAI assistant tool-call 测试显式收窄为 function call，不接受新版 custom tool 联合成员。

### 文档

- 保留调查、计划和测试验收文档。
- 将 `docs/core/llm-client/` 中过期的 provider 源码路径和类型名称同步到实际实现。
- 修正 abort 文档：中断通过 `streamStopReason = "user_aborted"` 表达，不伪造 `finishReason = "length"`。

## 3. 自动化验收证据

### 定向回归

provider、llm-client、lifecycle、context 共 8 个定向测试文件通过，193 项测试全部通过。

### 完整门禁

`pnpm preflight` 零退出，包含：

- format check：通过；
- lint：通过；
- TypeScript typecheck：通过；
- Vitest：308 个文件通过、5 个跳过；2942 项测试通过、16 项跳过；
- workspace production build：通过。

另行执行 `pnpm install --frozen-lockfile`，确认 lockfile 可复现且无需重新解析。

## 4. 未运行项目

以下测试需要真实 API 凭据、外部服务与配额，本次没有未经单独授权运行：

- `test:cache:real:openai-compatible`
- `test:cache:real:anthropic`
- `test:smoke:real`

完整测试集中对应 real smoke 按环境条件跳过。fake OpenAI-compatible server、provider contract、cache wire 和 SQLite 集成测试均已通过。

## 5. SWE 改动面审查

结论：本批没有引入不必要的架构复杂度。

- 依赖方向改善：core 从易变的 OpenAI generated tool union 收敛到项目自有窄契约。
- 抽象范围克制：只抽取已有且明确的 function-tool 共性，没有预设 Responses message/item 模型。
- 行为边界稳定：provider 转换、agent loop、context 压缩、cache key 和持久化 DTO 保持原职责。
- 测试与文档共同约束 wire 行为，后续 SDK 更新可更早暴露不兼容。

保留债务：内部消息仍使用 OpenAI Chat-shaped 类型；它应在未来 Responses 独立规划中解决，不属于本批缺陷。

## 6. 范围核对

- [x] 未新增 `openai-responses.ts`。
- [x] 未新增 `/v1/responses` 或 `/v1/completions`。
- [x] 未修改 lifecycle 双循环和终止条件。
- [x] 未修改 context 压缩与 cache key 行为。
- [x] 未修改 SQLite schema 或历史消息字段。
- [x] 未升级无关直接依赖。
- [x] 保留 Chat Completions 与 Anthropic Messages 支持。
