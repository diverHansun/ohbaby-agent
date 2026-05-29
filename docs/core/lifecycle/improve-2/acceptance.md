# lifecycle improve-2 验收标准

本文档定义 lifecycle improve-2 的验收标准。所有通过结论必须基于命令输出、代码 diff 和必要的子代理复审。

---

## AC-0 文档对齐

**判定**：

- README 明确 agents improve-2 已完成，不再规划 primary 切到 `runAgent`。
- problem-analysis 明确区分实施前问题、当前已完成项和仍后续推进项（dynamic budget）。
- implementation-plan 分阶段，且 P0 后用独立 commit 删除 legacy `run(messages)`。
- acceptance 给出可执行测试命令。

---

## AC-1 Per-step prepare/compact

**判定**：

- session-based `Lifecycle.run(params: LifecycleSessionParams)` 不再只在第一步调用 `prepareTurn`。
- 多 tool step 场景中，后续 LLM step 前可重新准备 provider messages。
- 如果后续 step 触发 compaction，RunWorker/stream adapter 能发布对应 context notice。
- tool protocol 不回归：assistant `tool_calls` 后紧跟 matching `tool` messages。
- 每个 LLM step 前都发出 `context:prepared`；`turn:start` 与 `turn:end` 每个 turn 各一次。
- provider messages 的生产来源是 message store + `ContextManager.prepareTurn`，不是本地 `conversationMessages.push(...)` fallback。

**建议 grep**：

```powershell
rg -n "if \\(!conversationMessages\\)" packages\ohbaby-agent\src\core\lifecycle\lifecycle.ts
```

该 grep 不应再是 per-step prepare 的唯一入口。

---

## AC-2 Tool metadata 持久化与白名单投影

**判定**：

- `ToolState.completed/error/aborted` 能持久化 raw `metadata`，旧消息无 metadata 时兼容。
- `resultToToolState(...)` 不丢弃 `ToolCallResult.metadata`。
- `serializeForLlm` 通过中央白名单投影模型可见 metadata，不直接透传 raw metadata。
- `read -> edit/write` 经过 DB round-trip 后，模型输入仍包含 `mtimeMs`。
- `bash false` 或无输出失败命令经过 DB round-trip 后，模型输入仍包含 `exitCode`。
- MCP tool result 经过 DB round-trip 后，模型输入仍包含 `structuredContent`。
- permission/preflight、pid、resolvedPaths、完整 diff、todos 等 raw/internal 字段不进入模型上下文，除非 output 本身明确展示。

**建议测试**：

```powershell
pnpm exec vitest run packages\ohbaby-agent\src\core\context\manager.unit.test.ts packages\ohbaby-agent\src\mcp\__tests__\tool-adapter.unit.test.ts packages\ohbaby-agent\src\tools\files.scheduler.integration.test.ts --testTimeout=300000
```

> 路径确认：`packages\ohbaby-agent\src\mcp\__tests__\tool-adapter.unit.test.ts` 与 `packages\ohbaby-agent\src\tools\files.scheduler.integration.test.ts` 当前已存在；Phase 1 是在现有文件中补 characterization cases，而不是新建占位测试。

---

## AC-3 Overflow recovery

**判定**：

- 存在 provider-neutral 的 overflow error 识别函数。
- session-based `Lifecycle.run(...)` 捕获 overflow 后强制 `prepareTurn({ force: true })`。
- 同一 step 最多重试一次。
- 非 overflow 错误不触发 compaction retry。
- 重试失败时错误可读，且 run status 正确进入 failed/cancelled。
- 发生 overflow 的 assistant message 被标记为 error 并保留审计记录。
- 失败 assistant message 不进入下一次 LLM 输入。

---

## AC-4 Legacy run 双路径收敛

**判定**：

- session-based `Lifecycle.run(params: LifecycleSessionParams, config?)` 是新的唯一生产入口。
- 旧 `Lifecycle.run(messages)` 与 `LifecycleRunParams.messages` 被删除。
- `RunWorker` 不再通过 `context.messages` 选择 legacy/session 模式。
- 测试 fixture 通过写入 session message + session params 启动 run，不再预组装 provider messages。
- 不保留独立 `runSession` tool loop；如未来需要兼容 alias，只能转发到 session-based `run(...)`。

**建议 grep**：

```powershell
rg -n "LifecycleRunParams|messages\\?: readonly ChatCompletionMessage|params\\.messages|context\\.messages|lifecycle\\.runSession|lifecycle\\.run\\(.*messages" packages\ohbaby-agent\src tests
```

---

## AC-5 Dynamic completion budget（后续阶段）

当前分支不宣称完成 dynamic completion budget。该 AC 保留为后续阶段验收口径，不能作为 P0/P1 已通过项。

**后续判定**：

- `streamChatCompletion` options 或 provider adapter 支持动态输出预算。
- 预算来自当前 context usage，而不是写死常量。
- provider 不支持时有降级，不影响已有测试。
- 小预算有下限保护。

---

## AC-6 Runtime/adapter 回归

**判定**：

- `RunWorker` agent path 走 session-based lifecycle `run`。
- UI stream 中 `turn:start / context:prepared / step:complete / turn:end / context notice` 顺序可解释。
- `AgentService.startSession` 和 `executeTask` 不需要新增 lifecycle-specific workaround。

---

## AC-7 测试命令

每个实现 PR 至少运行：

```powershell
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages\ohbaby-agent\src\core\lifecycle\lifecycle.unit.test.ts packages\ohbaby-agent\src\core\context\manager.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages\ohbaby-agent\src\mcp\__tests__\tool-adapter.unit.test.ts packages\ohbaby-agent\src\tools\files.scheduler.integration.test.ts --testTimeout=300000
```

影响 runtime/adapter 时追加：

```powershell
pnpm exec vitest run packages\ohbaby-agent\src\runtime\run-manager\manager.unit.test.ts packages\ohbaby-agent\src\adapters\ui-inprocess.contract.test.ts --testTimeout=300000
```

合并前运行：

```powershell
pnpm test
```

真实 provider e2e 在实现完成后运行，不能提交 API key。

---

## AC-8 子代理复审标准

至少分两类复审：

- 架构复审：确认 lifecycle / context / runtime 边界没有反向依赖，P0 没有塞入 hooks/RAG/branch 等过度设计。
- 数据流复审：确认长 tool 链、overflow retry、context notice、tool protocol、tool metadata 白名单投影与真实测试证据一致。
