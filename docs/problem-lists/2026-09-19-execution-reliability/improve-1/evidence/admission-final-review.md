# Prompt admission failure 最终独立审查

日期：2026-09-25。审查者：原生独立子代理 `admission_final_review`。分支：`codex/improve-1-implementation`，基线：`81cd4b00`。依用户要求，没有调用 Pi 复审。

## 范围与结论

只读检查 `client-view.ts` 的 `ProvisionalPromptBinding`、`preparePromptSubmit` / `finishAdmission`，`prompt-backend.ts` 的接单与清理顺序，以及 `create-app.ts` 的 REST/RPC `finally` binding 通知。并检查注册、显式选择、权限快照校验和事件发送的相邻代码。此次没有修改生产代码或仓库测试。

在本次范围内未发现新的 P0/P1/P2。最后的接单失败修复可以进入主代理最终验证与提交；这不是对其他未审查模块的保证，也不是 Pi 对最后修复的认可。

## 核对结果

- Fresh 客户端先建立临时 root，避免接单期间同步产生的事件缺少路由。并发请求共享同一个 cohort；首个成功提交该 binding，全部失败才回滚。提交和回滚均增加 generation，不重新使用临时身份。
- 一个失败请求先完成、另一个尚未接单完成时，REST/RPC 不发送提前确认临时 root 的 hello；随后成功的请求发送可查询的正式 binding。
- `finishAdmission` 对单次调用幂等。首个成功已提交之后，其他请求失败以及 `waitForPrompt` 同步抛错均不会撤销已接单的 root。
- 旧请求完成不能覆盖后来显式选择或有效重新注册的 binding。无效重新注册先校验 root，再清理原 cohort，因此不能破坏仍在进行的接单。
- 已有 root 的显式目标在独立 metadata 校验后选中，即使接单失败也保留该有效选择；`finally` 通知当前 binding，让客户端仍能查询权限。目标验证本身失败不会改动 binding。
- 权限事件在临时阶段使用当前临时 generation；正式提交后 hello 使用新的 generation，独立快照可以恢复接单期间已经产生的待审批请求。这里的事件顺序由代码审读和现有 transport 测试支持；本审查没有另行执行真实 LLM/浏览器流程。

## 独立验证

1. `pnpm exec vitest run packages/ohbaby-server/src/coordination/client-view.unit.test.ts packages/ohbaby-server/src/coordination/prompt-admission.integration.test.ts packages/ohbaby-server/src/app/create-app.unit.test.ts packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts`：**4 文件 / 131 tests 通过**。日志 `/tmp/ohbaby-improve1-admission-final-review.log`。
2. `pnpm exec vitest run packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts packages/ohbaby-server/src/runtime/daemon/client.integration.test.ts`：**2 文件 / 41 tests 通过**。日志 `/tmp/ohbaby-improve1-admission-transport-review.log`。
3. `/tmp/ohbaby-admission-independent.mts` 直接导入当前 `DaemonClientViewCoordinator`，运行 **52 个额外状态场景**：三个并发请求的八种成功/失败组合 × 六种完成顺序，以及显式选择/重新注册后旧请求成功/失败。每一步检查 root、generation、临时状态，并重复以相反结果调用同一 settle 回调来检查幂等性。全部通过。该临时脚本不计入项目测试数量。

没有运行 build、全量测试或 typecheck，以免与主代理正在进行的最终验证竞争输出目录。

## 已审生产文件指纹

| 文件                                                        | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/ohbaby-server/src/coordination/client-view.ts`    | `93c5e6c75e53dc26a53040e06a94120fef718892656fe0933f17272a56c34cd8` |
| `packages/ohbaby-server/src/coordination/prompt-backend.ts` | `f8f8055c503586f82e058a47a2664bccbb9efc68f492ba6bd06ee5d4a42a34ae` |
| `packages/ohbaby-server/src/app/create-app.ts`              | `cfb8c576995a812be56c8b37282cc8e331daa483f958680c42ef10a68cd8c1d7` |
