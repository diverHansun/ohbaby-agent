# 1. 问题基线与当前状态

> 时间口径：分析基于 `codex/workspaceless-settings` 分支 `7bc75168`。以下路径若无特别说明，都相对于 `packages/ohbaby-agent/src/`。行号是这一时刻的快照，实施前需要重新核对。

## 1.1 问题陈述

1. **LLM 调用代码没有包级边界。** `core/llm-client/` 和 `services/interface-providers/` 一共约 6600 行，放在 agent 里，谁都可以随手引用 agent 的其他模块，边界只能靠自觉维持。
2. **LLM 客户端自己读配置单例。** `createLLMClient` 内部调用 `getLLMConfig()` 读 `model.json` 和 `.env`，调用方没法直接给它一份配置。这让它难以单独复用和测试。
3. **`config/llm` 与 `interface-providers` 两个目录互相引用。** `config/llm/writer.ts`、`apply-active-model-config.ts` 引用 `interface-providers/reasoning.ts`，后者又引用 `config/llm` 的 `types.ts`、`validation.ts`、`model-profile.ts`。这是目录级的环，文件级没有环，但两个目录无法分开放进不同的包。
4. **LLM 层引用了 UI 类型。** `interface-providers/reasoning.ts` 引用 sdk 的 `UiReasoningCapabilityView`，只为一个 UI 投影函数。
5. **同一个类型定义了两次。** `InterfaceProviderKind` 同时定义在 `config/llm/types.ts:5` 和 `services/interface-providers/types.ts:5`。

## 1.2 已确认的分界

见 [00 §2](00-discussion.md)。

```
现状                                         目标

ohbaby-agent                                 ohbaby-agent ──────────────▶ ohbaby-llm
├─ core/llm-client ◀──┐                      ├─ createLLMClient（读配置）    ├─ client/
├─ services/interface-providers ─▶ ohbaby-sdk ├─ config/llm（IO 部分）        ├─ providers/
├─ config/llm ◀───────┘（环）                 ├─ services/llm-model           └─ config/（纯类型、校验）
└─ ……                                        └─ ……                          （无 workspace 依赖）
```

## 1.3 现状

### 1.3.1 职责（goals-duty）

| 文档 | 说法 | 代码 | 差距 |
|---|---|---|---|
| `docs/core/llm-client/goals-duty.md` 当前状态（L6） | 各厂商的协议差异归 `services/interface-providers` | 一致 | 无 |
| 同上，非职责（L61-65） | 配置校验归 `config/llm`，原生协议转换归 interface-providers | 一致 | 无 |
| 同上（L75） | 不做重试和降级 | `retry.ts`、`idle-watchdog.ts` 已在 llm-client 里 | 文档过时 |
| `docs/services/providers/goals-duty.md`（L5） | 路径为 `services/providers/` | 已改名为 `services/interface-providers/` | 文档路径过时 |

### 1.3.2 文件布局（architecture）

**core/llm-client/**（非测试文件）

| 文件 | 行数 | 内容 |
|---|---|---|
| `client.ts` | 103 | `createLLMClient`：读配置、创建 provider、包装 token 用量回调 |
| `streaming.ts` | 961 | `streamResponse`、`resolvePreparedRequestSettings`：累积事件、重试、空闲超时、推理和缓存设置 |
| `prompt-cache.ts` | 298 | 缓存策略与缓存键 |
| `types.ts` | 296 | `LLMClientInstance`、`TokenUsage`、各类请求记录 |
| `retry.ts` | 208 | 重试策略与错误类 |
| `idle-watchdog.ts` | 120 | 流空闲看门狗 |
| `errors.ts` | 52 | `ToolCallParseError`、`isContextOverflowError` |
| `request-observation.ts` | 141 | 请求观察 |
| `index.ts` | 62 | 汇总导出，并 re-export `openai` 的 `APIUserAbortError` |

**services/interface-providers/**（非测试文件）

| 文件 | 行数 | 内容 |
|---|---|---|
| `anthropic.ts` | 785 | Anthropic Messages 协议 |
| `openai-compatible.ts` | 515 | OpenAI Chat Completions 兼容协议 |
| `openai-responses.ts` | 212 | OpenAI Responses 协议 |
| `openai-responses-stream.ts` | 986 | Responses 流事件映射 |
| `reasoning.ts` | 535 | 推理能力与参数换算，含 `reasoningCapabilityView`（L478） |
| `native-state.ts` | 226 | 原生输出与模型状态的 zod schema |
| `token-usage.ts` | 440 | token 用量规范化 |
| `types.ts` | 210 | `ModelMessage`、`InterfaceProviderStreamEvent` 等 |
| `index.ts` | 63 | `createInterfaceProvider` |

两个目录之间：llm-client 大量引用 interface-providers；反方向只有 `reasoning.ts` 引用 `config/llm`，不引用 llm-client。

第三方依赖：`openai`、`@anthropic-ai/sdk`、`zod`、Node 内置的 `node:crypto`、`node:path`、`node:util`。不用 undici。

### 1.3.3 对外的引用（耦合点）

两个目录的非测试代码，引用目录之外的地方只有这些：

| 引用方 | 被引用 | 符号 | 性质 |
|---|---|---|---|
| `core/llm-client/client.ts:16` | `config/index.js` | `getLLMConfig` | 读配置单例（IO） |
| `core/llm-client/client.ts:19-24` | `observability/index.js`、`observability/logger.js` | `NOOP_LOGGER`、`tokenUsageNormalization`、`Logger`、`emitDiagnostic` | 日志 |
| `core/llm-client/types.ts:16`、`prompt-cache.ts:2` | `config/index.js` | `LLMConfig`、`PromptCachePolicy` | 纯类型 |
| `core/llm-client/streaming.ts:66` | `config/llm/types.js` | `ReasoningConfig` | 纯类型 |
| `core/llm-client/prompt-cache.ts:10` | `utils/scoped-session.js` | `scopedSessionKey` | 27 行的纯函数 |
| `services/interface-providers/reasoning.ts:1` | `ohbaby-sdk` | `UiReasoningCapabilityView` | UI 类型 |
| `services/interface-providers/reasoning.ts:2-13` | `config/llm/{model-profile,types,validation}.js` | `normalizedEndpoint`、`ConfigError`、`InterfaceProviderKind`、`ModelJsonModelProfile`、`ReasoningCapabilities`、`ReasoningConfig`、`validateReasoning*` | 纯类型、纯函数 |

几个关键细节：

- **日志已经是注入的。** `client.ts` 通过 `options.logger` 接收日志器，没有时用 `NOOP_LOGGER`，只在 `tokenUsageReporter` 回调里调用一次 `emitDiagnostic`（L66-76）。`streaming.ts` 和各 provider 不写日志，provider 只接收一个可选的 `tokenUsageReporter` 回调。
- **`scopedSessionKey` 只被 `createScopedPromptCacheKey` 使用**（`prompt-cache.ts:193-200`），后者只在本文件 L255 被调用。缓存键格式是 `ob:v1:` 加 SHA-256 摘要，改变它会让线上的 prompt cache 全部失效。
- **代理是全局生效的。** provider 创建 SDK 客户端时不传 `fetch` 或 dispatcher（`openai-compatible.ts:439`、`anthropic.ts:719`、`openai-responses.ts:179`）；代理由 `utils/network-proxy/index.ts:73` 的 `installSystemProxy()` 通过 undici 全局 dispatcher 和 `http.globalAgent` 设置，CLI 在启动时调用。

### 1.3.4 config/llm 的构成（data-model）

| 文件 | 行数 | 性质 | 是否被 LLM 代码使用 |
|---|---|---|---|
| `types.ts` | 185 | 纯类型，加 `ConfigError` 类；无 import | 是 |
| `validation.ts` | 433 | 纯校验，文件头注明 “All functions are pure and stateless”；只引用 `types.ts` | 是（推理相关的两个函数） |
| `model-profile.ts` | 70 | 纯函数；只引用 `types.ts` | 是（`normalizedEndpoint`） |
| `api-key.ts` | 31 | 纯函数 | 否 |
| `env-file.ts` | 60 | 用 dotenv 解析 | 否 |
| `loaders.ts` | 107 | 读文件、读 `process.env` | 否 |
| `config-coordination.ts` | 80 | 读文件、AsyncLocalStorage | 否 |
| `manager.ts` | 280 | 读文件、缓存；引用 sdk | 否 |
| `writer.ts` | 312 | 写文件；引用 `interface-providers/reasoning`、`llm-model` | 否 |
| `apply-active-model-config.ts` | 661 | 写配置；引用 `interface-providers/reasoning`、`llm-model` | 否 |
| `context-window-probe.ts` | 375 | 网络请求 | 否 |
| `reasoning-active-probe.ts` | 138 | 网络请求 | 否 |
| `index.ts` | 95 | 单例访问器 `getLLMConfig` 等 | `client.ts` 使用 |

被 LLM 代码用到的三个文件都是纯的，且彼此只互相引用。

这三个文件在 config 目录之外还有 13 个非测试引用方，搬走后都要改 import：`commands/types.ts`、`services/session/types.ts`、`services/llm-model/activeModel.ts`（值引用 `activeModelBudgetProfiles`）、`runtime/run-manager/types.ts`、`runtime/prompt-scheduler/{types,scheduler}.ts`、`agents/{types,service}.ts`、`core/agents/types.ts`、`core/lifecycle/types.ts`、`adapters/ui-runtime/{types,composition}.ts`、`adapters/ui-inprocess.ts`。此外 `config/llm/__tests__/` 下有十多个测试引用 `../types.js`、`../validation.js`。`config/index.js` 在 config 目录之外有 10 个引用方。

### 1.3.5 反向引用（dfd-interface）

agent 中引用这两个目录的非测试文件分布：

| 区域 | 文件 | 用到的主要符号 |
|---|---|---|
| 公开入口 | `index.ts:94` | `export * from "./core/llm-client/index.js"` |
| core/lifecycle | `lifecycle.ts`、`types.ts`、`token-usage.ts` | `streamResponse`、错误与重试类、`TokenUsage`、`mergeReasoningIntent`、`ModelState` 等 |
| core/context | `context-manager.ts`、`types.ts`、`serializer.ts` 等 | `ModelMessage`、`PreparedRequestSettings`、重试 helper、`ModelStateSchema` 等 |
| core/message、core/agents | 多个文件 | `ModelMessage`、`TokenUsage`、`ModelToolDefinition`、`mergeReasoningIntent` |
| runtime、agents | run-manager、prompt-scheduler、`agents/service.ts`、`agents/subagent-host.ts` | `ReasoningIntent`、`mergeReasoningIntent`、错误类 |
| adapters | `ui-inprocess.ts`（L41、L2448-2450、L2513-2521）、`ui-runtime/*` | `createLLMClient`、`reasoningCapabilityView`、`streamResponse` 等 |
| services/session | `title-generator.ts` | `streamResponse`、`ModelMessage` |
| config/llm | `writer.ts:4`、`apply-active-model-config.ts:2` | `capabilitiesFor`、`compatibleReasoningPreference`、`reasoningCapabilityView` |

agent 代码大量“深层引用”这两个目录里的具体文件，而不是只走 `index.js`。按被引用的文件统计：`core/llm-client/index.js` 35 处、`interface-providers/reasoning.js` 17 处、`interface-providers/index.js` 15 处、`interface-providers/types.js` 13 处、`interface-providers/native-state.js` 11 处、`core/llm-client/types.js` 7 处、`core/llm-client/streaming.js` 4 处，其余零星。其中不少名字目前不在任何一个 `index.ts` 里导出，例如 `ModelOrigin`、`ModelState`、`ModelStateSchema`、`validateNativeProjection`、`sameModelOrigin`、`ReasoningIntent`、`ResolveRequestReasoningOptions`、`capabilitiesFor`、`compatibleReasoningPreference`、`mergeReasoningIntent`、`resolveRequestReasoning`、`AgentStepRequestRecord`、`SummaryRequestRecord`。

`createLLMClient` 的生产调用方只有 `adapters/ui-inprocess.ts:2448-2450`。`reasoningCapabilityView` 的调用方是 `adapters/ui-inprocess.ts`（L2513、L2521）和 `config/llm/apply-active-model-config.ts`（L182）。

`services/llm-model/` 与这两个目录没有互相引用，它依赖 config。

### 1.3.6 非功能约束

- **prompt cache 命中**：缓存键（`ob:v1:` 前缀加摘要）和 Anthropic 显式缓存标记的位置一旦改变，用户会多付费。`prompt-cache-wire.contract.test.ts`（1338 行）覆盖了 wire 层的缓存字段。
- **代理**：全局生效，与包的位置无关。
- **发布**：四个公开包版本号统一，打包时把 `workspace:` 依赖改写为具体版本，按 sdk、agent、server、cli 的顺序发布（`docs/releases/v0.1.14.md`、`docs/ohbaby-server/package-build.md` §7）。新增一个包就要加入这个流程。

### 1.3.7 测试

| 目录 | 测试 |
|---|---|
| core/llm-client | 单测 8 个；`llm-client.test.ts`（1224 行，未标类型，L105 mock 了 `getLLMConfig`）；集成 `sdk-retry`、`stream-idle`（真 SDK 加 stub fetch） |
| services/interface-providers | 单测 7 个；`anthropic.test.ts`、`openai-compatible.test.ts`、`index.test.ts`（未标类型）；集成 `anthropic-native`、`openai-compatible-native`、`openai-responses`；契约 `prompt-cache-wire.contract.test.ts` |

- 目录内的测试都不访问真实网络。真实网络测试在 `tests/smoke/`。
- 有三个测试虽然放在这两个目录里，却引用了 agent 的其他模块，测的是 agent 的链路：
  - `interface-providers/openai-responses.integration.test.ts`：引用 `bus`、`core/context`、`core/lifecycle`、`core/message`。
  - `interface-providers/prompt-cache-wire.contract.test.ts`：引用 `core/message/origin`、`core/system-prompt`、`goals/*`、`config/index`。
  - `core/llm-client/sdk-retry.integration.test.ts`：引用 `bus`、`adapters/ui-runtime/prompt-context`、`core/context`、`core/message`。
- `llm-client.test.ts` 在文件级用 `vi.mock` mock 了 `config/index.js`，大部分用例都经过 `createLLMClient`。
- `anthropic-native.integration.test.ts` 深层引用 `core/llm-client/streaming.js` 和 `types.js`，只依赖这两块内部。
- `tests/` 下有 26 个文件引用这两个目录，其中 9 个在 `tests/smoke/`。
- 两个脚本写死了源码路径：`scripts/run-real-network-smoke.mjs:7`（`services/interface-providers/index.ts`），`scripts/run-improve41-title-samples.mts:6,7,13`。

## 1.4 跨模块一致性

- `InterfaceProviderKind` 两处定义，目前字面值一致，但没有机制保证。
- `config/llm` 与 `interface-providers` 是目录级的环：`writer.ts` 和 `apply-active-model-config.ts` 需要推理能力换算，`reasoning.ts` 需要配置类型和校验。纯部分搬进同一个包后，环自然消失，agent 的 config 单向依赖 `ohbaby-llm`。
- agent 的 `utils/network-proxy/fixtures/sdk-proxy.fixture.ts` 也引用 `openai` 和 `@anthropic-ai/sdk`，这是测试夹具，抽包后 agent 仍需要把这两个库作为开发依赖。

## 1.5 改动影响面

| 区域 | 影响 |
|---|---|
| 新包 `packages/ohbaby-llm` | 新建 |
| agent 的 `core/llm-client/`、`services/interface-providers/` | 移出；agent 只保留 `createLLMClient` 包装 |
| agent 的 `config/llm/` | `types.ts`、`validation.ts`、`model-profile.ts` 移出；其余文件改为从 `ohbaby-llm` 引入 |
| agent 其他引用方 | 约 50 个文件改 import |
| agent 的 `services/llm-model/` | 接收 `reasoningCapabilityView` |
| 根配置 | `tsconfig.json`、`tsconfig.base.json`、`vitest.config.ts`、`vitest.e2e.config.ts` 增加新包；`eslint.config.js` L66-69 的后端规则块（禁止 console 等）目前只覆盖 agent 和 server |
| 各包 tsconfig | server、cli、web 的 `tsconfig.json` 都直接列出了所依赖包的 project reference（server、cli 引用 agent 和 sdk，web 引用 sdk 和 server），新包要加进去 |
| 打包相关测试 | `tests/integration/cli/packaging-smoke.integration.test.ts`（L686-720）只打包四个公开包；`tests/integration/compiled-model-contract.integration.test.ts`（L161、L174）只构建 sdk 和 agent。两者都在 `pnpm test` 中运行 |
| 脚本与测试 | `scripts/` 两个脚本、`tests/` 下 26 个文件改路径 |
| 发布 | 公开包变成五个，发布顺序变化 |
| 文档 | `docs/core/llm-client/*`、`docs/services/providers/goals-duty.md`、`docs/ohbaby-server/package-build.md` |

新增一个 npm 包是唯一不易撤回的动作：一旦发布，包名就被占用，以后改名或合并都要处理已发布的版本。代码本身的移动都可以 revert。

## 1.6 SWE 原则审视摘要

| 发现 | 依据 | 判断 |
|---|---|---|
| LLM 客户端在构造时读全局配置 | 依赖倒置、可测试性：底层模块不该主动去拿上层的配置 | 真实问题；改为由调用方传入配置 |
| `config/llm` 与 `reasoning.ts` 的环 | 无环依赖原则 | 真实问题；纯部分归到同一个包后消失 |
| LLM 层引用 UI 类型 | 关注点分离：UI 投影属于适配层 | 真实问题；投影函数移回 agent |
| `InterfaceProviderKind` 两份 | DRY：同一个知识两处定义 | 合并 |
| `scopedSessionKey` 是否抽成共享 | 错误的抽象比重复更贵：缓存键格式必须冻结，内存键格式可以独立演化 | 在 `ohbaby-llm` 里保留一份私有的编码函数，并用测试钉住缓存键的输出 |
| 是否像 dsh 那样把每个 provider 拆成独立包 | YAGNI：只有三种协议，没有单独复用某个 provider 的需求 | 不拆，用子目录 |

## 1.7 与既有文档的关系

| 文档 | 处理 |
|---|---|
| `docs/core/llm-client/goals-duty.md` 等五份模块文档 | 实施后更新位置、依赖关系，并修正 L75 关于重试的过时说法 |
| `docs/services/providers/goals-duty.md` | 路径过时，实施后更新 |
| `docs/services/llm-model/improve-1/04-interface-providers-boundary.md` | 术语沿用，不需要改 |
| `docs/ohbaby-server/package-build.md` §7 | 发布顺序加入 `ohbaby-llm` |
| `docs/problem-lists/2026-09-11-llm-sdk-and-responses-migration` | 冻结边界不受影响 |
