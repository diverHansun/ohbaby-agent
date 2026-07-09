# 04 · 测试与验收标准（core/agents 视角）

本文定义 `core/agents` 本轮改造的测试项与验收标准。项目已采用 Vitest 与 `*.unit.test.ts` / `*.integration.test.ts` / `*.contract.test.ts` / `*.smoke.test.ts` 分类；本模块测试继续 colocated。

---

## 一、验收标准（AC）

| 编号 | 验收标准 | 验证方式 |
|------|----------|----------|
| AC-1 | `AgentContextScope` 是有行为的对象，能绑定身份并生成 run scope 参数；context/message 范围由 `runAgent` 从该 scope 派生并传递 | 单测 |
| AC-2 | `AgentContextScope` 拒绝不合法身份：sub 无 parent、primary 有 parent、instance/session/context-scope/role/parent 不匹配 | 单测 |
| AC-3 | `AgentInstance.turn({ waitForCompletion })` 与直接 `runAgent({ waitForCompletion })` 行为等价（输出、收口、取消透传一致） | 等价性单测 |
| AC-4 | 同一 subagent `AgentInstance` 连续多轮 `turn()`，instance/context scope 身份稳定，context 在同一 scope 延续 | 多轮单测 |
| AC-5 | `isSubagent/contextScopeId` 由实例身份稳定携带并正确透传至 `RunManager.create` 与 `prepareTurn` | 断言透传 |
| AC-6 | 两段长任务测试：先跑现状 50+ tool step 基线，再跑改造后同场景，验证多次 `prepareTurn` 且不抛 context overflow | 集成测试 |
| AC-7 | `AgentInstance.turn()` 不存在绕过 lifecycle 的直连 LLM 路径 | 代码审查 + 依赖断言 |
| AC-8 | `core/agents` 不 import `src/agents` / `src/adapters` / `src/runtime` 具体实现 | 依赖方向测试/lint |

> primary stream 等价性不作为本轮 AC。`AgentTurnInput.runId` 与 `AgentInstanceType:"primary"` 仅保留为后续迁移的接口预留。

---

## 二、单元测试

### 2.1 `core/agents/context-scope.unit.test.ts`（新增）

- 构造 subagent scope：`type:"sub"`、有 `parentSessionId`，断言 `isSubagent=true`。
- 构造 primary scope：`type:"primary"`、无 `parentSessionId`，断言 `isSubagent=false`。
- 不变量：
  - subagent 缺 `parentSessionId` 抛错；
  - primary 带 `parentSessionId` 抛错；
  - `assertSession` 对 instanceId/contextScopeId/sessionId/parentSessionId/agentName 不匹配抛错。
- 行为：
  - `toRunCreateOptions()` 返回不可被调用方覆盖的身份参数。
  - `runAgent` 使用 `contextScope` 时，initial user message、`RunManager.create`、final message lookup 都使用 scope 派生出的 `sessionId/contextScopeId/isSubagent`。

### 2.2 `core/agents/instance.unit.test.ts`（新增）

- **等价性（AC-3）**：mock `AgentRunDeps`，对同一输入分别走 `AgentInstance.turn(waitForCompletion)` 与 `runAgent(waitForCompletion)`，断言结果结构一致。
- **多轮（AC-4）**：同一实例 `turn()` 两次，断言两轮都写入同一 `sessionId + contextScopeId`、第二轮能看到第一轮历史（通过 mock messageManager 记录调用）。
- **同 session 多 scope 隔离**：两个实例共享同一 `sessionId` 但使用不同 `contextScopeId`，断言 prepare/compact 与 message 查询互不串扰。
- **取消透传**：`signal` abort 时，断言底层 run cancel 被调用。
- **身份透传（AC-5）**：断言 `RunManager.create` 收到的 `isSubagent` 来自实例身份，而不是调用方临时推断。

### 2.3 `core/agents/runner.unit.test.ts`（修改）

- 保留现有用例。
- 新增：显式 `isSubagent` 优先；`parentSessionId` 推断仅兼容旧调用。
- 新增：显式 `isSubagent=false` 但带 `parentSessionId` 的冲突输入应被拒绝或在边界层归一化为错误。

---

## 三、集成测试

### 3.1 `core/agents/instance.integration.test.ts`（新增，AC-6）

AC-6 分两段做，不把“现状一定溢出”写死成前提：

**阶段 A：现状基线**

- 在改造前或保留旧路径夹具中，模拟 50+ tool step。
- 记录是否出现 context overflow、`prepareTurn` 触发次数、最终 reassemble token 规模。
- 若现状不溢出，该结果作为性能/行为基线；若现状溢出，该结果作为缺陷复现。

**阶段 B：改造后回归**

- 组装真实 `Lifecycle` + `ContextManager` + mock LLM client（可控 token usage 与 tool call 数）。
- 构造一个 subagent `AgentInstance`，prompt 触发模拟 50+ tool step。
- 断言：
  - 单轮内 `prepareTurn` 被多次调用；
  - 至少触发一次成功的 prune 或 summary（不能把 `failed` / `inflated` 当成功）；
  - mock tool scheduler 实际执行 50+ 次 tool call，且 scoped message history 中能看到对应 completed tool output；
  - 全程不抛 `isContextOverflowError`；
  - `turn()` 正常返回 finalOutput。

> 该测试是“解决 subagent 长任务溢出”的核心回归保障。

---

## 四、回归与不破坏

| 项 | 要求 |
|----|------|
| 既有 `runner.unit.test.ts` / `output.unit.test.ts` | 全绿，不修改断言语义 |
| `core/lifecycle` 既有测试 | 不受影响（本轮不改 lifecycle 算法） |
| `core/context` 既有测试 | 不受影响（本轮不改压缩算法） |
| primary `startSession` | 本轮保持旧路径，后续迁移前契约测试必须单独补充 |

---

## 五、验收清单（Definition of Done）

- [ ] `AgentInstance` / `AgentContextScope` / `AgentInstanceFactory` 实现并导出。
- [ ] `AgentContextScope` 已包含 assert/toRunCreateOptions 行为，且 `runAgent` 使用该 scope 统一派生 message/context/run 范围。
- [ ] AC-1 ~ AC-8 全部通过。
- [ ] 新增单测 + 集成测试并入 CI。
- [ ] `docs/core/agents/goals-duty.md` 按 02 文档第七节更新。
- [ ] 与对侧 `agents` 文档的接口契约（`AgentInstanceFactory` 签名、`AgentInstanceIdentity` 字段）一致。
