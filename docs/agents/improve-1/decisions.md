# agents improve-1 架构决策记录（ADR）

本文档记录 `agents/` 模块本轮重构在目标目录结构上的决策过程，包括三种候选方案的对比与最终选择。

| 字段 | 值 |
|------|---|
| 状态 | 已决议（Accepted） |
| 决议日期 | 2026-05-25 |
| 决议人 | 项目负责人 |
| 涉及方 | 项目负责人、Claude、Codex |
| 关联文档 | [problem-analysis.md](./problem-analysis.md)、[implementation-plan.md](./implementation-plan.md)、[acceptance.md](./acceptance.md) |

---

## 一、决议（一句话）

**新建 `core/agents/` 承担 agent 运行底层（primary 与 subagent 共用一份机制）；`agents/` 收敛为服务/调度层；`runtime/` 严格保持基础设施身份不接受任何 agent-specific 模块。**

---

## 二、上下文

`packages/ohbaby-agent/src/agents/` 当前包含 14 个源文件，其中 5 项明显不属于"agent 描述符"职责：

- `runner.ts` —— 子代理一次性运行编排
- `executor.ts` —— Task 工具的执行实现
- `tasks/` —— 长生命周期多轮子代理任务状态机
- `message-writer.ts` —— 子代理 user/assistant message 持久化薄包装
- `session-manager.ts` —— `services/session.SessionManager` 的重复抽象

这些文件违反了**单一职责**、**稳定依赖**、**DRY**、**功能内聚**等多条软件工程原则（详见 [problem-analysis.md 第四节](./problem-analysis.md#四关键问题清单)）。本次决策的核心问题是：**这些被搬出的对象应该去哪里？**

---

## 三、候选方案对比

### 方案 1：Codex 原始提议 —— `runtime/subagent-*`

**结构**：

```
runtime/
├── run-manager/
├── run-ledger/
├── stream-bridge/
├── interaction-broker/
├── daemon/
├── subagent-runner/        ← 新
├── subagent-executor/      ← 新
└── subagent-tasks/         ← 新
```

**优点**：

- 文件搬迁路径最短。
- `runtime/` 已经包含执行相关模块，看似自然。

**缺点（致命）**：

- `runtime/` 的本来身份是**通用 run 基础设施**（RunManager、Ledger、StreamBridge 等所有 agent 执行都消费）。`subagent-*` 是**特定执行模式**，不是基础设施。混入会破坏 `runtime/` 的概念身份。
- 把 agents/ 当前的"杂物间"问题原样搬到 runtime/，并没有根治。
- 没有承认"primary 与 subagent 共享底层"这个产品事实。

### 方案 2：Claude 中间提议 —— 新建 `subagents/` 顶层模块

**结构**：

```
agents/        ← 描述符
subagents/     ← 新：runner / executor / tasks（子代理执行模式）
runtime/       ← 不变（保持基础设施身份）
```

**优点**：

- 保护 `runtime/` 概念身份。
- `subagents/` 作为对等概念存在，比塞进 runtime/ 干净。

**缺点（关键）**：

- **错误地把 subagent 当成独立概念**。实际上 primary agent 和 subagent 共享同一套底层运行机制（`Lifecycle.runSession`、`context.prepareTurn`、`MessageManager`、`ToolScheduler`、`SessionManager`），差异只在 envelope（结果交付方式：流式 vs 同步等待）。
- 把"subagent 运行"独立成模块意味着复制核心机制，违反 DRY。
- 与 pi / opencode / claude-code 的"一个底层 + 多个 envelope"惯例不符。

### 方案 3：本轮决议 —— `core/agents/` 底层 + `agents/` 服务层

**结构**：

```
core/
├── agents/           ← 新：agent 运行底层（primary & subagent 共用）
├── context/
├── lifecycle/
├── message/
├── system-prompt/
├── tool-scheduler/
├── memory/
├── bus/
└── llm-client/

agents/               ← 服务/调度层
├── types.ts          ← AgentConfig / RuntimeAgent 描述符
├── registry.ts       ← catalog
├── manager.ts        ← AgentManager
├── service.ts        ← AgentService（Task 工具执行 + 并发）
├── tasks/            ← 长任务状态机（消费 core/agents）
├── builtin/
└── index.ts

runtime/              ← 严格基础设施（不变）
└── ...
```

**优点**：

- 承认产品事实：所有 agent（primary / subagent）共享同一套底层运行机制；envelope 差异在外层。
- `core/agents/` 在 core 内层，与 `core/lifecycle / context / message` 同级，**消费它们的位置就在它们旁边**，依赖关系自然。
- `agents/` 真正成为"高抽象、可复用、服务/调度层"，与 `services/session` 风格一致。
- `runtime/` 概念身份不动。
- 符合 pi / opencode / claude-code 的"一个底层 + 多个 envelope"惯例。
- 不再为"subagent"特定化目录命名，未来若新增第三种 agent 执行 envelope（如 webhook 触发的 batch agent）无须新建模块。

**缺点**：

- 改动范围比方案 1 大：除了搬文件，还要抽出 `runAgent` 核心原语。
- 短期内 primary 仍走旧路径（composition → RunWorker），承诺的"统一底层"在 improve-1 阶段只对 subagent 路径兑现，primary 的切换留 improve-2。

---

## 四、决议依据

按软件工程原理对三方案逐项打分（高分为优）：

| 原则 | 方案 1 (runtime/subagent-*) | 方案 2 (subagents/) | 方案 3 (core/agents/) |
|------|-----|-----|-----|
| 单一职责（SRP） | 3 — 把执行模式混入基础设施 | 4 — 独立目录 | **5** — 底层与服务层分清 |
| DRY（机制层面） | 2 — primary/subagent 分两套 | 2 — 同左 | **5** — 一份底层 |
| 稳定依赖（SDP） | 3 — runtime 内部稳定度混杂 | 4 — 概念清晰 | **5** — core 内层最稳定 |
| 概念清晰度 | 3 — runtime 身份模糊 | 4 — subagent 是独立概念（但是误识） | **5** — primary/subagent 同源 |
| 与同类项目惯例 | 2 — 都不这么做 | 3 — 部分匹配 | **5** — 与 pi/opencode/claude-code 一致 |
| 短期改造量 | **5** — 仅搬文件 | 4 | 3 — 需要抽 runAgent |
| 长期演进成本 | 2 — 概念债 | 3 | **5** — 无概念债 |
| **合计** | **20** | **24** | **33** |

短期改造量虽然是方案 1 最优，但**架构决策不应被一次性改造成本绑架**。一次正确的抽象一劳永逸，错误的抽象会持续付利息。

### 关键支持证据

**事实 1：primary 与 subagent 共享底层**

| 维度 | Primary | Subagent | 差异 |
|------|---------|----------|------|
| Turn loop | `Lifecycle.runSession` | `Lifecycle.runSession` | **同一套** |
| Context | `context.prepareTurn` | `context.prepareTurn` | 同一套 |
| Tools | `ToolScheduler` | `ToolScheduler`（受限工具集） | 同机制，配置不同 |
| System prompt | `core/system-prompt` 主模式 | `core/system-prompt` subagent 模式 | 同模块，模式不同 |
| Memory | 加载 | 跳过 | 同模块，flag 不同 |
| Message | `MessageManager` | `MessageManager` | 同一套 |
| Session | 顶层 | `parentId !== undefined` | 同一套 |
| **结果交付** | 事件流到 UI | 同步等终态读 last assistant | **真正不同：envelope** |

→ 差异仅在 envelope，不在机制。任何把"subagent 跑"独立成模块的方案都在复制机制。

**事实 2：参考项目一致**

| 项目 | 底层 | envelope |
|------|------|---------|
| pi | `agentLoop()` 纯函数 | 交互式 harness 与 Task 工具各自包装 |
| opencode | session service 提供 run | TaskTool 包装 session service |
| claude-code | 同一套 conversation loop | `AgentTool` / `LocalAgentTask` 提供同步 envelope |

→ 三者都是"一份底层 + 多个 envelope"。

**事实 3：`core/` 的现有命名惯例**

`core/lifecycle / core/context / core/message / core/system-prompt / core/tool-scheduler / core/memory / core/llm-client / core/bus` —— 这些是 ohbaby 已经建立的"底层能力"分类约定。`core/agents/` 完全契合这一约定，作为"agent 运行底层能力"加入。

---

## 五、决议范围与约束

### 5.1 本轮（agents improve-1）落地的承诺

- **建立** `core/agents/` 作为"agent 运行底层"。最小可用形态：`runAgent(input)` + `extractFinalOutput()`，subagent 路径全量切换到此。
- **agents/** 收敛为服务/调度层：保留 `types / registry / manager / builtin / index`，新增 `service.ts`，`tasks/` 内部消费 `core/agents`，并直接删除旧 `runner.ts / executor.ts` API。
- **services/session** 补 `ensureRoot`。
- **删除** `agents/session-manager.ts` 与 `agents/message-writer.ts`（后者依赖 lifecycle improve-1 P2 完成）。
- **runtime/** 不动，不接受任何 agent-specific 子目录。

### 5.2 本轮**不**承诺

- primary agent 路径切换到 `core/agents.runAgent`。**留 improve-2**。
- composition / RunWorker 改造。**留 improve-2**。
- 多 provider 抽象。**留 improve-N**。
- Agent 权限模型、内置 agent 集合的功能演进。**不在本轮范围**。

### 5.3 长期方向（improve-2 及以后）

- improve-2：primary agent 启动路径切换到 `core/agents.runAgent`。届时 composition / RunWorker 只是 "primary envelope 提供者"。
- improve-2：整理 Task 工具 envelope 类型命名，评估是否把 `SubagentExecuteParams / SubagentResult` 改为更通用的 `TaskInvocation*` 命名。
- improve-N：评估是否需要第三种 envelope（webhook、batch、cron）；如有，叠加在 `core/agents.runAgent` 之上即可，不动核心。

---

## 六、后果与影响

### 6.1 正面影响

- `agents/` 真正成为"高抽象、可复用、服务/调度层"，与 `services/` 风格对齐。
- `core/agents/` 是 primary 与 subagent 的唯一执行底层，未来新增 envelope 零代价。
- `runtime/` 概念身份保持纯净。
- 与 pi / opencode / claude-code 的成熟惯例对齐，降低新成员理解成本。

### 6.2 负面影响

- 短期改造量大于方案 1。需要额外抽出 `core/agents/runner.ts` 与 `core/agents/output.ts`。
- improve-1 阶段 primary 路径未切换，存在"承诺与现实有差"的过渡期。需在文档与 PR 描述中明确说明。
- `agents/index.ts` 的 barrel 不再导出旧 runner/executor API；调用方必须走 `AgentService` 或 `core/agents.runAgent`。

### 6.3 中性影响

- 类型的归属在两个模块间需要划分（参见 [implementation-plan.md 第二节](./implementation-plan.md#二阶段-gp2-建立-coreagents)）：
  - `agents/types.ts`：`AgentConfig / RuntimeAgent / PermissionConfig / ToolsConfig` 等描述符。
  - `core/agents/types.ts`：`AgentRunInput / AgentRunResult / AgentRunner` 等运行时契约。
  - `agents/types.ts` 暂保留 Task 工具 envelope 类型，命名是否进一步收敛留给 improve-2。

---

## 七、被否决方案的处置

- **方案 1（`runtime/subagent-*`）**：明确否决。本轮及后续 improve-N 不会采用。
- **方案 2（`subagents/`）**：明确否决。但其"保护 runtime/ 概念身份"的核心论点被方案 3 完全吸收。

---

## 八、签字栏（决策溯源）

| 角色 | 立场 | 备注 |
|------|------|------|
| 项目负责人 | 提出方案 3 | 关键论点："primary 和 subagent 都是 agents，底层应该是同一套" |
| Claude | 提出方案 2，认可方案 3 优于方案 2 | 方案 3 比方案 2 更彻底地承认机制共享 |
| Codex | 提出方案 1 | 待回复对方案 3 的看法 |

---

## 九、引用与延伸阅读

- 本目录的 [problem-analysis.md](./problem-analysis.md) 第七节"本轮重构目标"
- 本目录的 [implementation-plan.md](./implementation-plan.md) 第一节"总体策略"
- [`docs/core/lifecycle/improve-1/`](../../core/lifecycle/improve-1/README.md) —— 上游依赖（`Lifecycle.runSession`）
- [`docs/core/context/improve-1/`](../../core/context/improve-1/README.md) —— `context.prepareTurn` 契约（被 `core/agents.runAgent` 间接消费）
- 参考项目：pi（`agentLoop` 纯函数）、opencode（Agent service + TaskTool）、claude-code（Agent definition + AgentTool + LocalAgentTask）
