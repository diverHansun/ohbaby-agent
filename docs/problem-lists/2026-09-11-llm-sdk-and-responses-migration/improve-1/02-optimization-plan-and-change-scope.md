# 优化方案与改动范围

## 1. 实施原则

- 一次只做 SDK 升级，不夹带 Responses 协议迁移。
- 保持依赖方向：core 依赖项目内部契约，provider adapter 依赖官方 SDK。
- 只抽取升级必需的窄类型，不在本阶段设计完整 provider-neutral message IR。
- 不用广泛 `as`、`any` 或 lint disable 掩盖新版联合类型。
- 每一步都保持可编译、可测试、可回滚。

## 2. 目标版本与锁定方式

更新 `packages/ohbaby-agent/package.json`：

- `openai`: `^7.13.0`
- `@anthropic-ai/sdk`: `^0.124.0`

使用 pnpm 更新 `pnpm-lock.yaml`，核对只出现预期的直接与传递依赖变化。Node engine 不调整。

## 3. 实施步骤

### Step 1：建立升级前证据

1. 记录工作区状态，避开用户已有未提交文件。
2. 在当前依赖上运行 lint、typecheck、相关 provider/llm-client 测试。
3. 保存 SDK 版本与关键 wire contract 的现状，不修改 snapshot 来迎合升级。

完成标准：基线失败与升级新增失败可以区分。

### Step 2：更新依赖

1. 只更新 `openai` 与 `@anthropic-ai/sdk` 两个直接依赖。
2. 审核 lockfile，避免无关 workspace dependency 漂移。
3. 检查官方 migration/changelog 中从当前版本跨越到目标版本的 runtime、export、error、stream、tool、usage 变化。

完成标准：安装可复现，目标版本准确，Node/peer dependency 无冲突。

### Step 3：收窄本地 function-tool 契约

在 `services/interface-providers/types.ts` 或更合适的既有公共类型出口定义项目当前真正支持的结构，例如：

```ts
interface InterfaceProviderFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
}
```

具体字段以现有 tool scheduler 的产物和 wire contract 为准。随后把 core 中的 `ChatCompletionCreateParams["tools"]` 替换为这一窄类型，包括：

- `core/agents/runner.ts`
- `core/agents/types.ts`
- `core/lifecycle/types.ts`
- `core/context/types.ts`
- `core/llm-client/streaming.ts`
- `services/interface-providers/types.ts`

provider 边界负责转换为各自 SDK 类型：

- OpenAI adapter 转为 function-type Chat tools；
- Anthropic adapter 转为 Anthropic `Tool`，不接受 SDK 新增的 browser/toolset 类型；
- tool scheduler、lifecycle 和 context 不感知 SDK 的扩展联合。

本步骤只处理 tools。`ChatCompletionMessageParam` 仍作为当前内部消息形状保留，等待未来 Responses 阶段统一设计。

完成标准：生产代码不再把 OpenAI SDK 的开放 tool 联合当作内部业务契约，wire JSON 与升级前一致。

### Step 4：适配 SDK 直接变化

OpenAI：

- 移除或简化 `nativeFetchOptions()` 中已经冗余的 fetch 类型断言；
- 验证 `APIUserAbortError`、`ClientOptions` 和 Chat resource import 路径；
- 对新版 tool-call 联合在 adapter 边界做显式 function-call 收窄；
- 保持 `chat.completions.create`、`stream_options.include_usage` 和 `prompt_cache_key` 不变。

Anthropic：

- 验证 `messages.stream()` 的事件分支和 abort error import；
- 更新测试 event fixture 的新增 usage 字段；
- 在 adapter 边界只生成项目支持的 Anthropic custom `Tool`，测试不要把整个 `ToolUnion` 假定为带 `.name`；
- 保持 cache control、thinking/text/tool_use 增量和 usage 归一化行为不变。

完成标准：不通过全局类型断言逃避联合类型，lint/typecheck/build 全部可通过。

### Step 5：测试与文档一致性

1. 按 [`04-test-and-acceptance.md`](./04-test-and-acceptance.md) 运行分层测试。
2. 核对 `docs/core/llm-client/`：调用协议、provider 目录名、归一化事件、cache/usage 描述必须与代码一致。
3. 只修订被本次升级触达或已经会误导实施的文档陈述；其他历史文档漂移记录为后续问题，不扩大代码范围。
4. 实施完成后新增 `05-implementation-acceptance.md`，记录实际 diff、命令结果、偏差与残余风险。

完成标准：文档不声称已支持 Responses，不把 Anthropic 描述成 OpenAI wire-compatible，也不遗漏 SDK 升级后的边界约束。

## 4. 明确不改

- 不新增 `openai-responses.ts`；
- 不新增 `/v1/responses` 或 `/v1/completions`；
- 不修改 lifecycle 双循环和终止条件；
- 不修改 context 压缩策略、token budget 算法和 cache key 语义；
- 不修改 SQLite schema、历史消息记录或 migration；
- 不改变 model 配置和默认 provider；
- 不升级其他依赖；
- 不删除 Chat Completions 支持。

## 5. 影响面判断

| 层 | 是否修改 | 原因 |
| --- | --- | --- |
| package/lockfile | 是 | SDK 版本升级 |
| provider adapters | 是 | 新类型联合、stream/usage fixture 与 fetch 类型适配 |
| llm-client | 小幅 | tool 请求类型改成本地窄契约 |
| lifecycle | 仅类型 | 移除 SDK tool 类型泄漏，控制流不变 |
| context | 仅类型/测试 | tool schema 类型改名，压缩与 cache 行为不变 |
| SQLite | 否 | 无持久化形状变化 |
| UI/CLI/server | 生产逻辑否，测试可能需改类型 | 部分测试直接读取 SDK tool 联合成员 |
| 文档 | 是 | 校正 provider 路径、协议边界和测试事实 |

## 6. 回滚方案

若升级无法在边界内完成：

1. 恢复两个 dependency 声明和 lockfile；
2. 恢复本地 function-tool 类型迁移；
3. 运行基线 lint、typecheck 和 provider tests，确认回到升级前状态；
4. 不触碰 SQLite 数据，因为本阶段没有 migration。

## 7. 实施授权门槛

只有用户审核并明确同意后才开始代码更新。若实施中发现必须改变消息 IR、lifecycle 行为、context/cache 语义或数据库结构，应停止并回到设计审核，不自动扩大范围。
