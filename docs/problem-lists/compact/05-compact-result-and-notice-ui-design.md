# Compact 结果语义与 Notice UI 优化设计

> 本文是 `docs/problem-lists/compact/01-04` 的增量设计，聚焦当前新增问题：手动 `/compact` 已可触发，但缺少清晰 running 状态；结果文案展示 `17,881 -> 23,671 tokens` 容易误导；`notice` 固定停留在输入框上方，不能像历史消息一样随 transcript 滚动。

## 1. 目标

本轮目标分为两条线：

1. **后端 compact 正确性**：只有提交后的 active context 估算确实下降，才允许返回 `status: "compacted"`。少消息会话被强制 `/compact` 后 summary 反而更大是正常情况，应跳过或轻提示；长会话如 `80k / 128k` 压缩后仍比压缩前更大，必须被后端挡住，不能以成功结果进入 UI。
2. **前端 UI 语义**：running 时显示 `Compacting...` spinner；成功后用户可见文本只显示 `Compacted`；token delta 不显示在默认 UI；compact 成功不再作为 persistent notice 粘在输入框上方。本轮先用命令结果承载 `Compacted`，完整 UI-only 历史边界作为下一步 schema 改造。

非目标：

- 不在本轮实现完整 overflow fallback / circuit breaker / microcompact。
- 不把所有 notice 都写入 LLM 上下文。
- 不在 UI 默认展示 before/after token delta、压缩比例、contextWindowSource 等调试字段。

## 2. 参考项目结论

### 2.1 opencode

opencode 的 `/compact` 设计把三类反馈分开：

- 命令只触发 summarize，不把 token delta 作为用户结果文案。
- session sync 层用 `compacting` 表示 running 状态。
- toast 是短暂 overlay，有 `duration`，不会成为 transcript 底部的固定内容。
- compaction part 是历史结构边界，可以随 transcript 滚动。

本轮借鉴点：**运行状态由状态驱动，短提示使用 TTL，持久 compact 结果用历史边界表达。**

### 2.2 claude-code

claude-code 在 compact 开始时显示 `Compacting conversation` spinner；完成后插入 `Conversation compacted` boundary message。token 数和 messages summarized 等信息进入 metadata，不默认展示在主 UI。

本轮借鉴点：**compact 的用户可见结果是短句边界，不是 token 报表；metadata 与 UI 文案分离。**

## 3. ohbaby 当前根因

### 3.1 结果文案问题

当前 `/compact` 的 command output 在 `packages/ohbaby-cli/src/tui/store/events.ts` 中格式化为：

```text
compact: compacted (17,881 -> 23,671 tokens)
```

同时 `packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts` 会把 context notice 格式化为：

```text
Context compacted: 17,881 -> 23,671 tokens.
```

这导致两个问题：

1. 用户看到两个相近但不完全一致的 compact 结果。
2. `status: "compacted"` 与 `usageAfter < usageBefore` 没有形成强不变量，出现 token 变大时仍像成功。

### 3.2 Notice 粘底问题

`TranscriptViewport` 的渲染顺序是：

```tsx
<CommittedTranscript />
<CommandNoticeLane />
<LiveTail />
<WorkingSpinner />
<NoticeLane />
```

`NoticeLane` 位于 spinner 后面，视觉上就贴在输入框上方。其状态来自 `state.notices`，`appendUiNotice()` 只做 key dedupe 和最近 10 条保留，不会在下一条用户消息或下一次 run 开始时进入历史，也没有 TTL。

这不是单纯布局 bug，而是状态模型问题：当前 `notice` 被设计成“持久 lane state”，但用户期望它要么是短提示，要么成为会滚动的历史事件。

## 4. 最终形态

### 4.1 用户可见文案

| 场景 | UI 表达 | token delta |
|------|---------|-------------|
| 手动 `/compact` 正在执行 | spinner: `Compacting...` | 不显示 |
| 手动 `/compact` 成功提交 summary | 历史边界：`Compacted`；command result：`Compacted` | 不显示 |
| prune-only 生效 | 历史边界或 command result：`Compacted` | 不显示 |
| 少消息会话，强制 compact 后不划算 | 轻提示：`Compact skipped` 或 `Already compact enough` | 不显示 |
| 长会话 summary 候选膨胀或提交后 token 未下降 | 轻提示：`Compact skipped`，debug 记录原因 | 默认 UI 不显示 |
| compact 失败 | 轻提示：`Compact failed`，继续使用原上下文 | 默认 UI 不显示 |

说明：

- 默认 UI 只出现 `Compacted`，避免 `before -> after` 的解释成本。
- token delta 仍保留在 `CompactResult.usageBefore/usageAfter` 和日志/测试断言中。
- 如果压缩没有实际提交，不显示 `Compacted`。

### 4.2 后端提交不变量

`status: "compacted"` 必须满足：

```text
usageAfter.currentTokens < usageBefore.currentTokens
```

推荐再加一个最小收益阈值，避免 `80000 -> 79950` 这种几乎无收益的 compact 被当作成功。阈值建议：

```text
minSavedTokens = max(1024, usageBefore.currentTokens * 0.02)
```

本轮可以先使用更保守的硬不变量：

```text
usageAfter.currentTokens < usageBefore.currentTokens
```

后续再引入 `minSavedTokens` 作为策略配置。

### 4.3 少消息与长消息的区别

少消息会话：

- `activeHistory.length <= 2` 或 `usageBefore.shouldCompress === false`。
- 即使用户手动 `/compact --force`，summary 比原文大也不是 bug。
- 返回 `not-needed` 或 `inflated` 均可，但 UI 应轻提示，不报 error，不显示 token delta。

长会话：

- 例如 `80k / 128k`，达到或接近 compact threshold。
- 如果 summary 候选比被压缩片段短，但最终 active context 仍未下降，说明估算、anchor、summary 注入或状态提交有问题。
- 后端必须拒绝返回 `compacted`，并发布可观测的 skipped/inflated 事件。

## 5. 后端设计

### 5.1 将 summary 生成与提交拆开

当前 `summarizeHistory()` 同时负责：

1. 选择 historyToCompress。
2. 调用 LLM 生成 summary。
3. 创建 summary message。
4. 标记旧 parts 为 compacted。
5. 清理 retained tokenUsage。

这使得“提交前比较 projected context”很难做。建议拆成两步：

```typescript
type SummaryCandidate = {
  readonly status: "candidate" | "skipped" | "failed" | "inflated";
  readonly snapshot?: string;
  readonly historyToCompress: readonly MessageWithParts[];
  readonly originalTokens: number;
  readonly newTokens: number;
  readonly savedTokens: number;
  readonly error?: string;
};

async function generateSummaryCandidate(...): Promise<SummaryCandidate>;

async function commitSummaryCandidate(...): Promise<CompressionResult>;
```

生成 candidate 时不修改消息历史。只有 projected usage 通过校验后，才创建 summary message、标记 old parts、清理 retained tokenUsage。

### 5.2 Projected usage 校验

提交前构造内存中的 projected history：

1. 从 raw history 中拿 active history。
2. 对 `historyToCompress` 的 parts 做临时 compacted 标记。
3. 插入临时 synthetic summary message。
4. 对 retained active parts 临时移除 `metadata.tokenUsage`，模拟真实 commit 后的 stale anchor 清理。
5. 用和正式 assemble 相同的 `getActiveHistory()` / `assembleFromRawHistory()` / `getContextUsage()` 路径计算 projected usage。
6. 如果 projected usage 没有优于 after-prune baseline，不提交 candidate。

比较基准必须分两层：

```text
prune 是否有效: usageAfterPrune.currentTokens < usageBefore.currentTokens
summary 是否值得提交: projectedUsage.currentTokens < usageAfterPrune.currentTokens
```

原因：当前 compact 流程先 prune 再 summarize。如果 prune 已经把 context 从 `100k` 降到 `50k`，但 summary candidate 的 projected context 变成 `90k`，它虽然仍小于最初 `100k`，却比“不提交 summary、只保留 prune 结果”更差。因此 summary 提交必须和 after-prune baseline 比，而不是只和最初 before 比。

伪代码：

```typescript
const candidate = await generateSummaryCandidate(...);
if (candidate.status !== "candidate") return skippedOrFailed(candidate);

const projectedContext = assembleProjectedContext({
  assembled,
  candidate,
  compactedAt: now(),
});
const projectedUsage = getContextUsage(
  projectedContext,
  input.modelId,
  options.tokenCounter,
  compressionThreshold,
);

if (projectedUsage.currentTokens >= usageAfterPrune.currentTokens) {
  publishCompactSkipped("inflated", projectedUsage);
  return {
    status: pruneWasUseful ? "pruned" : "inflated",
    usageBefore,
    usageAfter: pruneWasUseful ? usageAfterPrune : usageBefore,
    prune: pruneResult,
    compression: candidateToInflatedCompression(candidate),
  };
}

const compression = await commitSummaryCandidate(candidate);
```

### 5.3 状态语义

| 状态 | 含义 |
|------|------|
| `compacted` | summary 或等价 compact boundary 已提交，且 active context 下降 |
| `pruned` | 只提交了 tool result pruning，且 active context 下降 |
| `not-needed` | 未达到阈值，或少消息会话无需 compact |
| `inflated` | summary 候选或 projected context 不划算，未提交 summary |
| `failed` | summary 生成失败，未提交 summary |

重要约束：

- `compacted` 不再只由 `compression.status === "compressed"` 决定。
- `compactStatusFromCompression()` 不能继续只看 `compression.status` / `prunedCount`，状态决策必须接收 `usageBefore`、`usageAfterPrune`、`projectedUsage`、`usageAfter`。
- 如果 prune 已经有效降低 context，但 summary candidate 膨胀或 projected usage 变差，应优先返回 `pruned`，因为实际提交效果是 prune。
- 如果没有任何有效提交，不应返回 `compacted`。

### 5.4 Legacy `compress()` 入口

`ContextManager.compress()` 仍是公开 API，不能保留旧的“summary 片段变小即 compressed”语义。实现时有两种安全选择：

1. **推荐**：让 `compress()` 复用 `compact()` 的 candidate/projected/commit 逻辑，再把 `CompactResult` 映射回 `CompressionResult`。只有 `compact()` 最终返回 `compacted` 时，`compress()` 才返回 `status: "compressed"`。
2. **短期可接受**：明确把 `compress()` 标为 legacy internal，并保证 UI/runtime 不再把它的 `compressed` 结果当成 compact 成功事实来源。

本轮采用推荐方案，避免公共 API 留下第二套不安全状态语义。

## 6. 前端与 UI 设计

### 6.1 Spinner

`UiRunStatus.running` 已有 `title?: string`，`WorkingSpinner` 也已读取 runtime。实现时优先复用这一点：

- 手动 `/compact` 开始时显示 `Compacting...`。
- spinner 文案固定使用 `Compacting...`，不要随机工作短语。
- compact 结束后恢复 `idle`。

当前 command 服务只发布 `command.started` / `command.result.delivered` / `command.failed`，不会直接设置 `runtime.running`。因此本轮采用最小安全方案：

1. TUI store 在收到 `command.started` 且 `commandId === "compact"` 时，派生一个本地 `runtime: { kind: "running", runId: commandRunId, title: "Compacting..." }`。
2. 收到同一个 `commandRunId` 的 result 或 failed 后，如果当前 runtime 仍是该 command 派生的 running 状态，则恢复 `idle`。
3. `WorkingSpinner` 优先显示 `runtime.title`；没有 title 时继续使用现有随机工作短语。

长期方向可以把 command-running 变成 SDK 明确事件，但不阻塞本轮修复。

### 6.2 Command result

`session.compact` 的格式化逻辑改为：

```text
Compacted
```

失败或跳过：

```text
Compact skipped
Compact failed
```

不再格式化 `before -> after tokens`。

### 6.3 Compact 历史边界

增加一个不会进入 LLM 上下文的 UI 历史事件，推荐形态：

```typescript
type UiMessagePart =
  | ...
  | {
      readonly type: "event";
      readonly event: {
        readonly kind: "compact";
        readonly label: "Compacted";
      };
    };
```

如果短期不想扩展 SDK message part，可以先用 `role: "system"` + text part `Compacted`，并在 context serialization 中明确排除这种 UI-only system message。

推荐优先级：

1. **最佳**：新增 UI-only event part，不进入 core message/LLM serialization。
2. **可接受短期方案**：系统消息 `Compacted`，但必须带 metadata 标识并从 LLM serialization 排除。
3. **不推荐**：继续用 persistent `NoticeLane` 表示 compact 成功。

本轮实施选择：先不落地持久化历史边界，避免在 SDK message schema、持久化 store、message renderer、LLM serialization 之间引入半成品状态。`CommandNoticeLane` 的 `/compact` result 先作为可滚动的命令结果承载 `Compacted`；随后单独做 UI-only event part。

### 6.4 Notice 分层

把当前 `notice` 重新划分：

| 类型 | 用途 | 生命周期 |
|------|------|----------|
| compact success | 会话结构事件 | 历史边界，随 transcript 滚动 |
| compact skipped/failed | 轻提示 | TTL 或下一次用户输入/run 开始清除 |
| provider/connect warning | 轻提示 | TTL 或下一次用户输入/run 开始清除 |
| prompt security warning | 可保留 notice | 可以保留，但不要粘在输入框；后续可做折叠/TTL |

本轮最小可行改法：

- compact success 不再发 `notice.emitted`。
- `NoticeLane` 不再作为 compact 成功的承载。
- 增加 `clearEphemeralNotices()`，在下一条 active user message 或下一次 runtime running 时清理短生命周期 notice，避免长期粘底。
- 不无差别清空所有 notice；`prompt-security:*` 等需要较长可见性的 notice 暂时保留。

compact success 的移除点必须覆盖两条路径：

1. 手动 compact：`composition.compactSession()` 当前会通过 `noticeFromCompactResult()` 发 notice。
2. 自动 compact：`run-stream-adapter` 当前会在 run turn/context prepared event 中根据 compaction 发 notice。

这两处对 `compacted` / `pruned` 都不再发 info notice；只允许 `failed` / `inflated` / skipped 类结果发轻提示。

更完整的后续改法：

- 给 `UiNotice` 增加 `expiresAt` 或 `ttlMs`。
- TUI store 定时清理过期 notice。
- prompt-security 类 notice 可设置更长 TTL 或 fold。

## 7. 实施计划概览

### 7.1 后端 compact 优化

涉及文件：

- `packages/ohbaby-agent/src/core/context/context-manager.ts`
- `packages/ohbaby-agent/src/core/context/types.ts`
- `packages/ohbaby-agent/src/core/context/events.ts`
- `packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts`
- `packages/ohbaby-sdk/src/compact.ts`
- `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

步骤：

1. 为少消息、candidate inflated、projected usage 不下降补测试。
2. 拆分 `summarizeHistory()` 为 generate candidate 与 commit candidate。
3. projection 中模拟 compacted parts、summary message 和 retained `tokenUsage` 清理。
4. 在 `compact()` 和 `prepareTurn()` 路径加入 projected usage 校验，并以 after-prune baseline 判断 summary 是否值得提交。
5. 调整 `compactStatusFromCompression()`，不再仅凭 `compressed` 返回 `compacted`。
6. 让 legacy `compress()` 复用安全 compact 语义，或至少不作为 UI 成功事实来源。
7. 保持 before/after usage 在 result 中，但不让默认 UI 展示。

### 7.2 前端 UI 显示优化

涉及文件：

- `packages/ohbaby-cli/src/tui/store/events.ts`
- `packages/ohbaby-cli/src/tui/components/working-spinner.tsx`
- `packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.tsx`
- `packages/ohbaby-cli/src/tui/components/transcript/notice-lane.tsx`
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`
- `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`
- `packages/ohbaby-agent/src/commands/builtin.ts`
- `packages/ohbaby-agent/src/commands/service.unit.test.ts`

步骤：

1. 修改 `session.compact` command output，成功只显示 `Compacted`。
2. `WorkingSpinner` 优先显示 `runtime.title`。
3. TUI store 根据 compact `command.started` 派生本地 `Compacting...` running 状态，并在 result/failed 时恢复。
4. compact 成功不再生成 persistent context notice。
5. 清理 ephemeral notice 的粘底行为：至少在下一条 user message 或 runtime running 时清除，同时保留 prompt-security 等长可见性 notice。
6. 本轮先用 command result 承载成功反馈；UI-only compact history boundary 作为下一步独立 schema 改造。

## 8. 验收标准

后端：

- 少消息会话 `/compact --force` 且 summary 更大时，不返回 `compacted`，不修改历史。
- 长会话 projected usage 不下降时，不提交 summary，不返回 `compacted`。
- prune 已经降低 context、summary projected usage 反而高于 after-prune baseline 时，只返回 `pruned`，不提交 summary。
- projected usage 模拟 retained `tokenUsage` 清理，和真实 commit 后估算口径一致。
- 只有 `usageAfter.currentTokens < usageBefore.currentTokens` 时才允许 `status: "compacted"`。
- prune-only 有实际下降时可返回 `pruned`，UI 仍可显示 `Compacted`。
- token delta 保留在 `CompactResult` 内部数据中，测试可断言。

前端：

- `/compact` 运行时可见 `Compacting...`。
- 成功后默认 UI 只显示 `Compacted`，不出现 `17,881 -> 23,671 tokens`。
- compact success 不再以 `notice Context compacted: ...` 粘在输入框上方。
- ephemeral notice 在后续用户消息或 run 开始后不继续固定在 prompt 上方。
- prompt-security 等长可见性 notice 不被误删。
- `contextWindowSource` 等内部字段不显示在 UI。

## 9. 子代理审核清单

### 后端审核

请重点审核：

1. `compacted` 状态是否被绑定到 active context 下降，而不是 summary 字符串下降。
2. generate candidate 与 commit candidate 的拆分是否足以避免 partial mutation。
3. prune-only、small session、large session inflated 三种情况的状态语义是否清晰。
4. 是否遗漏 `prepareTurn()` 自动 compact 路径。

### 前端审核

请重点审核：

1. compact success 是否从 persistent notice 中移除。
2. `NoticeLane` 粘底根因是否被正确处理。
3. spinner 是否复用 runtime/title 机制，避免新增平行状态。
4. command result、历史边界、轻提示三者是否职责清楚。
