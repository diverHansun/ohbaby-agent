# 测试与验收标准

## 1. 验收目标

证明 SDK 升级只改变依赖兼容层，不改变当前两个 provider 的请求协议、agent 执行语义、cache/context 行为和持久化结果。

## 2. 必过自动化门禁

### A. 静态与构建门禁

以下命令全部为零退出码：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
```

重点检查：

- 不存在新增 `any`、广泛类型断言或 lint disable；
- 生产 build 与 `.d.ts` 生成成功；
- package smoke 不因测试文件中的 SDK 联合类型失败。

其中 `pnpm build` 所包含的强制 TypeScript build 不可省略；普通增量 `tsc -b` 可能复用升级前状态，不能独立证明新版 SDK 的声明检查通过。

### B. Provider 与 llm-client 定向测试

至少覆盖：

- `services/interface-providers/openai-compatible.test.ts`
- `services/interface-providers/anthropic.test.ts`
- `services/interface-providers/prompt-cache-wire.contract.test.ts`
- `services/interface-providers/token-usage.unit.test.ts`
- `core/llm-client/llm-client.test.ts`

验收行为：

- OpenAI Chat stream 文本、reasoning、多个 tool-call 增量可正确拼接；
- Anthropic text/thinking/tool_use 事件可正确归一化；
- abort error 仍被识别为取消，不进入普通失败重试；
- finish reason 与 raw finish reason 不回归；
- usage、cache read、cache write 的数字映射不回归；
- tool schema 发往两个 provider 的 wire 值与升级前相同。

### C. context/cache/lifecycle 回归

运行相关 unit、contract 和 integration 分类测试，至少包含：

- lifecycle tool scheduler 与 max-step 路径；
- context manager、token estimation、serialization、compaction atomicity；
- prompt cache wire contract 与 real-cache harness unit test；
- message/database-store 与 session 恢复测试。

验收行为：

- lifecycle 步数、工具顺序、终止原因不变；
- token estimation 仍计入 function tool schema；
- context 压缩触发阈值和结果不因 SDK 类型升级发生无意变化；
- 同一规范化输入产生相同 cache key；
- SQLite 无 schema migration，既有会话可读写和恢复。

### D. 全量门禁

```bash
pnpm preflight
```

必须完整通过；不能以“Vitest 运行断言通过”替代 build/typecheck，因为隔离实验已经证明新版 SDK 的主要失败出现在声明生成和测试源类型检查阶段。

## 3. 可选真实 provider 验收

在用户本地已配置凭据且明确选择运行时执行：

```bash
pnpm test:cache:real:openai-compatible
pnpm test:cache:real:anthropic
pnpm test:smoke:real
```

真实测试不得写入文档或日志中的 API key。若第三方 OpenAI-compatible base URL 不支持某个 OpenAI 扩展字段，应记录供应商能力差异，不把它误判为 SDK stream 解析失败。

## 4. 文档一致性检查表

- [x] 顶层与 `improve-1` README 状态从“待审核”更新为实际状态。
- [x] `docs/core/llm-client/` 中 provider 路径与实际 `services/interface-providers/` 一致。
- [x] 文档准确写明 OpenAI 使用 Chat Completions、Anthropic 使用 Messages。
- [x] 文档没有宣称当前支持 `/v1/responses` 或 `/v1/completions`。
- [x] function-tool 本地契约、provider 转换职责与代码一致。
- [x] cache、usage、abort 与流事件描述和 contract tests 一致。
- [x] 未把 SDK response 原对象描述为 SQLite 持久化格式。
- [x] 实施验收文档记录实际版本、命令、结果和未覆盖的真实 provider。

## 5. 可实施性检查表

- [x] Node.js/TypeScript/Zod 与两套目标 SDK 的要求兼容。
- [x] lockfile 变化只包含预期 SDK 依赖树。
- [x] OpenAI 和 Anthropic 的错误类、resource type import 可从公开 export 访问。
- [x] 新版 tool 联合类型已在 provider 边界收窄，core 不依赖未知官方 tool 变体。
- [x] Anthropic 新 usage 字段由 fixture 覆盖，归一化器对未知扩展字段保持前向兼容。
- [x] 没有 lifecycle、context、cache 或 SQLite 的隐藏行为改动。
- [x] 回滚不需要数据迁移。

## 6. 验收失败条件

任一情况出现即不验收：

- `pnpm preflight` 非零退出；
- 为过类型检查而在 core 广泛引入 SDK 联合判断、`any` 或断言；
- Chat wire、Anthropic wire、cache key 或 usage 语义无计划变化；
- 引入 Responses、服务端状态链或数据库字段；
- 真实 provider 失败但未区分代码回归、模型限制和中转站兼容差异；
- 文档声称的版本、协议或测试结果与实际不一致。

## 7. 已有实验不是最终验收

2026-09-11 的隔离实验用于证明方案可行性并发现风险，不是实施验收。它已经表明：

- 基线 lint 通过；
- 新 SDK 下绝大多数运行测试仍通过；
- 新 SDK 下 build/preflight 因 tool/usage 类型变化失败。

正式实施必须修复这些问题并重新运行全部门禁，不能沿用临时副本结果。
