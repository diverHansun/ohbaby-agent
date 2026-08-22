# 0. 讨论记录与已确认要点

> 2026-08-22 与用户完成两轮开发前讨论后定稿。本文只冻结已确认结论；代码证据见 [01](./01-problem-analysis-and-current-state.md)，实施契约见 [02](./02-optimization-plan-and-change-scope.md)。

---

## 1. 背景与动机

improve-4 已让实时 Lifecycle 计量包含本 step 实际发送的 tool schemas，但静态查询和手动 compact 仍是 messages-only。由于实时、静态、手动路径共用 EMA calibration factor，这个缺口会形成系统性口径偏差，而不是单纯的“粗略显示”。

本批因此被定义为 improve-4 的收尾：补齐 tools-aware measurement、主代理静态/手动路径和 `/status` 的一致性。prompt cache 暂不分析也不实施。

代码复核还发现两项必须随 4.1 一起关闭的问题：

1. `/compact` 后 `ContextWindowUsageTracker` 不会更新，cache-first 的 `/status` 可能继续返回压缩前旧值。
2. 现有文档误把一个 child session 当成一个子代理。实际实现允许多个 subagent record 共享 child session，每个实例用独立 `contextScopeId` 和 `role` 隔离；仅从 Session 读取 `isSubagent` / `agentName` 无法恢复某个实例的真实上下文。

---

## 2. 已确认：本批目标与边界

| 决策项 | 已确认结论 |
|--------|------------|
| 本批目标 | tools-aware 计量 + 主代理静态查询/手动 compact/status 闭环 |
| cache | improve-5 独立待分析，本批完全不碰 |
| 压缩策略 | 本批不审查阈值、档位、prune/summary 策略；4.1 完成后另开第一次压缩闭环审查 |
| UI | 本批不新增 breakdown 或新展示；只修已有 `/status`/tracker 数据一致性 |
| memory | 不做 LLM 主动搜索工具或 hooks 注入 |
| tokenizer | 不替换现有 heuristic，不引入 tiktoken |
| `AssembledContext` | 保持会话级组装语义，不加入 tool schemas |

---

## 3. 已确认：计量边界采用 request-shaped payload，但不冒充实际请求

### 3.1 决策

定义窄语义的：

```ts
interface ContextMeasurementPayload {
  readonly messages: readonly ChatCompletionMessage[];
  readonly tools: ChatCompletionCreateParams["tools"];
}
```

它表示“本次 token estimation 必须看到的 wire 内容”，不是 provider 的完整发送请求。

项目里已经存在真正的 `InterfaceProviderRequest`，其中还有 `model`、`temperature`、`maxTokens`、`signal`。因此不再使用容易误导的通用名 `RequestPayload`，也不在 4.1 重构 provider transport。

### 3.2 system prompt 不单列

ohbaby 的 serializer 已把 system prompt 和 memory 折入第一条 system message，所以 measurement payload 只需要 `messages + tools`。照抄 pi 的独立 `systemPrompt` 字段会重复计量。

### 3.3 tools 不进入 `AssembledContext`

`AssembledContext` 是跨轮组装结果；tool schemas 随 agent、permission、step 和 MCP menu 状态变化，属于每次请求/计量时重建的数据。两者分开可避免“这份 context 里的 tools 属于哪一轮”的语义污染。

---

## 4. 已确认：工具解析与 system prompt 依赖方向

1. ContextManager 不访问 tool scheduler 或 MCP registry。
2. composition 负责主代理静态/手动路径的工具解析；Lifecycle 负责实时路径的工具解析。
3. 同一次解析结果派生两类数据：
   - `toolNames`：push 给 `SystemPromptProvider.build`。
   - `requestTools`：交给 measurement 和 provider send。
4. 生产 `SystemPromptProvider` 删除主动拉 registry 的 `toolsProvider` 通道。
5. 最终 step 仍先解析完整工具集合：prompt 的 `toolNames` 保持现有非空语义；随后才把实际 outbound `requestTools` 清为 `[]`。
6. “解析一次”特指同一路径内 schemas 与 prompt names 共用同一次 `resolvePromptTools`；MCP menu runtime prompt 的 selectable names 查询仍是现有独立关注点，本批不合并。

---

## 5. 已确认：主代理与子代理分界采用方案 A

### 5.1 主代理

- 公共 `getContextWindowUsage`、冷启动静态回退和用户触发的 `/compact` 只面向主代理 session。
- 主代理静态计算按“非最终 step”携带完整工具 schemas。
- 查询若命中 subagent child session，不返回一个看似精确、实则聚合了多个 scope 的数值；适配层返回“不提供/不可用”的既有 nullable 语义。

### 5.2 子代理

子代理必须拥有占用感知，但用途是**内部自动压缩**，不是用户查看：

```text
subagent run
  → prepareTurn(sessionId, contextScopeId, agentName, tools)
  → assemble 只取该 scope history
  → measureUsage 使用该 scope calibration factor
  → 同一 ContextManager 自动 prune/compact
```

本批不新增以下能力：

- 子代理静态占用 API
- scope-aware UI tracker
- 子代理占用条、breakdown 或 `/status` 展示

后续两轮 context 压缩审查都必须覆盖子代理的 scoped runtime measurement 和自动压缩，确保它不会因“无 UI”而失去运行保护。

### 5.3 为什么不能从 Session 补参

ohbaby 的多个 subagent record 可以共享同一个 child session；每条 record 才持有 `contextScopeId` 和实际 `role`。Session 上的 `agentName` 只能代表创建 child session 时的角色，不能代表所有兄弟 subagent。省略 scope 会同时造成：

- history 聚合兄弟 scope
- MCP loaded tools 选择错误
- calibration factor 回退到 session 级默认值
- 后创建的不同 role 使用错误 prompt

因此“从 Session 自动补 `isSubagent` / `agentName`，静态测量任意 agent”的旧结论作废。

---

## 6. 已确认：`/status` 与 compact 后 tracker

| 项 | 结论 |
|----|------|
| `/status` 占用字段 | 只保留 `contextWindow` |
| 旧 `context` 字段 | 从内部 status payload 删除 |
| `CommandServiceOptions.getContextUsage` | 若无其他生产消费者，一并删除，避免双数据源回流 |
| tracker 命中 | 返回最近一次真实 `prepareTurn` 或 compact 更新的值 |
| tracker 未命中 | 仅主代理回落到 tools-aware 静态计算 |
| 手动 compact 成功 | 使用 `result.usageAfter` 更新 tracker，并发布已有 `context.window.updated` |

“当前占用”的语义是最近一次已准备/已压缩上下文的测量结果。工具菜单等状态改变后，直到下一次 prepare/static refresh 才会更新；本批不把 tracker 扩为通用实时状态图。

---

## 7. 已确认：后续路线

```text
improve-4.1
  → 第一次压缩闭环审查（手动/自动/剪裁/prune；数据结构与数据流）
  → improve-5 prompt/cache
  → 第二次压缩闭环复核（纳入 cache usage 语义）
  → 主代理 context 占用监测与 UI
  → memory / 长期记忆调用机制
```

两次压缩审查都对照 pi、opencode、kimi-code，但只借鉴能解释 ohbaby 当前约束的做法，不照搬它们的多套 usage 口径。

---

## 8. 用户确认记录

- “确认采用方案 A。”
- 子代理也需要 context 占用监控，至少用于自动 compression；只有主代理窗口占用和各项占比需要展示/UI。
- 同意删除内部 status payload 的旧 `context` 字段及对应重复查询。
- improve-5 暂不占据当前顺序；4.1 后先检查手动压缩、自动压缩、上下文剪裁和 prune，improve-5 完成后再复核一次。
- 本批 improve-4.1 只实施本目录规范的内容；cache 与压缩机制重设计均不混入。

---

## 9. 未决项

无承重未决项。实施细节若与本文边界冲突，必须回到规划审查，不得在代码里默默扩大范围。
