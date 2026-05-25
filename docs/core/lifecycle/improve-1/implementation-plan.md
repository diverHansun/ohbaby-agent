# lifecycle improve-1 实施计划

本文档定义本轮重构的分阶段实施方案。本文档只回答"怎么改 / 改什么顺序 / 怎么保证不破坏现有功能"。改造动机见 [problem-analysis.md](./problem-analysis.md)，达成判定见 [acceptance.md](./acceptance.md)。

---

## 一、总体策略

### 1.1 三阶段递进，每阶段可独立交付

| 阶段 | 主题 | 解决的问题（引用） | 是否破坏 API |
|------|------|--------------------|-------------|
| P1 | 在 `context/` 模块建立 `prepareTurn` 对外契约 | PA-C1、PA-C6、G2 | 否（新增） |
| P2 | Lifecycle 引入 `runSession` 新入口，按轮询问 context | PA-L1、PA-L2、PA-L4、PA-L6、G1、G3 | 否（新增；旧入口保留） |
| P3 | 压缩算法正确性升级（切点、token 锚点、摘要质量、文件追踪） | PA-C2、PA-C3、PA-C4、PA-C5、G5 | 否（内部实现） |

每阶段单独 commit、单独验收、单独回滚。P1 是 P2 的前置；P3 与 P1、P2 正交，可并行也可滞后。

### 1.2 向后兼容原则

- **零破坏期**：P1、P2、P3 落地期间，所有现有调用方（RunWorker、子 agent、单测、composition）无须改动。
- **共存期**：Lifecycle 旧入口 `run()` 与新入口 `runSession()` 共存；ContextManager 旧方法 `compact / assemble / prune` 与新方法 `prepareTurn` 共存。
- **迁移期**：单独立项（improve-2）逐步将调用方切到新入口，旧入口标记 `@deprecated`。
- **清理期**：再后续版本删除旧入口。本轮不做。

### 1.3 测试先行

每阶段必须先补/改单元测试覆盖期望行为，再改实现。已有的 `*.unit.test.ts` 和 `*.contract.test.ts` 不允许在改造期间出现红灯（除非测试断言本身已经反映了被改造的旧行为，这类测试需要单独标注迁移）。

---

## 二、阶段 P1：Context 模块建立 `prepareTurn` 契约

### 2.1 目标

把"准备一轮 LLM 输入"封装为 context 模块的单一对外用例，停止从 adapter 编织 `compact + assemble`。

### 2.2 接口设计

在 [packages/ohbaby-agent/src/core/context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) 新增：

```ts
export interface PrepareTurnInput {
  readonly sessionId: string;
  readonly directory: string;
  readonly modelId: string;
  readonly isSubagent?: boolean;
  readonly force?: boolean;
}

export interface PreparedTurn {
  readonly messages: readonly ChatCompletionMessage[];
  readonly usage: ContextUsage;
  readonly compaction?: CompactResult;
  readonly assembledAt: number;
}

export interface ContextManager {
  // ... 现有方法保留
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
}
```

`messages` 是已组装好的 LLM 输入（system prompt + memory + history 已合并为 `ChatCompletionMessage[]`），调用方拿到即可直接送 LLM，不再需要二次处理。

### 2.3 内部实现要点

`prepareTurn` 内部流程：

1. 一次性 `assemble()` 得到 `AssembledContext`
2. 基于 `getUsage()` 判定是否需要压缩
3. 需要压缩则调 `prune()`，必要时再调 `summarizeActiveHistory()`
4. 在同一个调用栈内完成最终序列化（system prompt + memory.merged + history 序列化为 `ChatCompletionMessage[]`）
5. 单次返回 `PreparedTurn`

实现要点：

- 整个 `prepareTurn` 内部最多 assemble 一次（解决 PA-C1）。
- 序列化逻辑从 `composition.ts:buildSessionPromptMessages` 搬入 context 模块，作为 context 内部私有函数。
- 保留旧的 `compact / assemble / prune / getUsage / shouldCompress` 公共方法不变。

### 2.4 代码改动清单

| 文件 | 改动 |
|------|------|
| `core/context/types.ts` | 新增 `PrepareTurnInput` / `PreparedTurn` 类型；扩展 `ContextManager` 接口 |
| `core/context/context-manager.ts` | 新增 `prepareTurn` 实现；内部抽出 `serializeForLlm(assembled)` 私有函数 |
| `core/context/index.ts` | 导出新类型 |
| `core/context/manager.unit.test.ts` | 新增 `prepareTurn` 测试用例 |
| `adapters/ui-runtime/composition.ts` | **不动**。旧路径继续工作；切换在 P2 完成 |

### 2.5 验收衔接

详见 [acceptance.md](./acceptance.md) 的 A1 系列。

---

## 三、阶段 P2：Lifecycle 引入 `runSession` 新入口

### 3.1 目标

让 Lifecycle 不再持有 conversation 副本，按轮询问 context 模块，使外部状态变化（用户中途输入、上下文增长）在 loop 内自动生效。

### 3.2 接口设计

在 [packages/ohbaby-agent/src/core/lifecycle/types.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/types.ts) 新增：

```ts
export interface LifecycleDeps {
  readonly llmClient: LLMClientInstance;
  readonly messageManager: MessageManager;          // 由可选改为必填
  readonly toolScheduler: ToolSchedulerInstance;    // 由可选改为必填
  readonly contextManager?: ContextManager;          // 新增：使用 runSession 时必填
  readonly generateToolCallId?: () => string;
}

export interface LifecycleSessionParams {
  readonly sessionId: string;
  readonly directory: string;
  readonly modelId: string;
  readonly agent?: string;
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  readonly tools?: ChatCompletionCreateParams["tools"];
  readonly environment?: ToolExecutionEnvironment;
  readonly isSubagent?: boolean;
  readonly maxSteps?: number;
}

export interface LifecycleConfig {
  readonly shouldStopAfterTurn?: (ctx: TurnContext) => boolean;
  readonly beforeToolCall?: (ctx: ToolCallContext) => Promise<BeforeToolCallResult>;
  readonly afterToolCall?: (ctx: ToolCallContext) => Promise<AfterToolCallResult>;
}
```

> 注：`LifecycleDeps` 的 `messageManager` / `toolScheduler` 从可选改为必填，是因为新路径必须依赖事实源；旧入口的调用方目前已经实际传入了这两个依赖，因此不构成破坏。如确有调用方未传入，将在 P2 落地前先补传入。

### 3.3 新入口契约

```ts
class Lifecycle {
  // 旧入口：保留
  run(params: LifecycleRunParams): AsyncGenerator<LifecycleEvent, LifecycleResult, void>;

  // 新入口
  runSession(
    params: LifecycleSessionParams,
    config?: LifecycleConfig,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void>;
}
```

`runSession` 内部不接受 `messages` 参数，每轮通过 `deps.contextManager.prepareTurn(...)` 获取。

### 3.4 内部循环骨架

```
runSession(params, config):
  for step in 1..maxSteps:
    if signal.aborted: return error
    prepared = await contextManager.prepareTurn({ sessionId, modelId, directory, isSubagent })
    yield { type: "turn:start", usage: prepared.usage }

    yield* streamLLM(llmClient, prepared.messages)
    persist assistant + tool_calls via messageManager     // 事实源
    if no tool_calls: yield "turn:end"; return success

    if config.beforeToolCall: ...
    results = await toolScheduler.executeBatch(...)
    if config.afterToolCall: ...
    persist tool results via messageManager               // 事实源

    yield { type: "turn:end" }
    if config.shouldStopAfterTurn?(ctx): return success

    // 下一轮 prepareTurn 会自动看到刚写入的 assistant + tool 消息，
    // 也会自动看到用户中途插入的 steering 消息
```

关键差异：

- 没有 `conversationMessages` 局部变量（解决 PA-L1）。
- 没有 `toAssistantToolMessage` / `toolResultToMessage` 等 LLM 协议构造（解决 PA-L2，逻辑搬到 context 模块）。
- 没有"用户输入队列"机制；写 message → 下一轮自动读到（解决 PA-L4）。
- 终止条件除 maxSteps / signal 外，多了 `shouldStopAfterTurn` 注入点（解决 PA-L5）。
- 内部纯函数风格，类外壳保留是为了和旧 `run` 共存（PA-L6 部分缓解）。

### 3.5 事件兼容性

`LifecycleEvent` 现有事件保留：`llm:start` / `llm:delta` / `llm:complete` / `tool:start` / `tool:result` / `step:complete`。

新增（向后兼容，仅 `runSession` 路径发射）：

- `turn:start`：携带本轮 `ContextUsage`
- `turn:end`：携带本轮 `step` 与 `finishReason`

旧入口 `run` 不发射新事件，保持现有 RunWorker 处理无破坏。

### 3.6 代码改动清单

| 文件 | 改动 |
|------|------|
| `core/lifecycle/types.ts` | 新增 `LifecycleSessionParams` / `LifecycleConfig` / `TurnContext` 等类型；扩展 `LifecycleEvent`；扩展 `LifecycleDeps` |
| `core/lifecycle/lifecycle.ts` | 新增 `runSession` 方法；抽出私有 `streamLLM(...)` 与 `executeTurnTools(...)` 共用 helper；旧 `run` 不动 |
| `core/lifecycle/lifecycle.unit.test.ts` | 新增 `runSession` 测试用例，覆盖：单轮无 tool、多轮 with tool、中途追加 user message、压缩在 prepareTurn 内自动触发、`shouldStopAfterTurn` 注入 |
| `adapters/ui-inprocess.contract.test.ts` | **不动**。旧合约保持 |
| `adapters/ui-runtime/composition.ts` | **不动**。切换在 improve-2 |
| `runtime/run-manager/worker.ts` | **不动**。切换在 improve-2 |

### 3.7 验收衔接

详见 [acceptance.md](./acceptance.md) 的 A2 系列。

---

## 四、阶段 P3：压缩算法正确性升级

P3 与 P1、P2 在文件层面正交，可在任意顺序穿插推进。建议在 P1 之后启动，因为 `prepareTurn` 是这些算法的天然落点。

### 4.1 P3a：智能切点 + 配对保护

**目标**：消除 PA-C2。切点必须落在 user / assistant message 边界，禁止在 `tool_calls` 与对应 `tool` 结果之间切断。

**改动**：

- `core/context/context-manager.ts:getHistoryToCompress` 重写：
  - 先收集"合法切点"（user / assistant message 起点）。
  - 从末尾向前累加 token 直到达到 `keepRecentTokens`（绝对值，不是比例）。
  - 在最近的合法切点对齐。如切点位于一个 turn 内部，将该 turn 整体前缀加入 `turnPrefixMessages` 单独总结，后缀保留在 `messagesToSummarize`。
  - 对当前 persisted `ToolPart` 数据模型，不在单个 `ToolPart` 内部切分；assistant message 被整体压缩或整体保留。

**新增常量**：[constants.ts](../../../../packages/ohbaby-agent/src/core/context/constants.ts)

```ts
export const KEEP_RECENT_TOKENS = 20_000;
export const COMPACTION_RESERVE_TOKENS = 16_384;
```

`COMPRESSION_THRESHOLD` 与 `COMPRESSION_PRESERVE_RATIO` 保留作为兜底，但当 `getBudget` 可用时优先使用绝对值规则：`shouldCompress = inputBudgetTokens - currentTokens < COMPACTION_RESERVE_TOKENS`。

### 4.2 P3b：Token 估算引入 provider usage 锚点

**目标**：消除 PA-C3。利用 LLM 流式响应里已经返回的 `tokenUsage` 作为精确锚点。

**改动**：

- `core/message/`：在 `Part` metadata 中允许携带 `tokenUsage`；assistant message 完成时写入。
- `core/context/token-estimation.ts`：新增 `estimateContextTokens(history)`：
  - 找到最末一条带 `tokenUsage` 的 assistant message 作为锚点。
  - 锚点之前的 token 数 = 该 message 的 `prompt_tokens + completion_tokens`。
  - 锚点之后的 token 数 = 字符估算 sum。
  - 无锚点则回退全量字符估算。
- `core/context/context-manager.ts`：在算 `estimatedTokens` 与 `getUsage` 时改用新函数。

归属说明：该算法消费 `MessageWithParts / Part`，必须留在 `core/context`。`services/llm-model` 继续只提供文本级 token 估算与 model profile / budget 查询，不引入 context 领域类型。

### 4.3 P3c：压缩 prompt 升级

**目标**：消除 PA-C4。摘要结构由 5 字段 XML 改为 6 节 Markdown。

**改动**：

- [compression-prompt.ts](../../../../packages/ohbaby-agent/src/core/context/compression-prompt.ts) 重写为：
  - `## Goal`
  - `## Constraints & Preferences`
  - `## Progress`（含 `### Done` / `### In Progress` / `### Blocked`）
  - `## Key Decisions`
  - `## Next Steps`
  - `## Critical Context`
- 新增 `SUMMARIZATION_SYSTEM_PROMPT` 约束 summary agent 的角色。

本轮**不实现**增量更新（`UPDATE_SUMMARIZATION_PROMPT`），留待 improve-N。

### 4.4 P3d：摘要附加文件操作追踪

**目标**：消除 PA-C5。

**改动**：

- 新增 `core/context/file-ops.ts`：`extractFileOpsFromHistory(history)` 扫描压缩区间内 assistant 的 `tool_calls`，识别 read / write / edit 工具调用涉及的路径。
- `summarizeActiveHistory` 在 LLM 生成的 summary 末尾追加：
  ```
  <read-files>
  - path/to/file1
  </read-files>
  <modified-files>
  - path/to/file3
  </modified-files>
  ```
- 文件操作识别基于工具名（约定俗成 `read_file` / `write_file` / `edit_file` 等）与参数中的 `path` 字段；未知工具忽略。

### 4.5 代码改动清单（P3 汇总）

| 文件 | 改动 |
|------|------|
| `core/context/context-manager.ts` | 切点重写、压缩流程接入 file-ops 与新 prompt |
| `core/context/constants.ts` | 新增 `KEEP_RECENT_TOKENS` / `COMPACTION_RESERVE_TOKENS` |
| `core/context/compression-prompt.ts` | Markdown 6 节 + system prompt |
| `core/context/file-ops.ts` | 新增 |
| `core/context/manager.unit.test.ts` | 切点、token 锚点、文件追踪、新 prompt 输出测试 |
| `core/context/token-estimation.ts` | 新增 `estimateContextTokens`，消费 services 的文本级估算原语 |
| `core/message/`（少量） | Part metadata 支持 `tokenUsage` |

### 4.6 验收衔接

详见 [acceptance.md](./acceptance.md) 的 A3 系列。

---

## 五、阶段间依赖与时序

```
P1 (context.prepareTurn)
  |
  +--> P2 (lifecycle.runSession)  -- 依赖 P1
  |
  +--> P3 (压缩算法)               -- 不依赖 P1，但与 P1 共同受益（落点更自然）

时序建议：P1 -> P3 -> P2
理由：P3 修复算法层先稳定，P2 接入新入口时验证更干净。
```

---

## 六、回滚方案

每阶段独立可回滚：

| 阶段 | 回滚方式 |
|------|---------|
| P1 | 直接 revert `prepareTurn` 相关 commit。无现有调用方依赖。 |
| P2 | 直接 revert `runSession` 相关 commit。`run` 旧入口与所有调用方未动。 |
| P3 | 各子项（P3a/b/c/d）独立 commit，分别可回滚。 |

---

## 七、不在本计划内的事项

- composition / RunWorker 切到 `runSession`（improve-2）
- 移除旧 `run` 入口（improve-N）
- 增量摘要更新（improve-N）
- 多 provider 抽象（improve-N）
- Session tree 模型（improve-N）

---

## 八、后续文档

- 改造动机见 [problem-analysis.md](./problem-analysis.md)
- 验收标准见 [acceptance.md](./acceptance.md)
