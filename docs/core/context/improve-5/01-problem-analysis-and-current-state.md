# 1. 问题基线与当前实施状态

> 时间口径：2026-08-23 完成核心代码只读勘测；2026-08-24 复核测试分类、real-smoke runner、E2E 配置与 compiled Web 启动路径。improve-4 / 4.1 已实施，improve-5 尚未进入业务代码。
> 协议口径：同日获取的 OpenAI、Anthropic、DeepSeek、智谱与 ZenMux 官方文档。
> 行号为规划快照，后续定位以文件和符号为准。

本文只诊断**现在怎样、为什么不足**。目标方案见 [02](./02-optimization-plan-and-change-scope.md)。

---

## 1.1 承重问题

| ID | 当前问题 | 直接风险 |
|----|----------|----------|
| P1 | provider usage 只有三个含混字段，cache details 全部丢失 | 命中率不可观测；Anthropic calibration 会被低估 |
| P2 | 当前没有 endpoint cache capability 模型；若只按 interface kind 补字段会把 wire 形状误当能力 | 给不支持的网关盲发字段会 400；支持缓存的网关又可能没启用 |
| P3 | Anthropic stream 忽略 `message_start`，LLM retry 复用旧 accumulation state，安全检查还漏掉 reasoning-only 输出 | cache usage 跨 attempt 泄漏，或 reasoning 已发出后错误重试 |
| P4 | 请求没有 scoped identity | 同一 child session 的两个 subagent scope 可能共用 key |
| P5 | system 混入 environment 和动态 MCP menu | 日期、cwd、加载状态变化会使后续稳定内容一并失效 |
| P6 | `additionalMessages` 在 lifecycle 与 ContextManager 多分支手工传播 | 测量和实际发送将来容易再次分叉 |
| P7 | tools 依赖 registry/filter 顺序，加载 MCP 时既改变 schema 又改变 menu | provider 的最左侧 prefix 发生非必要重排 |
| P8 | 当前设计文档主要以主代理描述，缺少主/子代理共同验收门 | 容易出现主代理修好、子代理旁路未透传的“半实现” |
| P9 | “provider 未报告”和“明确报告 0”会被同样表示；即使有 read，DeepSeek/智谱等仍不报告独立 write bucket | 无法区分 unavailable、真实 miss 与“后端可能写但协议不计量” |
| P10 | 测试固化了丢弃 cache 字段的旧行为，4.1 的真实 scheduler 覆盖仍偏弱，也没有从 compiled `ohbaby serve` 验证生产 Web 链路 | 单元测试通过但真实工具循环/发布形态仍可能不具备命中条件 |
| P11 | context summary 与 session title 也直接调用共享 streaming client，但没有统一 request purpose；summary 只有 sessionId、没有 contextScopeId | 给共享 client 增加默认 cache enhancement 后，辅助请求可能意外携带错误/无 scope 的策略 |

## 1.2 当前端到端数据流

```text
Lifecycle
  resolveTools(sessionId, contextScopeId, isSubagent)
      ↓
  additionalMessages?                 ← maxSteps finalization 在这里手工构造
      ↓
  ContextManager.prepareTurn
      assemble system + memory + scoped history
      render messages + additionalMessages
      measure { messages, tools }
      compact/re-project/re-measure
      return PreparedTurn.messages      ← PreparedTurn 不带 tools
      ↓
  streamChatCompletion(messages, tools)
      ↓
  InterfaceProvider
      build wire request
      normalize stream usage
      ↓
  Lifecycle toUsage / metadata / calibration
```

好的一面是 improve-4.1 已经让 context measurement 看见 `messages + tools`。剩余问题是 request payload 还没有成为单一权威对象：messages 从 `PreparedTurn` 返回，tools 继续由 lifecycle 平行持有，tail additions 作为可选参数穿过多个投影分支。

## 1.3 interface-provider / LLM client 现状

### 1.3.1 goals-duty

provider adapter 应隐藏 wire 差异并输出稳定的领域契约。当前：

- `InterfaceProviderTokenUsage` 只有 `prompt_tokens / completion_tokens / total_tokens`；
- `InterfaceProviderRequest` 没有 cache identity 或 request policy；
- `TokenUsage` 只是 provider type 的别名。

代码锚点：

- `packages/ohbaby-agent/src/services/interface-providers/types.ts:14-18,36-43`
- `packages/ohbaby-agent/src/core/llm-client/types.ts:39`

这导致 provider 的两种本质不同语义直接泄漏到同一个 `prompt_tokens`：

- OpenAI `prompt_tokens` 是 inclusive total，cached/write 是其中的拆分；
- Anthropic `input_tokens` 是 cache breakpoint 之后的 uncached tail，完整输入必须另行相加。

### 1.3.2 OpenAI-compatible 入站与出站

`normalizeTokenUsage` 只复制三字段，忽略 nested 和顶层扩展：

`packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts:46-58`

当前会丢失：

- OpenAI / 智谱 `prompt_tokens_details.cached_tokens`；
- GPT-5.6 `prompt_tokens_details.cache_write_tokens`；
- DeepSeek `prompt_cache_hit_tokens / prompt_cache_miss_tokens`；
- Kimi-compatible 顶层 `cached_tokens`。

`buildRequestParams` 已正确发送 `stream_options.include_usage: true`，但没有任何 cache request 字段：

`packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts:74-90`

当前 OpenAI dependency 声明为 `^4.77.0`，lockfile 实际解析 4.104.0。该版本 type 已包含 `prompt_tokens_details.cached_tokens`，但不包含当前官方的 Chat Completions `prompt_cache_key`、`prompt_cache_options`、`cache_write_tokens`，也不声明 DeepSeek/Kimi 的顶层 usage 扩展。因此实施会遇到“wire 协议已更新、SDK 类型尚未覆盖”的双向边界，不能假装靠升级一个字段自然解决。

### 1.3.3 Anthropic 入站与出站

`normalizeTokenUsage` 的输入类型只声明 `input_tokens / output_tokens`，并直接把 `input_tokens` 当完整 prompt：

`packages/ohbaby-agent/src/services/interface-providers/anthropic.ts:59-79`

`buildRequestParams` 不发顶层或 block-level `cache_control`：

`packages/ohbaby-agent/src/services/interface-providers/anthropic.ts:304-325`

`buildStreamEvent` 只在 `message_delta` 读取 usage，`message_start` 直接返回 null：

`packages/ohbaby-agent/src/services/interface-providers/anthropic.ts:327-375`

当前 `@anthropic-ai/sdk@0.93.0` 本地类型已经包含：

- 顶层 `MessageCreateParams.cache_control`；
- block-level `cache_control`；
- `cache_creation_input_tokens / cache_read_input_tokens`。

所以 Anthropic 主缺口不是 SDK 不支持，而是 adapter 没有使用现有协议。

### 1.3.4 streaming retry

`streamChatCompletion` 在 retry loop 外维护 `tokenUsage`：

`packages/ohbaby-agent/src/core/llm-client/streaming.ts:226-245,260-263`

发生异常时，只要还没有 text/tool delta 就允许 retry；仅收到 usage 的 `message_start` 不会阻止重试。由于 `tokenUsage` 没有按 attempt reset，第一次失败 attempt 的 usage 可能进入第二次结果。安全检查也没有把 `accumulatedReasoning` 当成已输出内容，reasoning-only stream 失败后可能重试并产生重复/串流：

`packages/ohbaby-agent/src/core/llm-client/streaming.ts:352-424`

这是启用 Anthropic start usage 后会被放大的存量 bug。

### 1.3.5 lifecycle 以外还有两个生产 LLM caller

共享 `streamChatCompletion` 不只由 agent Lifecycle 调用：

- context summary adapter 在 `packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts:79-111` 直接发 summarization request；`ContextLLMClient.generateSummary` 虽有 `sessionId`，却没有 `contextScopeId`，而且返回值只有 string，usage 被丢弃；
- session title generator 在 `packages/ohbaby-agent/src/services/session/title-generator.ts:110-132` 发一次短请求，没有 request purpose/identity，也不消费 usage。

这两类请求不一定适合默认写 prompt cache：title 太短且一次性，summary history 会重组，复用收益与 creation 成本需要另算。但它们必须显式声明 request purpose，并走同一个 normalized usage / retry 契约。尤其 subagent compact summary 不能因为不经过 Lifecycle 就丢失 scope；auxiliary usage 可以不进入 agent-step aggregate，但不能使 adapter 回到旧 usage 语义。

## 1.4 lifecycle、calibration 与 metadata

### 1.4.1 lifecycle 只保留三角 usage

`toUsage` 和 `toPartTokenUsageMetadata` 只映射 input/output/total：

`packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:92-123`

`TokenUsageMetadata` 也只有三字段：

`packages/ohbaby-agent/src/core/message/types.ts:77-85`

消息 metadata 是 JSON 弹性结构，因此增加 provider-neutral breakdown 不需要数据库 schema migration。但旧 metadata 读取必须继续兼容。

Lifecycle 自己产生的 `llm:complete` 可以带 token usage，但跨 run-manager 的生产事件链目前又把它丢掉：

- `packages/ohbaby-agent/src/runtime/run-manager/worker.ts:398-407` 发布 `run.llm.complete` 时只保留 timestamp/finishReason；
- `packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.ts:117-130` 还原 lifecycle event 时也没有 usage。

因此即使 adapter 与 lifecycle 已经归一化正确，真实 smoke、UI 侧诊断或其他事件消费者仍可能看不到同一份结果。improve-5 需要把 normalized usage 无损穿过 worker payload、stream bridge source 和对应类型/测试，而不是让测试绕过生产事件链直接读 adapter。

### 1.4.2 calibration 使用含混 prompt

每次 model step 完成后，lifecycle 使用 `finalEvent.tokenUsage.prompt_tokens` 更新 calibration：

`packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:633-648`

若直接启用 Anthropic cache，裸 `input_tokens` 可能只剩几十个 tail tokens，而真实 context 输入是数千到数万 tokens。factor 会被错误拉低，后续 overflow/compaction 判断也随之失真。这是 P1 中比“少显示一个命中率”更严重的正确性问题。

### 1.4.3 主/子代理已经共享 lifecycle，但 scope 需要贯穿

Lifecycle 的 `resolveTools` 和 `runModelStep` 已经接收：

- `sessionId`
- `contextScopeId`
- `isSubagent`

`packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:398-428,461-471,935-943`

UI runtime 创建的是同一个 Lifecycle / ContextManager；subagent host 复用该 agent instance factory：

`packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:494-508,588-604`

因此不需要另造“SubagentLLMClient”。正确做法是让现有 agent pipeline 的 request identity、turn snapshot、tools 和 usage 全部 scope-aware。任何在 primary UI adapter 才补 cache key 的实现都会漏掉子代理。

## 1.5 ContextManager 与 `additionalMessages`

`PrepareTurnInput.additionalMessages` 被定义为“不持久化、同时进入测量与发送”的 ephemeral provider messages：

`packages/ohbaby-agent/src/core/context/types.ts:138-162`

Lifecycle 在 final step 构建 max-steps message，并在正常 prepare 和 overflow force-prepare 两条路径重复传入：

`packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:398-428,506-523`

ContextManager 内部又在 unreduced measurement、reduced measurement、compaction projection、final measurement 等多个分支重复传播：

`packages/ohbaby-agent/src/core/context/context-manager.ts:1331-1418`

`renderForModel` 最终把它直接追加到 messages 尾部：

`packages/ohbaby-agent/src/core/context/context-manager.ts:530-545`

这在 4.1 中保证了 finalization message 被量到，是正确修复；但 API 形状仍是手工保持一致。继续增加 environment、cache breakpoint 等 placement 后，重复传播会成为高风险偶然复杂度。

## 1.6 system prompt、memory 与动态环境

### 1.6.1 主代理顺序

当前主代理 system 顺序是：

```text
base → task → agent addon → subagent roles
→ runtimePrompts(MCP menu)
→ environment(date/cwd/platform/isGit/tools)
→ custom instructions
```

代码锚点：

`packages/ohbaby-agent/src/core/system-prompt/assembler.ts:151-163`

稳定的 custom instructions 位于动态日期、cwd、MCP menu 之后。任何动态块变化都会让其后的稳定指令失去 exact-prefix reuse。

### 1.6.2 子代理顺序

子代理 system 为：

```text
subagent base → task → agent addon → runtimePrompts → minimal environment
```

`packages/ohbaby-agent/src/core/system-prompt/assembler.ts:135-148`

子代理虽然没有主代理 memory/custom instructions，但同样受到动态 runtime/environment bust；所以 P5 不是 primary-only 问题。

### 1.6.3 environment 的真实字段

`generateEnvironmentPrompt` 当前写入：

- cwd
- platform
- osVersion（主代理）
- date
- isGitRepo
- `Available tools`（主代理）

`packages/ohbaby-agent/src/core/system-prompt/layers/environment.ts:62-82`

当前实现**没有**写 git status、UUID、request id。旧文档把这些假想字段当成现状，已与代码不符。

`Available tools` 与正式 API tools schema 重复，且只有名称没有 schema。工具变化时，provider 的 tools prefix 和 system environment 会同时变化。

### 1.6.4 memory/custom/runtime 每 step 重建

每次 `prepareTurn` 都重新 `assemble`；主代理 memory 重新读取，system provider 并行重新检测 environment、runtime prompts 和 custom instructions：

- `packages/ohbaby-agent/src/core/context/context-manager.ts:695-723,1331-1339`
- `packages/ohbaby-agent/src/core/system-prompt/assembler.ts:208-261`

即使通常不会在一次 tool loop 中恰好变化，协议上也没有“同一 run snapshot”保证。

### 1.6.5 synthetic part 可用但尚未形成 runtime-context 契约

`TextPart` 已有 `synthetic?: boolean`，serializer 只排除 `ignored`，不会排除 synthetic text：

- `packages/ohbaby-agent/src/core/message/types.ts:88-94`
- `packages/ohbaby-agent/src/core/context/serializer.ts:82-121,167-175`

这提供了固定 runtime context 到原 user turn 的基础，但还需要验证 UI 隐藏、持久化、compaction、恢复和 subagent transcript 行为，不能只在 serializer 临时尾插。当前还有两个具体泄漏面：

- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts:126-129` 会把所有 active text part 投影到持久化 UI transcript；
- `packages/ohbaby-agent/src/services/session/title-fallback.ts:15-19` 会把所有未 ignored 的 text part 拼进 fallback title。

所以仅设置 `synthetic=true` 不足以隐藏 runtime part。实现必须按稳定 metadata kind 做窄过滤，同时保持 model serializer 可见；不能粗暴隐藏所有 synthetic text，因为其他 synthetic part 可能有不同产品语义。

### 1.6.6 `parentMessageId` 不能兼任 initiating-turn identity

Agent runner 先写初始 user message，再把其 id 放进 run 的 `parentMessageId`：

`packages/ohbaby-agent/src/core/agents/runner.ts:175-211`

Lifecycle 随后会在每个 model step 把同一个局部变量更新为最新 assistant message id：

`packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:379,857`

因此 runtime snapshot 若直接依赖可变 `parentMessageId`，第二 step 或无新 user message 的 resume 可能附着到错误位置。需要独立、不可变且可缺失的 `initiatingUserMessageId`：只有本次 run 确实创建/接纳新 user turn 时才设置；resume 没有新 user 时复用历史 snapshot，不回写旧消息。

## 1.7 MCP tool menu 与顺序

`McpToolMenu` 已按 `sessionId + contextScopeId` 隔离 loaded set，这是正确基础：

`packages/ohbaby-agent/src/mcp/integration/dynamic-tool-menu.ts:197-208,246-280`

但当前实际 tools 通过 registry insertion order 取得，再按 loaded set filter：

- `packages/ohbaby-agent/src/core/tool-scheduler/registry.ts:93-101`
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:353-375`

新加载工具会回到其原 registry 位置，而不是保证追加到 scope 已发送序列的末尾。与此同时 MCP menu 会从“未加载列表”删除该名称：

`packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:404-424,458-463`

所以一次 select 会同时改变：

1. provider tools schema；
2. tools ordering 的潜在位置；
3. system 中 runtime menu 文本。

Anthropic 的 cache hierarchy 以 tools 开头，这三处变化会造成比必要范围更大的 invalidation。

scope 生命周期也尚未闭环。`cleanupClosedSubagentScope` 当前只释放 shell、sandbox 和 todo 状态；ContextManager 与 `McpToolMenu` 只有 `disposeSession`，没有按 `{sessionId, contextScopeId}` 的 `disposeScope`。多个子代理可以共享同一个 child session，因此等待整 session 删除才清理会残留 closed scope 的 history/loaded tools/未来 tool sequence state，并可能让后续复用同 id 的测试或恢复逻辑看到旧状态。

另外，当前 MCP loaded set 只在内存中。若进程重启没有从持久化信息精确重建工具集合与顺序，恢复后的 tools prefix 不可能被承诺与崩溃前相同；这应被定义为一个新的 tool epoch，并允许首次请求 miss，而不是把 runtime part 的可恢复性错误扩大成“所有工具字节也稳定”。

## 1.8 2026-08 官方协议与端点差异

### 1.8.1 OpenAI Chat Completions

官方当前行为：

- prompt caching 对满足长度的请求自动开启，最低 1,024 tokens；
- `prompt_cache_key` 改善同一 exact prefix 的路由，GPT-5.6 要获得更可靠的 implicit/explicit matching 必须设置 key；
- GPT-5.6 默认在最新 user/tool message 放 implicit breakpoint，也支持 `prompt_cache_options` 和 content-level `prompt_cache_breakpoint`；
- Chat Completions 在 `usage.prompt_tokens_details.cached_tokens / cache_write_tokens` 报告 read/write；
- read、write、ordinary input 是 disjoint categories，三者总和等于完整 prompt input；
- tool definitions、tool ordering、schema、messages 和相关 settings 都参与 prefix；
- 单 key 的相关流量建议约 15 requests/min。

来源：<https://developers.openai.com/api/docs/guides/prompt-caching>

当前 ohbaby 只满足 `include_usage`，其余 request/usage 都未实现。

### 1.8.2 Anthropic Messages

官方当前行为：

- 缓存是 opt-in；官方 endpoint 支持顶层 `cache_control` automatic caching；
- 也支持 block-level breakpoints，最多 4 个；每个 breakpoint 向前查找至多 20 个 blocks；
- 顶层 automatic 可与稳定 system 显式 breakpoint 组合；大量并行 tool_use/tool_result blocks 可能让仅靠尾部 automatic 的向后查找越过 20-block 上限；
- growing conversation 适合自动把 cache point 向后推进，但动态 suffix 必须固定位置；
- hierarchy 为 `tools → system → messages`；
- `input_tokens` 只表示 breakpoint 后 uncached tail；完整输入为 read + creation + input；
- streaming 的 cache usage 在 `message_start.message.usage`；
- 最低 cacheable length 随当前模型为 512 / 1,024 / 2,048 / 4,096 tokens；
- legacy Bedrock integration 不支持顶层 automatic。

来源：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>、<https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching>

当前 ohbaby 不启用、算错总量、也读错流式事件。

### 1.8.3 OpenAI-compatible / Anthropic-compatible 不是 capability 保证

| Endpoint | 官方缓存行为 | 可观测字段/请求限制 | 当前规划含义 |
|----------|--------------|---------------------|--------------|
| OpenAI official Chat | implicit；key 改善路由 | nested read/write；支持 key | 可启用 keyed implicit |
| DeepSeek OpenAI format | 默认自动 disk cache | 顶层 hit/miss，且 prompt=hit+miss | observe-only |
| 智谱 OpenAI format | 自动缓存 | nested cached_tokens | observe-only |
| ZenMux OpenAI endpoint | 上游 implicit/显式因模型而异 | 文档明确 `prompt_cache_key` 不支持 | auto 下不能盲发 key |
| Anthropic official | 顶层 automatic 可配合显式 block | read/creation/input；start usage；20-block lookback | top-level auto + stable-system anchor |
| ZenMux Anthropic endpoint | 文档明确支持 block-level `cache_control` | Anthropic usage shape | 使用显式 last-block/system markers 更稳妥 |
| DeepSeek Anthropic format | 上游自动 cache | 文档说明 `cache_control` ignored | observe-only |
| 未知 compatible gateway | 未知 | 可能剥字段或拒绝扩展 | auto 下 observe-only |

来源：

- <https://api-docs.deepseek.com/guides/kv_cache>
- <https://api-docs.deepseek.com/api/create-chat-completion>
- <https://api-docs.deepseek.com/guides/anthropic_api/>
- <https://docs.bigmodel.cn/cn/guide/capabilities/cache>
- <https://zenmux.ai/docs/guide/advanced/prompt-cache.html>
- <https://zenmux.ai/docs/zh/api/openai/create-chat-completion>

结论：P2 是真实协议差异，不是为了未来而过度抽象。

## 1.9 测试现状与缺口

- `openai-compatible.test.ts` 锁定 `include_usage`，没有 cache field matrix。
- `anthropic.test.ts` fixture 已出现 cache null，但期望输出主动丢弃它们。
- LLM client 有 retry 测试，但没有“attempt 1 只有 usage 后失败、attempt 2 成功”的 stale usage 场景。
- system prompt 测试主要验证文本组成，没有验证两个 model step 的 exact-prefix position。
- improve-4.1 的 tools 计量测试覆盖了 mock resolver，但真实 scheduler / 至少两个 tools / 动态 MCP load 的集成覆盖不足。
- subagent 已有 contextScope 隔离测试，但没有 cache key、turn snapshot、tool order 和 usage parity 的联合契约。
- 没有覆盖 closed subagent scope 的 ContextManager/MCP/tool-sequence 定向清理，也没有覆盖进程重启后的 tool epoch 语义。
- `run.llm.complete` 的跨 worker/stream transport 没有 usage round-trip 测试。
- 仓库已有 `docs-test/` 项目级测试方法论和 unit / contract / integration / smoke 分类脚本；本批沿用其 co-located + `tests/<type>/<domain>` 规则，不另建一套测试规范。
- 当前 `scripts/run-real-smoke.mjs` 只接受 ZAI/智谱 key，并硬编码运行 TUI smoke 的若干 test name；即使新增 prompt-cache smoke，`pnpm test:smoke:real` 也不会自动发现，更无法覆盖 Anthropic。
- 根 `vitest.config.ts` 默认排除 `*.e2e.test.ts`；`vitest.e2e.config.ts` 能发现 package E2E，但 `test:e2e:snapshot` 只显式运行 snapshot 场景。当前没有覆盖 improve-5 主/子代理、compiled server/Web、runtime-part 隐藏和 cache usage 观测的统一 E2E 入口。
- 仓库已经具备真实发布形态：`pnpm build` 会构建 packages、`ohbaby-web` 并把 Web assets 复制到 `packages/ohbaby-cli/dist/web`；编译后可用 `node packages/ohbaby-cli/dist/bin.js serve` 启动生产 daemon + Web UI。但现有 improve-5 文档尚未把这条路径设为最终系统验收门。

## 1.10 文档 vs 实现对照

| 旧文档表述 | 代码/协议事实 | 本次修订 |
|------------|---------------|----------|
| 内部只有 flat cache 三元组 | 缺字段与真实 0 无法区分 | 改为 inclusive TokenUsage + optional breakdown |
| OpenAI-compatible 都发 key | ZenMux 明确不支持；DeepSeek/智谱无需 | 引入 capability resolver |
| Anthropic 一律顶层 automatic | compatible gateway 支持度不同 | 官方 top-level，已知 gateway 可显式 block |
| cache key 只用 sessionId | 4.1 已有同 session 多 context scopes | 改为 scoped identity hash |
| 动态信息每次放 trailing user | 临时尾插会在 tool loop 移位 | 固定到发起本轮 user turn |
| 现状有 git status/uuid/request id | 当前 environment 没有 | 删除不实描述 |
| 不持久化任何 cache 信息 | assistant part 已持久化 usage metadata | 改为“不建设跨 session 聚合库” |
| 子代理只需复用 parser | 子代理还需要 key、snapshot、tools 与 request envelope | 增加主/子代理完成门 |

## 1.11 SWE 原则审视

- **信息隐藏：** provider id/base URL 与 wire 字段变化应封装在 capability resolver + adapter；ContextManager 不识别 vendor 字段。
- **高内聚：** request assembly 负责 messages/tools placement；cache identity 由 lifecycle/client 负责；两者不能混为一个“全能 ContextManager”。
- **消除偶然复杂度：** `additionalMessages` 在十余个分支手工传播、每 step 重载动态 system 都是实现制造的复杂度。
- **KISS/YAGNI：** 只增加四种已被当前端点差异证明需要的内部 strategy；不复制完整 provider capability framework、WorldState 或 deferred tools。
- **正确性优先：** inclusive input/calibration、scope isolation、unavailable vs zero 必须先于命中率 UI。

## 1.12 影响面

承重改动将跨越：

- `config/llm`：promptCache policy 的 raw/resolved config、validation、writer；
- `services/interface-providers`：capability resolution、wire request、usage normalization、stream merge；
- `core/llm-client`：neutral request cache info 与 per-attempt usage；
- `core/lifecycle`：scoped key、run aggregate、metadata、single prepared request；
- `core/context`：request-shaped envelope、turn snapshot、placement、measurement；
- `core/system-prompt` / `core/memory`：稳定 system 与每轮 snapshot；
- `mcp/integration` / `tool-scheduler` / UI runtime composition：scope tool order 与 stable catalog；
- `adapters/ui-state/persistent-store` / `services/session/title-fallback` / transcript export：runtime part 的窄投影与本地隐私边界；
- `runtime/run-manager/worker` / `adapters/ui-runtime/stream-bridge-run-event-source`：normalized usage 事件透传；
- `adapters/ui-runtime/prompt-context` / `services/session/title-generator`：辅助 LLM request purpose、scope 与 usage 边界；
- provider、lifecycle、context、subagent、scheduler、real smoke 测试；最终验收还会使用编译后的 CLI/server/Web 生产装配，但不借机修改无关 Web 产品行为。

不应借 improve-5 修改 pricing、compact threshold 或新增 provider kind。
