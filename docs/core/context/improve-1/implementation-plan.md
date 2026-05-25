# context improve-1 实施计划

本文档定义本轮 context 重构的分阶段方案。本文档只回答"怎么改 / 改什么顺序 / 与 lifecycle improve-1 如何对接"。改造动机见 [problem-analysis.md](./problem-analysis.md)，验收标准见 [acceptance.md](./acceptance.md)。

---

## 一、总体策略

### 1.1 三阶段递进

| 阶段 | 主题 | 主要解决 | 是否破坏现有 API |
|------|------|---------|----------------|
| CP1 | 建立 `prepareTurn` 对外契约 | PC-1、PC-2、PC-3、PC-10 | 否（新增方法） |
| CP2 | 算法层正确性升级 | PC-4、PC-5、PC-6、PC-7、PC-11 | 否（内部实现） |
| CP3 | 数据模型微调与可观测性 | PC-8、PC-9、PC-12 | 否（内部重组 + 事件追加） |

每阶段独立可交付、独立可回滚。CP1 是与 lifecycle improve-1 的接合面，应优先完成。CP2、CP3 与 CP1 正交，可在 CP1 之后任意顺序穿插。

### 1.2 向后兼容铁律

- `ContextManager` 接口现有方法（`compact / assemble / prune / getUsage / shouldCompress`）签名与行为保持不变。
- `ContextEvent.Compressed / Pruned` 现有事件不修改字段。
- `COMPRESSION_PROMPT / COMPRESSION_THRESHOLD / COMPRESSION_PRESERVE_RATIO / PRUNE_PROTECT_TOKENS / PRUNE_MINIMUM_TOKENS / SUMMARY_AGENT_NAME` 仍然导出，未来通过 `@deprecated` 标记逐步退出。
- 所有改造仅以"新增"或"内部实现替换"形式落地。

### 1.3 与 lifecycle improve-1 的同步关系

```
context improve-1 CP1 (prepareTurn 实现完成)
        │
        ▼
lifecycle improve-1 P2 (runSession 开始消费 prepareTurn)
```

- CP1 是 lifecycle improve-1 P2 的**前置条件**。CP1 未交付前，lifecycle P2 不能启动实现。
- CP1 验收完成后，lifecycle P2 可立即启动，二者可由不同开发者并行推进。
- CP2、CP3 与 lifecycle improve-1 无强依赖，可独立。

### 1.4 测试先行

每阶段必须先补/改单元测试覆盖期望行为，再改实现。[`manager.unit.test.ts`](../../../../packages/ohbaby-agent/src/core/context/manager.unit.test.ts) 现有测试在改造期间不允许出现红灯，除非该测试断言的是被本计划标注为需要演进的行为。

### 1.5 跨模块影响范围（硬约束）

本轮重构涉及四个模块的协作。每个模块的改动范围在此明确，作为后续所有阶段的硬约束。详细动机见 [problem-analysis.md 第三节](./problem-analysis.md#三跨模块协作面) 与 [G7](./problem-analysis.md#g7跨模块边界明确化零对外-api-变更)。

| 模块 | 公共 API 是否变更 | 内部协作变化 |
|------|----------------|------------|
| `core/context` | **是**：新增 `prepareTurn`、`PrepareTurnInput`、`PreparedTurn`、`KEEP_RECENT_TOKENS`、`COMPACTION_RESERVE_TOKENS`、`SUMMARIZATION_SYSTEM_PROMPT`、`ContextEvent.TurnPrepared`、`ContextEvent.CompactSkipped` | 内部新增 `serializer.ts / file-ops.ts / filters.ts / summary.ts`；`compact / assemble / prune / getUsage / shouldCompress` 行为与签名不变 |
| `services/llm-model` | **否** | 不暴露新 API；`estimateTokensForText / estimateTokensForMessage / getBudget / getLimit` 行为不变；新算法 `estimateContextTokens` **不**下沉到本模块 |
| `core/system-prompt` | **否** | `SystemPromptProvider.build` 行为不变；不接管 memory 注入；不引入 memory 依赖 |
| `core/memory` | **否** | `MemoryReader.load` 行为不变 |
| `core/message` | **轻微扩展**：`Part` metadata 允许携带 `tokenUsage` 字段（向后兼容的新增字段） | 由 lifecycle 在流式完成时写入；由 context 在 `estimateContextTokens` 中读取 |
| `core/lifecycle` | 见 [lifecycle improve-1 implementation-plan.md](../../lifecycle/improve-1/implementation-plan.md) | 本轮 context 只要求 lifecycle 在流式完成时写入 `tokenUsage` 到 Part metadata；不强制 lifecycle 切换到 `runSession` |
| `adapters/ui-runtime/composition.ts` | 不破坏 | `buildSessionPromptMessages` 维持现状（继续调用 `compact + assemble`）；`appendMemoryToSystemPrompt` 实现搬入 context 的 serializer，adapter 侧函数变为转发壳子 |

**这张表是 [acceptance.md AG-8](./acceptance.md#ag-8-跨模块边界核对) 的判定依据。**

#### 关键算法归属决策

| 算法 | 归属模块 | 理由 |
|------|---------|------|
| 文本级 token 估算（`estimateTokensForText`） | `services/llm-model` | 与具体领域类型无关，纯字符算法 |
| Model profile / budget 查询（`getBudget / getLimit`） | `services/llm-model` | 与模型注册表强耦合 |
| MessageWithParts 感知的 token 估算（`estimateContextTokens`） | **`core/context`** | 消费 `MessageWithParts` 领域类型；services 应保持领域无关 |
| 文件操作提取（`extractFileOps`） | `core/context` | 消费 `MessageWithParts` 与 tool 调用约定，与压缩流程绑定 |
| System prompt 组装 | `core/system-prompt` | 不变 |
| Memory 文件加载与合并 | `core/memory` | 不变 |
| Memory 注入 system prompt + 安全扫描 | **`core/context`**（新增）| 是"对 LLM 的呈现"职责的一部分；从 adapter 搬入 |
| 最终序列化为 `ChatCompletionMessage[]` | **`core/context`**（新增） | 是"对 LLM 的呈现"职责的核心 |

---

## 二、阶段 CP1：建立 `prepareTurn` 对外契约

### 2.1 目标

把"准备一轮 LLM 输入"封装为 context 模块的单一对外用例。停止从 adapter 编织 `compact + assemble + toModelMessages`。

关键补充：当前 `messageManager.toModelMessages()` 会把 persisted `ToolPart` 扁平化为普通 assistant 文本，无法满足 `runSession` 后续每轮从持久化事实源重建 LLM 输入的要求。因此 CP1 的 serializer 不是简单搬迁旧 converter，而是必须从 `MessageWithParts` 重建合法的 provider 协议消息，尤其是 `assistant(tool_calls)` 与后续 `tool` result message 的配对。

### 2.2 接口设计

在 [packages/ohbaby-agent/src/core/context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) 新增：

```ts
import type { ChatCompletionMessage } from "../llm-client/index.js";

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
  readonly hasSummary: boolean;
}

export interface ContextManager {
  // 现有方法不动
  assemble(...): ...;
  getUsage(...): ...;
  shouldCompress(...): ...;
  compress(...): ...;
  compact(...): ...;
  prune(...): ...;

  // 新增
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
}
```

`PreparedTurn.messages` 为已合并 system prompt + memory + history 的完整 LLM 输入，调用方拿到即可直接送 LLM。

### 2.3 内部实现要点

`prepareTurn` 的内部流水线：

```
1. 一次性 assemble → AssembledContext
2. 单点决策 decideAction(assembled, modelId, force):
     → "skip"        不动
     → "prune-only"  仅 prune
     → "compact"     prune + summarize
3. 按决策执行对应分支:
     - prune-only: prune → 局部 invalidate active history
     - compact:    prune → summarize → 局部 invalidate active history
4. 序列化为 LLM 输入: serializeForLlm(systemPrompt, memory, history)
5. 返回 PreparedTurn { messages, usage, compaction?, assembledAt, hasSummary }
```

实现规则：

- 全程**最多一次** `messageManager.listBySession()` 调用。
- 全程**最多一次** `memory.load()` 调用（subagent 路径跳过）。
- 全程**最多一次** 完整序列化。
- 压缩分支内的 token 重估通过"局部增量"完成：用 `assembled.history` 减去被 compacted 的 parts 再加上 summary message，不重新 assemble。
- `decideAction` 是纯函数，便于单测。

### 2.4 决策函数 `decideAction`

集中处理 PC-10 的散布判断：

```ts
type CompactAction = "skip" | "prune-only" | "compact";

function decideAction(input: {
  readonly usage: ContextUsage;
  readonly historyLength: number;
  readonly force: boolean;
}): CompactAction {
  if (input.force) return "compact";
  if (!input.usage.shouldCompress) return "skip";
  if (input.historyLength <= 2) return "prune-only";
  return "compact";
}
```

所有"判断是否要 compress / prune"的逻辑集中此处。

### 2.5 序列化路径合并

新增 `core/context/serializer.ts`（或并入 `serialization.ts`）：

```ts
export function serializeForLlm(input: {
  readonly systemPrompt: string;
  readonly memory: MergedMemory;
  readonly history: readonly MessageWithParts[];
  readonly isSubagent: boolean;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
}): ChatCompletionMessage[];
```

逻辑在 system prompt / memory 层面等价于当前 [`composition.ts:305-319`](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts#L305-L319)：

- subagent：不附加 memory，直接用 `systemPrompt`。
- 主 agent：执行 `appendMemoryToSystemPrompt + loadMemoryForPrompt` 等价逻辑，含安全扫描。

history 序列化必须比现有 `messageManager.toModelMessages()` 更严格：

- user / system 文本消息按原 role 输出。
- assistant 的 text / reasoning part 合并为 assistant content。
- assistant 的 completed / error / aborted `ToolPart` 先输出一个 assistant message，携带 `tool_calls`；随后按 `callId` 输出对应的 `tool` message。
- pending / running tool part 不输出 tool result，避免把未完成工具结果暴露给 LLM。
- compacted part 不输出；summary message 仍按 summary 排序规则置于历史前部。
- 如果同一 assistant message 同时包含文本和工具调用，assistant message 的 `content` 保留文本；若文本为空则为 `null`。

#### 跨模块产物来源说明

`serializeForLlm` 的输入来自三个模块，由 `prepareTurn` 调度后传入：

| 输入字段 | 来源模块 | 来源接口 |
|---------|--------|---------|
| `systemPrompt` | `core/system-prompt` | `SystemPromptProvider.build(...)` 的返回值 |
| `memory` | `core/memory` | `MemoryReader.load(directory)` 的返回值 |
| `history` | `core/message`（通过本模块过滤） | `messageManager.listBySession` + `getActiveHistory` |
| `onSecurityFinding` | adapter 注入 | 通过 `ContextManagerOptions` 已有的 `onWarning` 等回调扩展 |

> 注：当前 [`appendMemoryToSystemPrompt`](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) 与 memory 安全扫描位于 adapter。CP1 将其搬入 context 模块（路径建议 `core/context/serializer.ts`）。搬动时保留对外行为，原 adapter 函数变为转发调用，保证零破坏。
>
> **关键约束**：搬入过程中**不引入** context 对 `core/system-prompt/security` 的直接依赖；安全扫描函数复用 system-prompt 模块已暴露的能力（如 `scanPromptLikeContent`），仍由 system-prompt 模块拥有，context 仅为消费者。

### 2.6 代码改动清单

| 文件 | 改动 |
|------|------|
| `core/context/types.ts` | 新增 `PrepareTurnInput / PreparedTurn`，扩展 `ContextManager` |
| `core/context/context-manager.ts` | 新增 `prepareTurn` 实现，新增 `decideAction` 私有函数 |
| `core/context/serializer.ts`（新建） | `serializeForLlm` 函数；memory 注入与安全扫描搬迁；从 `MessageWithParts` 重建 `assistant(tool_calls) + tool` 协议消息 |
| `core/context/index.ts` | 导出新类型 |
| `core/context/manager.unit.test.ts` | 新增 `prepareTurn` 与 protocol-aware serializer 测试集 |
| `adapters/ui-runtime/composition.ts` | `appendMemoryToSystemPrompt` 调用切换为转发；其它不动 |

### 2.7 验收衔接

详见 [acceptance.md AC-1 系列](./acceptance.md#二ac-1-系列prepareturn-契约验收)。

---

## 三、阶段 CP2：算法层正确性升级

CP2 由四个子项组成，相互独立可并行实现。

### 3.1 CP2-A：智能切点 + turn 配对保护

**目标**：消除 PC-4。

**改动**：

- `context-manager.ts:getHistoryToCompress` 重写。
- 新增 `findValidCutPoints(history)` 与 `findCutPoint(history, keepRecentTokens)` 私有函数。
- 切点对齐规则：
  1. 收集所有合法切点（user message 起点、assistant message 起点）。
  2. 从末尾向前累加 token，直到达到 `keepRecentTokens`。
  3. 在最近的合法切点对齐。
  4. 若切点位于 turn 内部，将该 turn 整体前缀加入 `turnPrefixMessages` 单独总结（split-turn 处理）。
- 严格禁止：tool message 与其 assistant tool_calls 之间出现切点。
- 由于 ohbaby 当前将工具调用与工具结果共同持久化在 assistant message 的 `ToolPart` 内，improve-1 的 split-turn 只在 message boundary 粒度处理；不要在单个 `ToolPart` 内部切开。

**新增常量**（[constants.ts](../../../../packages/ohbaby-agent/src/core/context/constants.ts)）：

```ts
export const KEEP_RECENT_TOKENS = 20_000;
export const COMPACTION_RESERVE_TOKENS = 16_384;
```

原有 `COMPRESSION_PRESERVE_RATIO` 保留为兜底，但默认路径走绝对值规则。

### 3.2 CP2-B：Token 估算 provider 锚点

**目标**：消除 PC-5。

**算法归属**：领域感知层在 context，原语层留在 services（见 [1.5 表](#15-跨模块影响范围硬约束)）。

**改动**：

- `core/message/`：`Part` 允许在 metadata 中携带 `tokenUsage: { promptTokens, completionTokens, totalTokens }`。是**向后兼容的新增字段**，旧 Part 无此字段。assistant message 在 `Lifecycle` 流式完成时写入。
- `services/llm-model/tokenCounting.ts`：**不新增导出**。`estimateTokensForText / estimateTokensForMessage / getBudget / getLimit` 保持不变。
- `core/context/token-estimation.ts`（新建）新增：

  ```ts
  import type { MessageWithParts } from "../message/index.js";
  import { estimateTokensForText } from "../../services/llm-model/index.js";

  export function estimateContextTokens(
    history: readonly MessageWithParts[],
  ): {
    readonly tokens: number;
    readonly anchorTokens: number;
    readonly tailTokens: number;
    readonly anchorIndex: number;
  };
  ```

  算法：
  - 找到最末一条 part metadata 含 `tokenUsage` 的 assistant message 作为锚点。
  - 锚点贡献 = `promptTokens + completionTokens`（provider 真值）。
  - 锚点之后 = 用 `estimateTokensForText` 对每条 message 序列化文本估算后求和。
  - 无锚点则回退全量字符估算（调用 `estimateTokensForText` over `serializeHistory(history)`）。
- `context-manager.ts` 在算 `estimatedTokens` 与 `getUsage` 时改用新函数。

**为何不下沉到 services**：

`estimateContextTokens` 需要消费 `MessageWithParts / Part` 两个领域类型，强制 services 模块感知这些类型会破坏 services 的"领域无关"边界。算法本身的复杂度（找锚点 + 切片求和）与 services 的原语能力（字符估算）相比，复杂度跨度更适合分层而非合并。

### 3.3 CP2-C：压缩 prompt 升级

**目标**：消除 PC-6 的结构层问题（本轮**不实现**增量更新）。

**改动**：

- [`compression-prompt.ts`](../../../../packages/ohbaby-agent/src/core/context/compression-prompt.ts) 重写为 Markdown 6 节：

  ```
  ## Goal
  ## Constraints & Preferences
  ## Progress
  ### Done
  ### In Progress
  ### Blocked
  ## Key Decisions
  ## Next Steps
  ## Critical Context
  ```

- 新增 `SUMMARIZATION_SYSTEM_PROMPT` 约束 summary agent 角色（"你是上下文压缩助手，只输出指定结构，不添加解释"）。
- `summarizeActiveHistory` 在调用 `llmClient.generateSummary` 时同时传入 system prompt。

### 3.4 CP2-D：文件操作追踪

**目标**：消除 PC-7。

**改动**：

- 新增 `core/context/file-ops.ts`：

  ```ts
  export interface FileOpsExtract {
    readonly read: readonly string[];
    readonly modified: readonly string[];
  }
  export function extractFileOps(
    history: readonly MessageWithParts[],
  ): FileOpsExtract;
  ```

  扫描 history 中 tool part 的 input，按约定工具名识别：
  - 读操作工具名集合：`read_file`、`view`、`cat` 等（可配置）。
  - 写操作工具名集合：`write_file`、`edit_file`、`apply_patch`、`str_replace` 等。
  - 未知工具名静默忽略。
  - 路径从 `input.path / input.file_path / input.filename` 等约定字段提取。

- `summarizeActiveHistory` 在 LLM 返回 summary 后，追加：

  ```
  <read-files>
  - path/to/a
  </read-files>
  <modified-files>
  - path/to/b
  - path/to/c
  </modified-files>
  ```

- 读写均为空时不附加任何块。

### 3.5 阈值升级（PC-11 内联在 CP2-A）

`getContextUsage` 在 `tokenCounter.getBudget` 可用时改用绝对值规则：

```
shouldCompress = (inputBudgetTokens - currentTokens) < COMPACTION_RESERVE_TOKENS
```

`getBudget` 不可用时回退到现有比例阈值。

### 3.6 代码改动清单（CP2 汇总）

| 文件 | 改动 |
|------|------|
| `core/context/context-manager.ts` | 切点重写、阈值改绝对量、接入 file-ops、接入 estimateContextTokens、接入新 prompt |
| `core/context/constants.ts` | 新增 `KEEP_RECENT_TOKENS / COMPACTION_RESERVE_TOKENS` |
| `core/context/compression-prompt.ts` | Markdown 6 节 + system prompt |
| `core/context/file-ops.ts`（新建） | 文件操作提取 |
| `core/context/manager.unit.test.ts` | 各算法测试用例 |
| `core/context/token-estimation.ts`（新建） | `estimateContextTokens`（消费 services 的 `estimateTokensForText`） |
| `services/llm-model/*` | **不修改**。`estimateTokensForText` 等原语保持现状被消费 |
| `core/message/types.ts`（少量） | Part metadata 支持 `tokenUsage`（向后兼容新增字段） |
| `core/lifecycle/lifecycle.ts`（少量） | 流式完成时把 `tokenUsage` 写入 metadata |

> 说明：CP2-B 的最后一项改动到 `lifecycle.ts`。该改动**不影响** lifecycle improve-1 的接口设计，只是在流式完成的现有写入点追加一个 metadata 字段。

### 3.7 验收衔接

详见 [acceptance.md AC-2 系列](./acceptance.md#三ac-2-系列算法层正确性验收)。

---

## 四、阶段 CP3：数据模型微调与可观测性

### 4.1 CP3-A：compacted 过滤集中

**目标**：消除 PC-8。

**改动**：

- 新增 `core/context/filters.ts` 暴露 `isActivePart(part)` 单一谓词。
- `getActiveHistory` 与 `serializePart` 都改用此谓词。
- 未来若要扩展"已压缩但允许调试展示"等规则，只改一处。

### 4.2 CP3-B：summary 识别封装

**目标**：缓解 PC-9（不引入新类型，但消除散布扫描）。

**改动**：

- 新增 `core/context/summary.ts` 暴露：

  ```ts
  export function isSummaryMessage(message: MessageWithParts): boolean;
  export function getSummaryMessages(history): readonly MessageWithParts[];
  export function partitionSummary(history): {
    readonly summaries: readonly MessageWithParts[];
    readonly nonSummary: readonly MessageWithParts[];
  };
  ```

- `context-manager.ts` 中 `isContextSummary` 调用全部切到新函数。
- 原 `serialization.ts:isContextSummary` 标记 `@deprecated`，转发到新函数。
- 一等公民类型升级留 improve-2。

### 4.3 CP3-C：可观测事件追加

**目标**：消除 PC-12。

**改动**：

- [`events.ts`](../../../../packages/ohbaby-agent/src/core/context/events.ts) 新增两个事件：

  ```ts
  ContextEvent.TurnPrepared = BusEvent.define("context.turn-prepared", z.object({
    sessionId: z.string(),
    usage: ContextUsageSchema,
    tookMs: z.number(),
    triggeredCompaction: z.boolean(),
  }));

  ContextEvent.CompactSkipped = BusEvent.define("context.compact-skipped", z.object({
    sessionId: z.string(),
    reason: z.union([
      z.literal("not-needed"),
      z.literal("too-short"),
      z.literal("inflated"),
    ]),
    usage: ContextUsageSchema,
  }));
  ```

- `prepareTurn` 完成时发布 `TurnPrepared`。
- 决策为 `skip` 或 summarize 失败为 `inflated` / `skipped` 时发布 `CompactSkipped`。
- 现有 `Compressed / Pruned` 事件**不动**。

### 4.4 代码改动清单（CP3 汇总）

| 文件 | 改动 |
|------|------|
| `core/context/filters.ts`（新建） | `isActivePart` |
| `core/context/summary.ts`（新建） | `isSummaryMessage` 等 |
| `core/context/serialization.ts` | `isContextSummary / serializePart` 切换调用，旧导出保留 |
| `core/context/context-manager.ts` | `getActiveHistory / prepareTurn` 切到新谓词与新事件 |
| `core/context/events.ts` | 新增两个事件 |
| `core/context/manager.unit.test.ts` | 事件发布断言、新谓词测试 |

### 4.5 验收衔接

详见 [acceptance.md AC-3 系列](./acceptance.md#四ac-3-系列数据模型与可观测性验收)。

---

## 五、阶段间依赖图

```
        CP1 (prepareTurn 契约)
         │
         │   ┌── CP2-A (切点 + 阈值)
         │   ├── CP2-B (token 锚点)
         │   ├── CP2-C (压缩 prompt)
         │   └── CP2-D (文件追踪)
         │
         │   ┌── CP3-A (过滤集中)
         │   ├── CP3-B (summary 识别)
         │   └── CP3-C (事件追加)
         ▼
   lifecycle improve-1 P2 (runSession)
```

CP1 必须先于 lifecycle improve-1 P2。CP2 / CP3 与 lifecycle improve-1 完全并行。

---

## 六、回滚方案

| 阶段 | 回滚方式 |
|------|---------|
| CP1 | revert `prepareTurn` 相关 commit；现有调用方未动 |
| CP2-A | revert 切点 commit；旧 `getHistoryToCompress` 仍在版本历史 |
| CP2-B | revert token 锚点 commit；`estimateTokensForText` 仍可用 |
| CP2-C | revert prompt 文件；旧 XML prompt 仍在版本历史 |
| CP2-D | revert file-ops；摘要回退为不附加文件块 |
| CP3-* | 各子项独立 commit，分别可回滚 |

---

## 七、不在本计划内的事项

- 增量摘要更新（`UPDATE_SUMMARIZATION_PROMPT`）：留 improve-2
- Context summary 升级为一等公民消息类型：留 improve-2
- Session tree / branch / fork 模型：留 improve-N
- Branch summarization：留 improve-N
- 多 provider 抽象：留 improve-N
- Compaction hooks 公开 API：仅在出现明确消费者时立项

---

## 八、后续文档

- 改造动机见 [problem-analysis.md](./problem-analysis.md)
- 验收标准见 [acceptance.md](./acceptance.md)
- 协同关系见 [README.md](./README.md)
- 与 lifecycle improve-1 接合面定义见 [lifecycle improve-1 implementation-plan.md 第二节](../../lifecycle/improve-1/implementation-plan.md#二阶段-p1context-模块建立-prepareturn-契约)

---

## 九、跨模块接合面附录

本附录是 [1.5 跨模块影响范围](#15-跨模块影响范围硬约束) 的细化清单，列出 context 模块**消费**的所有对外模块接口，便于审阅时核对边界。

### 9.1 消费的 `services/llm-model` 接口

| 接口 | 在何处消费 | 用途 |
|------|---------|------|
| `estimateTokensForText(text: string): number` | `core/context/token-estimation.ts`（新）、`core/context/context-manager.ts` 现有路径 | 文本级 token 估算原语 |
| `TokenCounter.getBudget(modelId, options)` | `core/context/context-manager.ts:getContextUsage` | 模型级 budget 查询，用于绝对量阈值判定 |
| `TokenCounter.getLimit(modelId)` | `core/context/context-manager.ts:getContextUsage` | 回退路径的窗口大小查询 |

### 9.2 消费的 `core/system-prompt` 接口

| 接口 | 在何处消费 | 用途 |
|------|---------|------|
| `SystemPromptProvider.build({ sessionId, directory, isSubagent })` | `core/context/context-manager.ts:assemble` 与 `prepareTurn` | 拿到已组装好的 system prompt 字符串 |
| `scanPromptLikeContent(content, opts)` | `core/context/serializer.ts`（新） | memory 注入前对 memory 内容做安全扫描（与 adapter 当前逻辑等价搬迁） |

> 注：`scanPromptLikeContent` 是 system-prompt 模块已经导出的能力（[`security/index.ts`](../../../../packages/ohbaby-agent/src/core/system-prompt/security/)）。context 仅作为新消费者出现，不要求 system-prompt 暴露新 API。

### 9.3 消费的 `core/memory` 接口

| 接口 | 在何处消费 | 用途 |
|------|---------|------|
| `MemoryReader.load(directory)` | `core/context/context-manager.ts:assemble` 与 `prepareTurn` | 加载并合并 memory 文件 |

### 9.4 消费的 `core/message` 接口

| 接口 | 在何处消费 | 用途 |
|------|---------|------|
| `MessageManager.listBySession(sessionId)` | `core/context/context-manager.ts:assemble / prepareTurn / prune / summarizeActiveHistory` | 拉取会话历史 |
| `MessageManager.createMessage / appendPart / updatePart` | 同上 | 写入压缩 summary、标记 compacted |
| `Part.metadata.tokenUsage`（新增字段） | `core/context/token-estimation.ts`（新） | 读取 provider usage 锚点 |

### 9.5 被 `core/lifecycle` 消费的 context 新接口

| 接口 | 消费方 | 用途 |
|------|------|------|
| `ContextManager.prepareTurn(input)` | `core/lifecycle/lifecycle.ts:runSession`（lifecycle improve-1 P2） | 每轮 LLM 调用前组装输入 |

详见 [lifecycle improve-1 implementation-plan.md 三、阶段 P2](../../lifecycle/improve-1/implementation-plan.md#三阶段-p2lifecycle-引入-runsession-新入口)。
