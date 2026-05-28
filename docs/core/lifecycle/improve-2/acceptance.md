# lifecycle improve-2 验收标准

本文档定义 lifecycle improve-2 的验收标准。所有通过结论必须基于命令输出、代码 diff 和必要的子代理复审。

---

## AC-0 文档对齐

**判定**：

- README 明确 agents improve-2 已完成，不再规划 primary 切到 `runAgent`。
- problem-analysis 明确列出仍存在的问题：per-step prepare、overflow recovery、dynamic budget、legacy run 双路径。
- implementation-plan 分阶段，且 P0 不依赖大规模 legacy 重构。
- acceptance 给出可执行测试命令。

---

## AC-1 Per-step prepare/compact

**判定**：

- `Lifecycle.runSession` 不再只在 `conversationMessages` undefined 时调用 `prepareTurn`。
- 多 tool step 场景中，后续 LLM step 前可重新准备 provider messages。
- 如果后续 step 触发 compaction，RunWorker/stream adapter 能发布对应 context notice。
- tool protocol 不回归：assistant `tool_calls` 后紧跟 matching `tool` messages。

**建议 grep**：

```powershell
rg -n "if \\(!conversationMessages\\)" packages\ohbaby-agent\src\core\lifecycle\lifecycle.ts
```

该 grep 不应再是 per-step prepare 的唯一入口。

---

## AC-2 Overflow recovery

**判定**：

- 存在 provider-neutral 的 overflow error 识别函数。
- `runSession` 捕获 overflow 后强制 `prepareTurn({ force: true })`。
- 同一 step 最多重试一次。
- 非 overflow 错误不触发 compaction retry。
- 重试失败时错误可读，且 run status 正确进入 failed/cancelled。

---

## AC-3 Dynamic completion budget

**判定**：

- `streamChatCompletion` options 或 provider adapter 支持动态输出预算。
- 预算来自当前 context usage，而不是写死常量。
- provider 不支持时有降级，不影响已有测试。
- 小预算有下限保护。

---

## AC-4 Legacy run 双路径收敛

**判定**：

- 新功能只加到 `runSession`。
- `run()` 被明确标记为 legacy，或调用点被迁移到 session-run。
- 如果保留 `run()`，测试说明它只是 message-run 兼容入口。
- 不再出现"为了兼容旧路径而复制一份新功能"。

---

## AC-5 Runtime/adapter 回归

**判定**：

- `RunWorker` agent path 继续走 `runSession`。
- legacy `messages` path 行为保持，除非本阶段明确删除并更新调用点。
- UI stream 中 `turn:start / turn:end / step:complete / context notice` 顺序可解释。
- `AgentService.startSession` 和 `executeTask` 不需要新增 lifecycle-specific workaround。

---

## AC-6 测试命令

每个实现 PR 至少运行：

```powershell
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages\ohbaby-agent\src\core\lifecycle\lifecycle.unit.test.ts packages\ohbaby-agent\src\core\context\manager.unit.test.ts --testTimeout=300000
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

## AC-7 子代理复审标准

至少分两类复审：

- 架构复审：确认 lifecycle / context / runtime 边界没有反向依赖，P0 没有塞入 hooks/RAG/branch 等过度设计。
- 数据流复审：确认长 tool 链、overflow retry、context notice、tool protocol 顺序与真实测试证据一致。
