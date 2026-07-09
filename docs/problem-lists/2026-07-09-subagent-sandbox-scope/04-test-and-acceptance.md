# 4. 验收与测试标准

## 4.1 测试原则

本轮测试围绕职责与交互边界，不围绕内部类名。

重点验证：

- sandbox context key 与 run/context scope 对齐。
- run 完成只 release 当前 run lease，不销毁 sibling scope。
- workdir 由 RunManager 的 run options 驱动，不回退到 fallback cwd。
- primary 路径兼容：无 `contextScopeId` 时 scope key 退化为 `sessionId`。

本项目当前使用 TypeScript + Vitest。模块级测试遵循已有 co-located 单元测试、跨模块 integration/e2e 的风格。

## 4.2 验收标准

### AC-1 scope-keyed sandbox context

同一个 `sessionId` 下，两个不同 `contextScopeId` acquire sandbox 时：

- 生成两个不同 `SandboxContext.contextId` 或至少两个不同 `scopeKey`。
- 两个 context 可以有不同 `workdir`。
- release A 不影响 B 的 `leaseCount`。
- destroy A scope 不影响 B scope。

### AC-2 primary 兼容

没有 `contextScopeId` 的 primary run：

- sandbox scope key 等于 `sessionId`。
- 现有 primary startSession 能正确使用 `projectRoot` 作为 workdir。
- stream 模式仍能收到 run events。

### AC-3 RunManager 是 run sandbox lease owner

`RunManager.startRun()`：

- 使用 `{ sessionId, contextScopeId?, workdir: options.directory }` acquire sandbox。
- 将 lease 传给 `RunWorker` / lifecycle。
- `finalizeRun()` release 该 lease。

`runAgent()`：

- 不调用 `setSessionEnvironment()`。
- 不在 finally/catch 中销毁 sandbox。

### AC-4 双 subagent 并发不互拆 sandbox

场景：

1. parent session 创建两个 foreground subagent。
2. 二者共享同一个 child session，分别拥有不同 `contextScopeId`。
3. subagent A 快速完成，subagent B 延迟完成。

验收：

- A 完成后，只 release A 的 sandbox lease。
- B 的 sandbox context 仍 active。
- B 后续工具调用仍能 resolve path / command context。
- 最终 A/B 均完成或按预期返回，不出现 sandbox missing/destroyed 错误。

### AC-5 workdir 不回归

删除 `runAgent.setSessionEnvironment()` 后：

- primary run workdir 仍等于 `projectRoot`。
- subagent run workdir 仍等于 child session projectRoot。
- 当两个 scoped run 使用不同 workdir 时，二者互不覆盖。

### AC-6 session-level destroy 只用于 session cleanup

单个 run completion 不应触发 `destroyContext(sessionId)`。

允许触发 session/scope destroy 的场景：

- 显式 session reset / close。
- 显式 subagent close 后销毁该 subagent scope。
- host 生命周期退出时统一 cleanup。

本轮如果暂不实现完整 cleanup，也必须确保没有 per-run destroy。

## 4.3 单元测试矩阵

| 测试文件 | 新增/调整场景 |
|---|---|
| `packages/ohbaby-agent/src/sandbox/manager.unit.test.ts` | `acquire({ sessionId, contextScopeId })` 使用 scope key；同 session 不同 scope 相互独立；destroy scope 不影响 sibling |
| `packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.unit.test.ts` | scope-aware acquire 按传入 workdir ensure；primary 无 scope 时兼容；不同 scope 不同 workdir 并存 |
| `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts` | startRun 传递 `contextScopeId` 与 `directory` 给 sandbox acquire；finalize release 正确 lease |
| `packages/ohbaby-agent/src/core/agents/runner.unit.test.ts` | `runAgent` 不再调用 sandbox setter/cleanup；仍正确 create run 和提取输出 |

## 4.4 集成测试矩阵

| 测试文件 | 新增/调整场景 |
|---|---|
| `packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts` | 双 foreground subagent 并发，A 先完成后 B 继续执行工具并成功 |
| `packages/ohbaby-agent/src/core/agents/instance.integration.test.ts` | AC-6 长任务继续保留，并确认 scoped sandbox lease 在每个 run 中可用 |
| `packages/ohbaby-agent/src/adapters/ui-runtime/ui-persistent.integration.test.ts` | 如使用真实 SQLite/store，验证 scoped context 不串消息、不串 sandbox workdir |

## 4.5 建议新增 fake / helper

为了避免 e2e 假 LLM 太快盖住竞态，建议新增：

- `BlockingLifecycle`：让 subagent B 在工具调用前/后阻塞。
- `RecordingSandboxManager`：记录 acquire/release/destroy 的 scope key。
- `DestroyDetectingSandboxLease`：如果 sibling context 被 destroy，后续 `resolvePath()` 抛出可断言错误。

关键不是等待真实时间，而是精确控制：

```text
A acquire scope_a
B acquire scope_b
B block
A complete
assert scope_b still active
B continue
assert B succeeds
```

## 4.6 回归命令建议

基础验证：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/sandbox/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.unit.test.ts --passWithNoTests
pnpm exec vitest run packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts packages/ohbaby-agent/src/core/agents/runner.unit.test.ts --passWithNoTests
```

subagent 集成：

```bash
pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts --passWithNoTests
pnpm exec vitest run packages/ohbaby-agent/src/core/agents/instance.integration.test.ts --passWithNoTests
```

全量回归：

```bash
pnpm exec tsc -b --pretty false
pnpm exec eslint packages/ohbaby-agent/src --ext .ts,.tsx
pnpm exec vitest run packages/ohbaby-agent/src --passWithNoTests
```

## 4.7 合并门槛

P0 必须满足：

- AC-1～AC-5 自动化测试存在且通过。
- `runAgent` 不再有 sandbox setter/cleanup。
- 双 subagent 并发测试可以稳定复现并防住旧问题。
- 文档同步更新 `docs/sandbox/*` 与 `docs/runtime/run-manager/*` 中 session-only 描述。

P1 可紧随：

- 完整 session/scope cleanup API。
- host 生命周期退出时清理所有 active scope。
- container/worktree adapter 下的 scoped resource cleanup 测试。

## 4.8 自检清单

- 每条测试是否来自一个明确职责或数据流？
- 是否覆盖了“同 session 多 scope”的真实产品场景？
- 是否避免只测 fake LLM 快速完成的乐观路径？
- 是否验证 primary 兼容，避免修 subagent 时破坏主路径？
- 是否明确哪些 cleanup 行为是本轮不做的？

