# 问题分析与代码现状

## 1. 依赖现状

`packages/ohbaby-agent/package.json` 当前声明：

| SDK | manifest | 当前 lock/install | 2026-09-11 调查目标 |
| --- | --- | --- | --- |
| `openai` | `^4.77.0` | `4.104.0` | `7.13.0` |
| `@anthropic-ai/sdk` | `^0.93.0` | `0.93.0` | `0.124.0` |

仓库要求 Node.js `>=24`，满足新版 OpenAI SDK 的 Node.js `>=22` 和新版 Anthropic SDK 的 Node.js `>=20` 要求。项目现有 TypeScript 与 Zod 解析版本也处于两套 SDK 可接受范围内。

官方迁移资料：[openai-node migration](https://github.com/openai/openai-node/blob/master/MIGRATION.md)、[Anthropic TypeScript SDK migration](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/MIGRATION.md)。

## 2. 当前调用链

```text
lifecycle 双循环
  -> context.prepareTurn / cache 策略
  -> llm-client.streamChatCompletion
  -> InterfaceProviderRequest（当前为 Chat-shaped messages/tools）
  -> openai-compatible.ts -> OpenAI SDK chat.completions.create
  -> anthropic.ts         -> 转换后调用 Anthropic SDK messages.stream
  -> InterfaceProviderStreamEvent
  -> llm-client 拼接文本、reasoning、tool calls、usage
  -> lifecycle 调度工具并进入下一步
```

关键文件：

- `packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts`
- `packages/ohbaby-agent/src/services/interface-providers/anthropic.ts`
- `packages/ohbaby-agent/src/services/interface-providers/types.ts`
- `packages/ohbaby-agent/src/core/llm-client/streaming.ts`
- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`
- `packages/ohbaby-agent/src/core/context/`

## 3. 现有耦合的性质

### 3.1 lifecycle

lifecycle 的核心职责确实是双循环、请求组装、流消费和工具调度。它不应知道 SSE wire event，但目前 `LifecycleSessionParams.tools` 等类型直接引用 `ChatCompletionCreateParams["tools"]`。

因此：

- 单纯升级 SDK 会因 SDK 类型联合变化影响 lifecycle 的编译；
- 只要归一化事件契约不变，运行控制流无需改变；
- 真正新增 Responses 时，若先建立 provider-neutral IR，影响可以停在 provider/llm-client 边界；若继续泄漏 OpenAI 类型，影响会向 lifecycle/context 扩散。

### 3.2 context 与 cache

当前 context 保存和裁剪 Chat-shaped 历史，token estimation 还会读取 function tool schema；prompt cache 根据规范化消息、工具和 provider 策略构造稳定输入。

`improve-1` 不改变消息内容、工具顺序、cache key、cache control 或 token usage 的归一化语义，因此不需要重写压缩算法。但必须通过回归测试证明：

- OpenAI 的 `prompt_cache_key` 与 `stream_options.include_usage` 仍按原逻辑发送；
- Anthropic cache control 仍放在预期位置；
- cache read/write token 仍映射到统一 usage；
- tool schema 的局部类型收窄不改变序列化结果。

### 3.3 SQLite

SQLite 存的是项目自己的消息/parts、session、run 与上下文状态，不是 SDK response 对象。`improve-1` 不改变持久化 DTO 或 schema，不需要数据库 migration。

未来 Responses 若引入 output item、reasoning item 或远端 continuation id，应先决定哪些是持久化事实、哪些只是 provider 元数据；这属于后续协议阶段，不能随 SDK 升级偷偷加入。

## 4. 隔离可实施性实验

实验在仓库外的临时副本进行，没有修改工作区。仅把 SDK 升至 OpenAI `7.13.0` 与 Anthropic `0.124.0`。

结果：

- 当前基线 `pnpm lint`：通过；
- 升级后核心定向测试：5 个文件、78 项测试通过；
- 升级后全量 Vitest：绝大多数运行测试通过，但最终因打包 smoke 内部调用 build 失败而失败；
- 升级后正式 build：失败；
- 升级后 preflight：失败。

失败集中于三类 SDK 类型漂移：

1. OpenAI `ChatCompletionTool` 新联合成员不保证存在 `.function`；
2. OpenAI tool call 联合成员不保证是 function call；
3. Anthropic `ToolUnion` 增加 toolset 类型，usage delta 增加 `output_tokens_details` 等字段，测试 fixture 不再满足新类型。

另有一项简单迁移：新版 OpenAI SDK 使用标准 Web fetch 类型，现有 `globalThis.fetch` 强制断言变成冗余。

## 5. 根因判断

问题不在 Chat/SSE 运行协议突然失效，而在项目把“本项目只支持 function tools”的契约表达成了“OpenAI SDK 当前所有 Chat tools”的类型别名。SDK 扩大官方联合类型后，项目自己的窄假设失去编译保证。

最小正确修复不是到处加断言，也不是在每个调用点判断所有 OpenAI 新 tool 类型，而是定义一个本地、结构化、仅覆盖当前能力的 function-tool 契约，并在 provider 边界转换。消息 IR 在本阶段保持不变。

## 6. 风险等级

综合判断为中等风险：

- 运行 API 没有被迫迁移，主要改动是依赖与类型边界；
- 影响文件横跨 provider、lifecycle、context 和测试，不能只改 package.json；
- cache、tool-call stream 和 abort 属于容易静默回归的关键路径；
- 无数据库 schema 变化，回滚可通过恢复依赖、lockfile 和边界类型完成。
