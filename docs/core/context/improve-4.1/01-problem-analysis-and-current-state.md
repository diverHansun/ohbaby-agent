# 1. 问题基线与当前实施状态

> 时间口径：规划复审基于 `main@6436c15`；业务代码与最初 `84006096` 基线之间无 4.1 实施变更。当前仅 improve-4.1 文档已存在，本文描述的代码问题均尚未修复。

---

## 1.1 承重问题

1. **静态查询与手动 compact 漏 tool schemas。** 实时 `prepareTurn` 已把 tools 传给每次 measurement；`ContextManager.getUsage` 和 `compact()` 仍调用没有 tools 的 `measureContext`（`core/context/context-manager.ts:1280-1296, 1414-1419`）。
2. **共享 calibration factor 放大了输入不一致。** 实时分母已是 `messages + tools`，静态分母仍只有 messages；两条路径却读取同一个 scoped factor。
3. **现有规划错误地把 Session 当成完整 subagent identity。** 多个 subagent record 共享一个 child session，每个实例才持有独立 `contextScopeId` 和 `role`（`agents/subagent-host.ts:353-402`）。只读 Session 无法静态恢复某个实例。
4. **`/status` 仍并行查询两份占用。** `handleStatus` 同时调用 `getContextUsage` 与 `getContextWindowUsage`，分别输出 `context` 和 `contextWindow`（`commands/builtin.ts:237-265`）。
5. **手动 compact 后 tracker 保留旧值。** `compactSessionInternal` 返回 `usageAfter`，但没有更新 `ContextWindowUsageTracker` 或发布 `context.window.updated`（`adapters/ui-inprocess.ts:1749-1764`）。
6. **prompt 通过侧通道拉取工具名。** `SystemPromptProviderOptions.toolsProvider` 让 prompt 构建主动查询 registry，而 measurement 拿不到同一次解析的 schemas（`core/system-prompt/assembler.ts:24-54`、`adapters/ui-runtime/composition.ts:408-445`）。
7. **最终 step 会绕过工具解析。** Lifecycle 在 `step === maxSteps` 时直接设 `tools=[]`，不调用 `resolveTools`（`core/lifecycle/lifecycle.ts:401-410`）。移除 prompt 的 `toolsProvider` 后若不调整时序，最终 step 的 prompt 会丢失当前工具名。
8. **“请求载荷层”的旧命名与真实发送边界冲突。** 真正的 `InterfaceProviderRequest` 已包含 model、messages、temperature、maxTokens、tools 和 signal（`services/interface-providers/types.ts:36-43`）；context 内再定义通用 `RequestPayload` 会形成两个自称真实请求的类型。

---

## 1.2 已确认的产品/技术分界

```text
主代理
  实时 run        → scoped/runtime measurement → 自动压缩
  冷启动查询      → primary static measurement → contextWindow
  用户 /compact   → primary manual measurement → tracker refresh
  /status         → contextWindow only

子代理
  实时 run        → sessionId + contextScopeId + agentName
                  → scoped measurement → 自动压缩
  静态/API/UI     → 本批不提供
```

重要区别：

- **机制层统一**：主/子代理实时运行共用 ContextManager 的 measurement、prune 和 compaction。
- **产品入口不统一**：面向用户的静态查询、手动 compact、status 和未来 UI 只服务主代理。

这不是把子代理变成“二等实现”，而是避免在缺少 scope identity 时制造虚假精确度。

---

## 1.3 context 模块现状诊断

### 1.3.1 goals-duty

| 文档/职责 | 代码现状 | gap |
|-----------|----------|-----|
| D1：Memory + SystemPrompt + History 组装为 `AssembledContext` | `assemble()` 只组装这三类数据（`context-manager.ts:682-718`） | 无；tools 不应加入会话级组装结果 |
| 子代理不加载 Memory、按 scope 过滤 history | `assemble(..., isSubagent, contextScopeId, agentName)` 支持该语义 | 实时调用正确；无 scope 的静态调用不能代表具体子代理 |
| D2：计算 context usage | `measureUsage` 是单一入口，底层 `estimateWireHeuristic` 已支持 tools | public/static/manual 调用点没有完整提供 measurement payload |
| G3：手动 `/compact` | UI 已限制为 primary session | core manual measurement 漏 tools；完成后 UI tracker 不刷新 |
| G2：85% 阈值 | 实现仍是 `COMPRESSION_THRESHOLD = 0.95` | 既有 gap；不在 4.1 修 |

### 1.3.2 architecture

当前层次本身合理：

| 层 | 位置 | 职责 |
|----|------|------|
| token heuristic | `services/llm-model/tokenCounting.ts` | 文本字符启发式；本批不动 |
| wire estimation | `core/context/token-estimation.ts` | 估算 serialized messages 与 tools JSON |
| context assembly | `core/context/context-manager.ts` | memory/prompt/history 组装与投影 |
| runtime orchestration | `core/lifecycle/lifecycle.ts` | 每 step 解析工具、prepare、send、回归 factor |
| composition | `adapters/ui-runtime/composition.ts` | 连接 session、tools、prompt、ContextManager |
| UI occupancy cache | `core/context/context-window-usage.ts` | session-keyed 的主代理展示投影 |

问题不是少一个新组件，而是边界表达不诚实：

- `measureUsage` 实际需要 request-shaped 的 `messages + tools`。
- `InterfaceProviderRequest` 才是 transport request。
- 因此 4.1 需要的是窄语义 `ContextMeasurementPayload`，不是新建第二套 provider request abstraction。

### 1.3.3 data-model

#### `AssembledContext`

包含 system prompt、memory、history、session identity 与可选 scope。它描述“待投影的会话上下文”，不应持有每 step 变化的 tool schemas。

#### `ContextMeasurementPayload`（目标缺口）

当前 `measureUsage` 用散落字段隐式表达：

```ts
messages
tools?
```

`tools` 可选导致静态/手动调用者能无意识漏传。目标类型应要求调用点**显式承认** tools，即使值是 `undefined` 或 `[]`。

#### calibration identity

`calibrationFactors` 已按 `sessionId + contextScopeId` 取 key。实时子代理传 scope 时正确；静态省略 scope 会读取 session 级 factor，不能代表任何一个共享 child-session 中的 subagent 实例。

#### subagent identity

`SubagentInstanceRecord` 持有：

- `sessionId`：多个兄弟实例可以相同
- `contextScopeId`：实例级隔离键
- `role`：实际 agent prompt/tool 选择身份

`Session.agentName` 只对应 child session 创建时的角色。旧规划所称“从 Session 读取 agentName 即可静态测准”与数据模型冲突。

#### tracker identity

`ContextWindowUsageTracker` 以单个 `sessionId` 为 key（`context-window-usage.ts:43-76`），没有 scope。这个模型适合未来的主代理 UI，但不能扩写为子代理实例监控模型。

### 1.3.4 dfd-interface

#### 实时主/子代理（当前基本正确）

```text
Lifecycle.resolveTools
  → prepareTurn({
      sessionId,
      contextScopeId?,
      agentName,
      tools
    })
  → assemble(scope-aware)
  → measureContext(messages + tools)
  → reduce / prune / automatic compact / remeasure
  → provider send(messages + same outbound tools)
  → provider prompt_tokens / sentHeuristic
  → updateCalibrationFactor(sessionId, contextScopeId)
```

`prepareTurn` 的初次、prune 后和 compact 后重测均已透传 tools（`context-manager.ts:1312-1390`）。4.1 应保护这条链，而不是重写自动压缩。

#### 主代理静态查询（当前缺 tools）

```text
getContextWindowUsageInternal
  → tracker.get(sessionId)
  → miss: runtime.getContextUsage
  → composition.assemble(sessionId, projectRoot)
  → contextManager.getUsage(assembled, model) // no tools
```

静态入口只有 sessionId，适合 primary session。对 child session 继续执行会聚合 sibling scopes，因此必须在 UI/API adapter 截止。

#### 主代理手动 compact（当前漏 tools 且 tracker stale）

```text
assertCanUseAsPrimarySession
  → runtime.compactSession
  → contextManager.compact
  → measureContext(no tools)
  → CompactResult.usageAfter
  → return                              // tracker 未更新
```

#### `/status`（当前双源）

```text
handleStatus
  ├─ getContextUsage       → context
  └─ getContextWindowUsage → contextWindow
```

TUI 只消费 `contextWindow`。旧 `context` 没有继续存在的生产理由，也不能从 `UiContextWindowUsage` 无损恢复完整 `ContextUsage`。

### 1.3.5 use-case

| 用例 | 当前行为 | 正确目标 |
|------|----------|----------|
| 主代理 run 后查看占用 | tracker 来自 `context:prepared`，含 tools | 保持 |
| 主代理冷启动 `/status` | 静态 messages-only | 含完整 tools 的 primary static measurement |
| 主代理手动 `/compact` | 决策漏 tools；完成后 tracker stale | 全程同一 tools；`usageAfter` 刷新 tracker/event |
| 子代理自动压缩 | 实时按 scope 组装/计量 | 保持并补回归测试 |
| 查询 child session context window | tracker/session 聚合语义不可靠 | 返回 null/不可用，不进入 status/UI |
| 主代理读取子代理结果 | 只回传最终摘要 | 保持；与占用 UI 无关 |

### 1.3.6 non-functional

| 属性 | 判断 |
|------|------|
| 正确性 | 最高风险是 schema 漏计、scope identity 丢失与 compact 后旧缓存 |
| 延迟 | 静态/手动路径解析一次工具定义，并同时派生 names/schemas；不新增 MCP 握手 |
| 可维护性 | measurement payload 命名必须与 transport request 区分；否则形成错误抽象 |
| 可观测性 | 4.1 只保证已有主代理总量一致，不新增 breakdown |
| 安全/权限 | 客户端不得传 `isSubagent`、`agentName` 或 scope 来伪造身份 |
| 回滚 | 全部为进程内 TypeScript 与文档，无存储迁移；各阶段可独立 revert |

### 1.3.7 test

现有优势：

- `estimateWireHeuristic` 已有 tools 有/无用例。
- `prepareTurn` 已覆盖 tools 参与 `sentHeuristic`。
- scoped calibration 已有不同 `contextScopeId` 的隔离测试。
- Lifecycle 已覆盖非最终 step 先解析 tools 再 prepare。

真实缺口：

- static `getUsage` / manual `compact` 没有 schemas 用例。
- 最终 step 当前断言“不调用 resolveTools”，与新的 prompt push 数据流冲突。
- `/status` 测试把 `context + contextWindow` 双字段写成合同。
- `compactSessionInternal` 没有“usageAfter 更新 tracker/event”的合同测试。
- 没有“child session 不提供静态/UI context window”的测试。
- 没有把“子代理 scope measurement 继续驱动自动压缩”作为 4.1 回归门。

项目没有独立 `test-blueprint.md`；本批沿用现有 Vitest co-located unit/contract 与 `tests/integration/` 约定。

---

## 1.4 相邻模块截面

### system-prompt

`SystemPromptProvider` 应只消费显式 `toolNames`。删除 `toolsProvider` 是依赖方向修正，不改变 prompt 文案。

### lifecycle

当前最终 step 先清空 schemas 再决定是否解析。目标时序应变为：

```text
resolvedTools = resolveTools(...)
toolNames = names(resolvedTools)
requestTools = isFinalStep ? [] : resolvedTools
prepareTurn(toolNames, requestTools)
send(requestTools)
```

这保持“最终 step 不允许工具调用”，同时保持今天 prompt 仍能看到工具名的行为。

### composition

静态/手动 primary 路径在这里解析 tools，因为 composition 已拥有 scheduler、MCP menu、agent 和 ContextManager。ContextManager 不应反向依赖 registry。

### commands / ui-inprocess

- commands 删除 `getContextUsage` option 与 status `context` 字段。
- ui-inprocess 在静态查询前确认 primary session。
- manual compact 用 `usageAfter` 更新 tracker，并发布已有事件。

---

## 1.5 跨模块与既有文档一致性

| 既有决策 | 4.1 处理 |
|----------|----------|
| improve-3 D11 单一计量入口 | 保持；扩大 measurement 输入 |
| improve-4 实时 tools-aware | 保持；只补 static/manual 与 final-step names 数据流 |
| tools 不进入 `AssembledContext` | 保持 |
| 子代理 scope 隔离 | 以实时链路为权威；静态/UI 不伪造 scope |
| improve-5 = cache | 保持独立；不再要求它先于第一次压缩审查 |
| UI 展示后置 | 保持；未来只展示主代理 |

旧 4.1 文档中以下结论已被本轮复审 supersede：

- “Session.isSubagent + agentName 足以静态测量任意 agent”
- “不传 contextScopeId 时统计 child session 全量是可接受的”
- “子代理静态查询细化留给 UI 批次”
- “improve-5 必须先于第一次压缩检查”

---

## 1.6 改动影响面

| 区域 | 预计改动 | 明确不动 |
|------|----------|----------|
| `core/context` | measurement payload、getUsage/compact tools、assemble options、回归测试 | token algorithm、factor formula、threshold、策略 |
| `core/system-prompt` | build 输入 toolNames、删除 toolsProvider | prompt 内容结构 |
| `core/lifecycle` | final step 仍解析 names；透传 names/schemas | 自动压缩算法 |
| `adapters/ui-runtime` | primary static/manual resolve tools | provider transport、公开协议 |
| `adapters/ui-inprocess` | primary-only query；compact 后 tracker/event | 新 UI、scope tracker |
| `commands` | 删除 status `context` 与 getContextUsage option | `contextWindow` 形状 |
| SDK / HTTP | 不新增字段；child query 返回 nullable unavailable | breakdown/cache/scope 参数 |
| 文档 | architecture/goals-duty 的计量边界说明 | improve-5 详细设计 |

---

## 1.7 SWE 原则审视摘要

| 透镜 | 结论 |
|------|------|
| 本质/偶然复杂度 | per-step tools 与 per-subagent scope 是本质复杂度；用 Session 猜 scope、另造 transport request 类型是偶然复杂度 |
| 高内聚/低耦合 | tool registry 解析留在 composition/Lifecycle；ContextManager 只接受数据 |
| 信息隐藏 | tracker 是主代理 UI projection，不暴露为通用 subagent runtime store |
| KISS/YAGNI | 4.1 不扩 HTTP identity、不做 scope-aware UI tracker、不重构 provider request |
| DRY | 单一的是 measurement payload 和算法，不强行统一“主代理展示”与“子代理内部保护”两种产品需求 |
| 最小惊讶 | `/status` 不再输出两个不同含义的占用；compact 后展示随结果更新 |
| 测试作为设计探针 | final-step 和 shared child-session 用例用于验证接口是否表达真实数据流，而非只测实现细节 |

---

## 1.8 承重问题到方案的映射

| ID | 问题 | 02 去向 | 04 验收 |
|----|------|---------|---------|
| P1 | static/manual 漏 tools | Phase 1 | TC-1/2/8/9 |
| P2 | prompt 主动拉 registry | Phase 1 | TC-3 |
| P3 | final step 不解析 names | Phase 1 | TC-4/5 |
| P4 | child session 无法静态恢复 scope | Phase 2 | TC-10/11 |
| P5 | status 双数据源 | Phase 3 | TC-12/13 |
| P6 | compact 后 tracker stale | Phase 3 | TC-14/15 |
| P7 | runtime subagent auto compression 需保护 | 全阶段回归 | TC-6/7 |
| P8 | cache/压缩策略/UI 越界风险 | 边界守卫 | TC-16 + 审查 |
