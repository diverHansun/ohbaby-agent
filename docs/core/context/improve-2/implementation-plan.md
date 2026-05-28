# context improve-2 实施计划

> **实施边界**：本文档只规划 `core/context` 与其必要协作点，不直接重构 agents。agents improve-2 已完成，后续开发从 `Lifecycle.runSession` 的 context 压力点切入。

---

## 一、当前代码锚点

| 文件 | 现状 | 本轮用途 |
|------|------|---------|
| `packages/ohbaby-agent/src/core/context/context-manager.ts` | `prepareTurn` 已完成 assemble → prune/compress → serialize；可被重复调用 | per-step 压缩的核心复用点 |
| `packages/ohbaby-agent/src/core/context/types.ts` | `PrepareTurnInput` 已支持 `force`；`PreparedTurn` 返回 `messages / usage / compaction` | 保持现有 API，必要时只做向后兼容扩展 |
| `packages/ohbaby-agent/src/core/context/serializer.ts` | provider message 投影硬编码为 system + memory + history；tool result 只读取 output/error | P0 metadata 白名单投影；P2 注入系统入口 |
| `packages/ohbaby-agent/src/core/message/types.ts` | `PartMetadata` 已有 `[key: string]: unknown`，但 `ToolState.completed/error` 未持久化 raw metadata | P0 tool metadata source-of-truth 修复；origin 字段优先落在 metadata/info 扩展，不破坏 schema |
| `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts` | `runSession` 只在第一 step 调用一次 `prepareTurn` | P0 协作点 |

---

## 二、阶段划分

### Phase 0：文档与测试基线

**目标**：先把规划与当前代码事实对齐，不写生产代码。

**产物**：

- 本目录 `README.md / problem-analysis.md / implementation-plan.md / acceptance.md` 齐备。
- lifecycle improve-2 文档明确：agent primary 路径已切到 `runAgent`，本轮不重复规划。
- 明确首批开发只做 P0：tool metadata 持久化与白名单投影、per-step context 准备、overflow recovery。

### Phase 1：Tool metadata 持久化与中央白名单投影

**原则**：raw metadata 全量持久化，模型上下文只看白名单投影。

**推荐实现方向**：

1. `ToolState.completed/error/aborted` 新增可选 `metadata?: Record<string, unknown>`。
2. lifecycle 写 tool part 时保存 raw `ToolCallResult.metadata`。
3. `serializeForLlm` 增加相邻 helper，例如 `projectToolMetadataForModel(tool, metadata)`。
4. tool result content 追加稳定 `<tool_metadata>{...}</tool_metadata>` block；空白名单不追加。
5. 白名单以 [tool-metadata-whitelist.md](./tool-metadata-whitelist.md) 为准。

**为什么放在 P0**：

- per-step prepare 会让下一步 provider messages 从 message store 重建。
- 如果 metadata 不落库，`read -> edit/write` 的 `mtimeMs`、`bash.exitCode`、MCP `structuredContent` 会丢失。
- 这是 correctness，不是 UI polish。

### Phase 2：Per-step context 准备的最小正确版本

**原则**：KISS 优先。首批可以在每个 LLM step 前调用 `prepareTurn`，用正确性换取可控的额外读取；确认行为后再优化成压力触发。

**推荐实现方向**：

1. `Lifecycle.runSession` 每次进入 LLM step 前调用 `contextManager.prepareTurn(...)`。
2. 第一次 step 正常触发 `turn:start`。
3. 每次 step 前发出 `context:prepared`；`turn:start` 每个 turn 只发一次。
4. 后续 step 若 `prepareTurn` 产生 `compaction`，继续发出可被 UI 投影的 context notice。
5. 用 `PreparedTurn.messages` 替换 `conversationMessages`，确保压缩后的 provider messages 来自持久化消息投影。
6. 保留现有内存追加 assistant tool-call/tool-result 的协议测试，避免 OpenAI tool protocol 回归；生产下一步输入不能依赖本地数组 fallback。

**为什么不先做复杂压力探针**：

- 当前 P0 风险是溢出，不是性能。
- `prepareTurn` 已是完整契约，重复调用比新增半成品 `estimateMessagesUsage` 更少抽象。
- 如果性能变成真实问题，再在后续阶段增加 `ContextManager.estimateMessagesUsage(...)` 之类窄 API。

### Phase 3：Overflow recovery

**目标**：LLM context overflow 不直接暴露给用户。

**推荐实现方向**：

1. 在 llm-client/provider 层定义窄错误识别函数，例如 `isContextOverflowError(error)`。
2. `Lifecycle.runSession` 捕获 overflow 后调用 `prepareTurn({ force: true, ... })`。
3. 重试当前 model step，最多 1 次，避免无限循环。
4. 若强制压缩后仍 overflow，返回结构化失败，并在 turn end / run status 中记录可读错误。

**不做**：

- 不引入后台压缩 worker。
- 不做跨 provider 的复杂错误枚举表；先覆盖当前 provider 可观察到的 overflow 文案/错误码。

### Phase 4：动态 completion budget

**目标**：LLM 调用时根据当前 input 占用限制输出上限。

**推荐实现方向**：

1. 复用 `tokenCounter.getBudget(modelId, { usedInputTokens })`。
2. 将 `PreparedTurn.usage.reservedOutputTokens / remainingTokens` 映射为 provider 可接受的 `max_tokens` 或等价字段。
3. 在 provider 不支持动态输出上限时降级为 no-op，并记录 warning。
4. 添加预算下限，避免传入过小值导致模型无法正常回答。

### Phase 5：Origin 追踪与文件操作跨压缩累积

**目标**：补足 P1/P2 可观测性和关键状态保留。

**推荐实现方向**：

1. 定义轻量 `PromptOrigin` 类型，不改旧消息读取路径。
2. 优先在新写入的 user / assistant / tool / context-summary part 上写 metadata origin。
3. 压缩摘要继承前序 summary 中的文件操作状态。
4. `serializeForLlm` 与 compaction 逻辑只消费已存在 origin；无 origin 的历史消息按 legacy 处理。

### Phase 6：注入系统与后台通知

**目标**：为计划提醒、后台任务完成通知等 ephemeral 内容提供扩展点。

**推荐实现方向**：

1. 在 `serializeForLlm` 外围新增 injector pipeline，不直接把 injector 塞进 `ContextManager` 主流程。
2. injection 不持久化为 message，除非产品明确需要审计。
3. 后台任务通知先通过 Bus 进入 session-scoped pending queue，再由下一次 `prepareTurn` 投影。

---

## 三、建议提交拆分

| 提交 | 内容 |
|------|------|
| 1 | 文档对齐：README / problem-analysis / implementation-plan / acceptance |
| 2 | Phase 1 characterization tests：tool metadata round-trip + serializer 白名单 |
| 3 | Phase 1 tool metadata 持久化与中央白名单投影 |
| 4 | Phase 2 per-step prepare 最小实现 |
| 5 | Phase 3 overflow recovery |
| 6 | Phase 4 dynamic budget |
| 7 | Phase 5/6 可观测性与扩展点（按风险继续拆） |

---

## 四、测试策略

- 单元测试：`packages/ohbaby-agent/src/core/context/manager.unit.test.ts`
- 生命周期测试：`packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`
- 工具 metadata 回归：`packages/ohbaby-agent/src/mcp/__tests__/tool-adapter.unit.test.ts`、`packages/ohbaby-agent/src/tools/files.scheduler.integration.test.ts`
- runtime/adapter 回归：`packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts`、`packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- 集成链路：`tests/integration/tui/main-chain.integration.test.tsx`
- 真实 provider smoke：只在实现完成后按 `ohbaby-e2e-test.md` 本地配置运行，不提交密钥。

---

## 五、开发护栏

- 不破坏 `ContextManager` 现有公共方法。
- 不让 context 依赖 UI、runtime 或 agents。
- 不在 P0 引入完整事件溯源、hooks、RAG、branch/fork。
- 每个阶段都先写失败测试，再改实现。
- 修改 `PreparedTurn` / `CompressionResult` 时同步检查 `events.ts` 的 Zod schema。
