# lifecycle improve-2 实施计划

本文档规划 `core/lifecycle` 的分批实施路径。首批目标是长 tool 链正确性，不在同一批里做大规模 legacy 清理。

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

**目标**：先锁定现有行为，避免 per-step 改造破坏 tool protocol。

**测试文件**：

- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

**新增测试方向**：

1. session-run 第一步 `prepareTurn` 的 provider messages 包含 user prompt。
2. tool call 后第二次 LLM 请求包含 assistant `tool_calls` 与对应 tool result。
3. 如果第二步前重新 prepare，OpenAI tool protocol 仍然合法。
4. 普通无 tool prompt 只产生一次 assistant response。

---

## Phase 2：Per-step prepare/compact

**目标**：`runSession` 每次 LLM step 前都能重新进入 context 管理。

**建议实现**：

1. 将当前 `if (!conversationMessages) prepareTurn(...)` 改为 step 前 preparation 函数。
2. 第一次 step 使用普通 `prepareTurn`。
3. 后续 step 默认也调用 `prepareTurn`，但保留是否发出 `turn:start` 的明确规则。
4. 若 `prepareTurn` 返回 compaction，RunWorker/stream adapter 应能继续发布 context notice。
5. 每次准备后用 `PreparedTurn.messages` 替换 `conversationMessages`，再进入 `runModelStep`。

**设计说明**：

- 首批不新增复杂 pressure probe，先复用 `prepareTurn` 的完整契约。
- 性能优化后置：如果每步 prepare 成本过高，再加窄 API 做 message usage 检查。

---

## Phase 3：Overflow recovery

**目标**：context overflow 自动强制压缩并重试一次。

**建议实现**：

1. 在 llm-client/provider 层新增 `isContextOverflowError(error)`。
2. `runSession` 包裹 `runModelStep`，捕获 overflow。
3. 捕获后调用 `contextManager.prepareTurn({ force: true, ... })`。
4. 用新的 `PreparedTurn.messages` 重试当前 step。
5. 同一 step 只重试一次。

**失败语义**：

- 非 overflow 错误保持原行为。
- 重试后仍 overflow：run failed，错误消息明确说明已尝试强制压缩。

---

## Phase 4：Dynamic completion budget

**目标**：降低 overflow 发生概率。

**建议实现**：

1. `PreparedTurn.usage` 或本 step message usage 计算出可用输出预算。
2. 扩展 `streamChatCompletion` options，支持 `maxOutputTokens` 或 provider-neutral 字段。
3. provider adapter 映射到真实 API 参数。
4. 设置最小输出预算下限。

---

## Phase 5：Legacy run 收敛

**目标**：减少 `run()` 与 `runSession()` 的双路径重复。

**可选路线**：

- 路线 A：`run()` 标记为 legacy，仅保留 message-run 兼容测试，不再新增能力。
- 路线 B：抽取共享 `runToolLoop`，`run()` 与 `runSession()` 只负责准备 provider messages。
- 路线 C：删除 `messages` run path，让所有调用方都先写入 session message，再走 `runSession`。

**推荐**：先 A，等调用点清零后再 C。B 只有在 legacy path 必须长期保留时才值得做。

---

## 建议提交拆分

| 提交 | 内容 |
|------|------|
| 1 | 文档对齐 |
| 2 | Characterization tests |
| 3 | Per-step prepare/compact |
| 4 | Overflow recovery |
| 5 | Dynamic completion budget |
| 6 | Legacy run 收敛 |

---

## 必跑验证

```powershell
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages\ohbaby-agent\src\core\lifecycle\lifecycle.unit.test.ts packages\ohbaby-agent\src\core\context\manager.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages\ohbaby-agent\src\runtime\run-manager\manager.unit.test.ts packages\ohbaby-agent\src\adapters\ui-inprocess.contract.test.ts --testTimeout=300000
```

实现完成后再运行完整 `pnpm test` 与真实 provider smoke。
