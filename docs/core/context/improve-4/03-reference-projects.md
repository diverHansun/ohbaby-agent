# 3. 优秀项目借鉴

## 3.1 借鉴来源与阅读边界

| 项目 | 路径 | 本批关注点 |
|------|------|------------|
| Claude Code best | `/Users/hansunwork26/workspace/projects/code-cli/claude-code-best` | 计数请求如何携带最终 tools；只借契约，不复制闭源/反编译结构 |
| Codex | `/Users/hansunwork26/workspace/projects/code-cli/codex` | step-local 请求上下文；prompt 构建、工具执行共享同一已解析工具快照 |
| deepseek-harness (dsh) | `/Users/hansunwork26/workspace/projects/code-cli/deepseek-harness` | canonical request envelope、token meter；三类 breakdown/cache 只作后续对照 |
| Kimi Code | `/Users/hansunwork26/workspace/projects/code-cli/kimi-code` | 每步只物化一次 `stepTools`；完整 compaction lifecycle 与终态清理 |
| OpenCode | `/Users/hansunwork26/workspace/projects/code-cli/opencode` | V2 请求在发送前一次物化 tools；占用判断与 stream 共用；final step 清空 tools |
| pi | `/Users/hansunwork26/workspace/projects/code-cli/pi` | compaction start/end 的 UI 生命周期；静态估算与实时请求估算的边界 |

知识库中关于多层上下文、长期记忆的资料只用于辨别范围。本批不实施长期记忆、缓存、三类占用 UI 或新的 compaction hooks。

---

## 3.2 任务 A：同一请求快照

相关实时 loop 实现共同支持 request/step-local tools 快照；pi 则支持静态估算与实时 loop 保持不同信息边界。ohbaby 本批只采纳 **同一模型 step 的计量、压缩重测与 provider send 基于同一份已物化 tools**，不把它扩张成新的工具执行契约，也不为此创建更大的 Context 对象。

| 项目 | 观察到的做法 | ohbaby 的采纳 |
|------|--------------|---------------|
| Claude Code best | token count 请求同时接收 messages 与最终 tools | `estimateWireHeuristic(messages, tools)`；不再让 tools 游离于实时占用之外 |
| Codex | request-scoped `StepContext` 捕获 tools，一次 step 内 prompt 构建与执行共享 | 只采纳 step-local `resolvedTools`；**不**为了一个字段引入完整 `StepContext` 抽象 |
| dsh | token meter 与 provider request 使用同一 canonical request header/envelope，tools 在 envelope 内 | Lifecycle 先解析 tools，再把同一引用交给 `prepareTurn` 与 provider request |
| Kimi Code | `executeLoopStep` 在 hook 后生成一次 `stepTools`，之后请求与执行共用 | 每 step 只 `resolveTools` 一次；overflow force retry 复用，不二次解析 |
| OpenCode | V2 canonical request 一次物化 tools；占用判断和 stream 共用；final step 明确 `tools: []` | final step 的测量与发送都使用 `[]`，避免 schema 幽灵占用 |
| pi | 静态估算与真实 agent loop 的信息条件分开，不强迫静态入口伪造动态请求 | `getContextUsage` / 手动 compact 暂留 messages-only，并明确精度层级 |

这直接支持 SOLID/SRP：Lifecycle 拥有 step 与工具解析上下文，ContextManager 只接收已解析的 provider payload 片段并计量，不反向依赖 tool registry、MCP 或 skill 系统。

---

## 3.3 任务 B：完整自动 compact 生命周期

| 项目 | 可借鉴点 | ohbaby 的采纳/限制 |
|------|----------|-------------------|
| Kimi Code | compaction lifecycle 包住整个操作，结束/异常都有状态清理 | “开始”定义为实际 compact 已开始，不缩成 summary LLM 开始；用 `context:prepared` 与 run 终态清理 |
| pi | start/end 事件驱动 TUI 过程态，transcript 与 compaction 状态分离 | 复用 `Compacting...` 运行状态；不把摘要模型输出写入 transcript |
| Codex / OpenCode | 请求准备与后续动作保持 request/step 范围，不靠全局 mutable flag 表示过程 | 每个 Lifecycle generator 内使用局部 signal；不建全局 compaction 状态机 |
| dsh | compaction 有清晰阶段，但其 event-sourced surface/shadow 结构服务于自身存储模型 | 只借清晰时序；拒绝把 ohbaby 改成 event sourcing |

ohbaby 的本地语义比“摘要模型开始”更宽：`runCompaction` 选出 `prune` / `prune-summary` / `force` 后，任何 `pruneHistory` 发生前调用 `onCompactionStarted`。`none/mask` 不调用。因此纯 prune 与 summary 都显示过程态，同时不会为未执行的压缩误报。

---

## 3.4 明确不借鉴

| 项目 | 不抄 | 原因 |
|------|------|------|
| Codex | 完整 `StepContext`/TurnContext 基础设施 | ohbaby 只需要局部 `resolvedTools`；扩大抽象面属于过度设计 |
| pi | `session_before_compact` / `context` / `turn_end` hooks | 本批没有第二实现或扩展需求（YAGNI）；用户已确认不做 |
| pi | JSONL session + `firstKeptEntryId` | ohbaby 已有 SQLite、流式 part 更新与 part-level compacted 标记 |
| dsh | event-sourced surface replace + shadow price | 与现有存储模型不匹配，迁移成本远超本批收益 |
| dsh | `system/tools/messages` breakdown 与 ContextMeter | 留给后续占用监测/UI；improve-4 不加字段 |
| 任一项目 | cache usage 字段、cache policy、命中率/成本模型 | 独立 improve-5 逐项讨论，不预埋语义 |
| 任一项目 | 将 compaction summary 当普通对话消息显示 | 污染 transcript，还可能被再次压缩 |

---

## 3.5 对 02/04 的直接约束

1. `resolvedTools` 是 step-local canonical snapshot：prepare、所有 compaction 重测、overflow retry、provider send 共用。
2. final step 使用 `[]`，空工具不增加 heuristic。
3. 自动 compact 开始事件覆盖整个实际操作：非 `none/mask` 档位确定后、prune 前发出；纯 prune 必须命中。
4. 正常完成由 `context:prepared` 清除 `Compacting...`；取消、失败或提前结束由既有 run 终态兜底。
5. 不新增全局状态机、hooks、Bus UI 订阅、SDK compaction 字段或 transcript 消息。
