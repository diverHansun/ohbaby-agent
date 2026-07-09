# 01 · 现有问题分析（core/agents 视角）

本文分析 `packages/ohbaby-agent/src/core/agents` 在「subagent instance 化」前的结构性问题。所有结论均基于当前代码。

---

## 一、问题总览

| 编号 | 问题 | 影响 | 定位 |
|------|------|------|------|
| P1 | subagent context 隔离主要依赖 DB/session 字段与调用方传参 | 身份隔离是逻辑约定，不是运行时强约束 | `runAgent` / `prepareTurn` 参数链 |
| P2 | 没有 context 的运行时 owner | subagent 长任务上下文管理不可靠、无处挂载 per-step 压缩契约 | 全局 |
| P3 | `runAgent` 是「一次性 run」，非「可持续 agent」 | 多轮（现 `agent_eval`）靠上层反复重建，无实例延续语义 | `runner.ts` |
| P4 | 双 envelope 在上层被迫复制编排 | `runAgent` 之外，两个上层各写一遍「resolve + deadline + run + 收口」 | `runner.ts` 被 `service.ts` / `tasks/manager.ts` 各自包裹 |

---

## 二、P1：DB 字段隔离不足以承担运行时上下文隔离

### 2.1 现状

`core/agents` 当前只暴露一个函数式原语：

```125:135:packages/ohbaby-agent/src/core/agents/runner.ts
export async function runAgent(
  deps: AgentRunDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  ...
  const isSubagent = input.parentSessionId !== undefined;
```

`isSubagent` 由 `parentSessionId` 是否存在临时推断，并向下透传给 `RunManager.create({ isSubagent })`、tool scheduler 与 lifecycle/context。

`core/context` 的隔离能力已经存在，但入口仍是参数：

- `assemble(sessionId, directory, isSubagent)` 用 `isSubagent` 决定是否加载 memory。
- `systemPromptProvider.build({ sessionId, directory, isSubagent })` 用 `isSubagent` 构造不同 prompt。
- `prepareTurn({ sessionId, isSubagent })` 用 `sessionId` 读取该 session 的消息历史并执行压缩。

这些逻辑是正确的，但它们没有形成“实例级身份边界”。只要某个调用方把 `sessionId`、`parentSessionId` 或 `isSubagent` 传错，运行时本身没有一个 owner 对象统一校验。

### 2.2 后果

- **隔离是逻辑约定**：DB 的 `session.parent_id` 与 `message.session_id` 只能区分到 session/container；若一个 child session 下有多个 subagent，还缺少 instance/context-scope 维度。执行时仍靠每轮调用传对字段。
- **身份每轮重新计算**：同一个 child session 或同一个 subagent 的下一轮执行，仍是一次新的 `runAgent(input)`，没有“这是同一个 subagent 实例”的运行时承诺。
- **压缩契约无法挂载到对象**：`Lifecycle.run` 每 step 调 `prepareTurn` 是正确路径，但“这个 subagent 的每一轮都必须走这条路径”没有对象负责。

---

## 三、P2：没有 context 的运行时 owner

### 3.1 现状

`runAgent` 的输入是一次性的（`AgentRunInput`：sessionId + prompt + waitMode），产出一个 `AgentRunResult` 后即结束。它不持有“这个 agent 是谁、它的 context 生命周期如何演进”的状态。

### 3.2 后果

- primary 由 `AgentService.startSession` 触发一次 stream；subagent 由 `AgentService.executeTask` 或 `AgentTaskManager.runTurn` 触发。三条路径都只是“拿 sessionId 调 runAgent”。
- 长任务多轮场景下，每一轮都从 DB 重读、重组装 context。DB 是真相源没有问题，但运行时缺少像 kimi-code `Agent -> ContextMemory` 那样的 owner。
- `AgentContextScope` 需要承担这个 owner 的身份面：绑定 instance/context scope、校验 session、生成 context/message 过滤条件与 run create 身份参数。压缩执行仍由 lifecycle/context manager 负责。

---

## 四、P3：`runAgent` 是一次性 run，缺实例延续语义

`extractFinalOutput` 从 session 消息历史提取最后可见 assistant 文本，收口逻辑本身可保留。

隐患在多轮：

1. 没有「同一实例正在运行」的并发保护。
2. 没有实例层的 session/parent/role 校验。
3. 没有「摘要过短则补一轮」的 handoff 保障（kimi-code 的 `summary-continuation` 机制，属服务层后续增强）。

结论：`extractFinalOutput` 作为收口原语保留，但应被 `AgentInstance.turn()` 调用；多轮延续与并发保护交给 `AgentInstance` + `SessionSubagentHost`。

---

## 五、P4：双 envelope 在上层被迫复制编排

`runAgent` 本身已通过 `waitMode` 支持两种交付方式：

```35:36:packages/ohbaby-agent/src/core/agents/types.ts
  readonly waitMode: "stream" | "waitForCompletion";
```

- `stream`：返回事件流，供 primary/UI 消费。
- `waitForCompletion`：阻塞等待，`extractFinalOutput` 收口。

问题不在 `runAgent` 内部，而在于：`runAgent` 只覆盖“创建 run → 等待/流式 → 收口”。它不覆盖“解析 session、并发/容量控制、超时 deadline、多轮排队”。于是 `AgentService` 与 `AgentTaskManager` 各自把 `runAgent` 包进一层几乎重复的编排。

对 `core/agents` 的启示：提供比 `runAgent` 更高一层、但仍属执行原语的 `AgentInstance`；对 `agents` 的启示：由 `SessionSubagentHost` 统一调度，而不是保留 `task`/`agent_open` 两套实现。

---

## 六、本模块问题与用户痛点的映射

| 用户痛点 | 本模块根因 |
|----------|-----------|
| 痛点 1：subagent 长任务上下文溢出 | P1/P2：无实例级 context owner，压缩契约不能绑定到 subagent 生命周期 |
| 痛点 2：后台 subagent 重启后丢失 | 主因在对侧持久化，但 P1/P2 使“从持久化恢复成哪个实例”缺少承接对象 |
| 痛点 3：工具面混乱 | 主因在对侧工具/host，但 P4 暴露出执行编排没有被实例化收口 |

---

## 七、不改动的既有正确设计（必须保留）

1. `runAgent` 的 `waitMode` 双模式抽象——正确，`AgentInstance` 在其上分层，不推翻。
2. 端口化依赖（`AgentRunCoordinator` / `MessageManager` / `ToolScheduler` / `AgentSandboxEnvironmentManager`）——保留。
3. `core/agents` 不依赖 `agents` / `adapters` / `runtime` 具体实现的方向约束——继续遵守。
4. `extractFinalOutput` 的收口职责——保留并被复用。
5. `core/context` 的压缩算法与 message SQLite 真相源——保留，不照搬 kimi-code wire replay。
