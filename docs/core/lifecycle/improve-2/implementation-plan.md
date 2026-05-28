# lifecycle improve-2 实施计划

本文档规划 `core/lifecycle` 的分批实施路径。首批目标是长 tool 链正确性；P0 稳定后紧接着用独立 commit 收敛 legacy `run(messages)` 路径。

---

## Phase 0：文档与现状对齐

**目标**：提交本目录文档，明确 agents improve-2 已完成，lifecycle improve-2 聚焦 session-run 内部韧性。

**文件**：

- `docs/core/lifecycle/improve-2/README.md`
- `docs/core/lifecycle/improve-2/problem-analysis.md`
- `docs/core/lifecycle/improve-2/implementation-plan.md`
- `docs/core/lifecycle/improve-2/acceptance.md`

---

## Phase 1：Characterization tests

**目标**：先锁定现有行为，避免 per-step 改造破坏 tool protocol、message-store source of truth 和工具 metadata 传递。

**测试文件**：

- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

**新增测试方向**：

1. session-run 第一步 `prepareTurn` 的 provider messages 包含 user prompt。
2. tool call 后第二次 LLM 请求包含 assistant `tool_calls` 与对应 tool result。
3. 如果第二步前重新 prepare，OpenAI tool protocol 仍然合法。
4. 普通无 tool prompt 只产生一次 assistant response。
5. `read -> edit/write` 经过 message store round-trip 后，第二步模型输入仍包含白名单投影的 `mtimeMs`。
6. `bash false` 或无输出失败命令经过 message store round-trip 后，第二步模型输入仍包含 `exitCode`。
7. MCP tool result 的 `structuredContent` 经过 message store round-trip 后，第二步模型输入仍可见。

---

## Phase 2：Tool raw metadata 持久化与白名单投影

**目标**：让 message store 成为 tool result 的唯一生产事实源，而不是依赖当前 step 内存里的 `ToolCallResult.metadata`。

**建议实现**：

1. 扩展 `ToolState.completed/error/aborted`，允许持久化 raw `metadata?: Record<string, unknown>`。
2. `resultToToolState(...)` 写入 raw metadata；error/cancelled 也保留可审计 metadata。
3. `MessageManager` / database-store / event schema 保持向后兼容：旧 tool state 没有 metadata 时正常读取。
4. `serializeForLlm` 不直接透传 raw metadata，而是调用中央白名单投影函数。
5. 白名单首批只包含模型继续工作必需字段：`mtimeMs`、`exitCode`、`truncated`、MCP `structuredContent`、task/subagent `sessionId/success` 等。

**设计说明**：

- raw metadata 是审计和恢复事实；白名单投影是模型上下文事实。两者分层，避免把 permission/preflight/pid/diff 等内部字段污染 prompt。
- 这个阶段虽然会触及 `core/message` 与 `core/context/serializer.ts`，但它是 lifecycle P0 的必要协作点；分支按目标切分，不按目录机械切分。

---

## Phase 3：Per-step prepare/compact

**目标**：`runSession` 每次 LLM step 前都能重新进入 context 管理。

**建议实现**：

1. 将当前 `if (!conversationMessages) prepareTurn(...)` 改为 step 前 preparation 函数。
2. 第一次 step 使用普通 `prepareTurn`。
3. 后续 step 默认也调用 `prepareTurn`。
4. 若 `prepareTurn` 返回 compaction，RunWorker/stream adapter 应能继续发布 context notice。
5. 每次准备后用 `PreparedTurn.messages` 替换 `conversationMessages`，再进入 `runModelStep`。
6. 每次准备后发出 `context:prepared` 事件；`turn:start` 只在本 turn 开始时发出一次。

**设计说明**：

- 首批不新增复杂 pressure probe，先复用 `prepareTurn` 的完整契约。
- 性能优化后置：如果每步 prepare 成本过高，再加窄 API 做 message usage 检查。
- 生产路径不保留 `conversationMessages.push(toolResultToMessage(...))` 作为下一步输入来源；下一步输入必须来自 message store 重建。

---

## Phase 4：Overflow recovery

**目标**：context overflow 自动强制压缩并重试一次。

**建议实现**：

1. 在 llm-client/provider 层新增 `isContextOverflowError(error)`。
2. `runSession` 包裹 `runModelStep`，捕获 overflow。
3. 捕获后调用 `contextManager.prepareTurn({ force: true, ... })`。
4. 用新的 `PreparedTurn.messages` 重试当前 step。
5. 同一 step 只重试一次。

**失败语义**：

- 非 overflow 错误保持原行为。
- 发生 overflow 的 assistant message 标记为 error 并保留在 message store；`serializeForLlm` 必须过滤失败 assistant，不把失败内容再次喂给模型。
- 重试后仍 overflow：run failed，错误消息明确说明已尝试强制压缩。

---

## Phase 5：Legacy run 收敛

**目标**：删除旧 `Lifecycle.run(messages)` 路径，建立唯一 session-based lifecycle 入口。

**最终接口**：

```ts
async *run(
  params: LifecycleSessionParams,
  config: LifecycleConfig = {},
): AsyncGenerator<LifecycleEvent, LifecycleResult, void>
```

**建议实现**：

1. 将现有 `runSession(...)` 语义迁移到新的 `run(...)`。
2. 删除旧 `LifecycleRunParams.messages` 和旧 `run(messages)` tool loop。
3. `RunWorker` 不再通过 `context.messages` 选择 legacy/session 模式；所有生产 run 都必须有 `sessionId/directory/modelId` 并走 session message store。
4. 更新 runtime/daemon/bootstrap 与相关单测，测试 fixture 先写 session message，再启动 run。
5. 对外如必须短暂兼容，可保留 `runSession(...)` 作为 deprecated alias，但不允许保留旧 message-run 行为。

**设计说明**：

- 这是 P0 后的独立 commit，便于回滚和审查。
- 不抽取复杂 `runToolLoop`。KISS：先删除已经不应作为生产来源的旧路径，避免双循环继续分叉。
- 删除优先于重构：agents improve-2 已让 primary 与 task/subagent 生产路径都进入 session-run，legacy `run(messages)` 已不再承担生产主路径；对 dead code 做 `runToolLoop` 抽象只会延长双路径寿命。

---

## Phase 6：Dynamic completion budget

**目标**：降低 overflow 发生概率。

**建议实现**：

1. `PreparedTurn.usage` 或本 step message usage 计算出可用输出预算。
2. 扩展 `streamChatCompletion` options，支持 `maxOutputTokens` 或 provider-neutral 字段。
3. provider adapter 映射到真实 API 参数。
4. 设置最小输出预算下限。

---

## 建议提交拆分

| 提交 | 内容 |
|------|------|
| 1 | 文档对齐 |
| 2 | Characterization tests：tool protocol + metadata round-trip + per-step prepare |
| 3 | Tool raw metadata 持久化 + serializer 白名单投影 |
| 4 | Per-step prepare/compact + `context:prepared` 事件 |
| 5 | Overflow recovery + 失败 assistant 过滤 |
| 6 | 删除 legacy `Lifecycle.run(messages)`，切到 session-based `Lifecycle.run` |
| 7 | Dynamic completion budget |

---

## 必跑验证

```powershell
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages\ohbaby-agent\src\core\lifecycle\lifecycle.unit.test.ts packages\ohbaby-agent\src\core\context\manager.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages\ohbaby-agent\src\runtime\run-manager\manager.unit.test.ts packages\ohbaby-agent\src\adapters\ui-inprocess.contract.test.ts --testTimeout=300000
pnpm exec vitest run packages\ohbaby-agent\src\mcp\__tests__\tool-adapter.unit.test.ts packages\ohbaby-agent\src\tools\files.scheduler.integration.test.ts --testTimeout=300000
```

实现完成后再运行完整 `pnpm test` 与真实 provider smoke。
