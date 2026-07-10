# core/agents 模块 goals-duty.md

本文档定义 `core/agents` 的目标和职责边界。`core/agents` 是 agent run 的运行原语层。

---

## 一、模块定位

一句话说明：`core/agents` 提供一份统一的 agent run 原语，让 primary 和 subagent 最终共享同一套底层执行机制。

subagent 已通过 `AgentInstance` 接入该原语；primary `startSession` 也已通过 `AgentInstance.turn(stream)` 接入。primary 当前不携带 `contextScopeId`，物理 primary scope 与旧消息迁移留给后续批次。

---

## 二、Design Goals

### G1: 统一执行原语

提供 `runAgent(deps, input)`，封装以下公共步骤：

- 获取可用工具。
- 可选写入初始 user message。
- 构造 prompt messages。
- 创建 run。
- 绑定取消信号。
- 等待完成。
- 提取最终 assistant 输出。

### G2: 端口化依赖

通过 `AgentRunCoordinator`、`MessageManager`、`ToolScheduler` 等端口协作，不绑定 `runtime/run-manager` 或 adapter 实现。

### G3: envelope 可扩展

`AgentRunInput.waitMode` 支持：

- `waitForCompletion`: 用于 `subagent_run` 每轮执行。
- `stream`: 用于 primary 启动路径，后续会随 primary root instance 迁移继续收敛。

### G4: 输出收口标准化

`extractFinalOutput()` 负责从 session 消息历史中提取最后可见的 assistant 文本，避免每个调用方重复实现。

---

## 三、Duties

| 编号 | 职责 |
|------|------|
| D1 | 定义 `AgentRunInput / AgentRunResult / AgentRunDeps / AgentRunCoordinator` |
| D2 | 实现 `runAgent` waitForCompletion 模式 |
| D3 | 统一写入 `initialUserPrompt` |
| D4 | 将工具定义转换为 OpenAI tools 形态 |
| D5 | 绑定 `AbortSignal` 到 run cancel |
| D6 | 从消息历史提取最终 assistant 输出 |
| D7 | 提供 `AgentInstance` / `AgentContextScope`，让 primary/subagent 共享 turn boundary |
| D8 | 对 subagent 强制 `contextScopeId`，对 primary 暂时禁止 `contextScopeId`，避免半迁移切断历史 |

---

## 四、Non-Duties

| 编号 | 非职责 | 所属模块 |
|------|--------|----------|
| N1 | agent 配置 catalog | `agents/registry` |
| N2 | `RuntimeAgent` 解析 | `agents/manager` |
| N3 | subagent 状态机、close、timeout、recover | `agents/subagent-host` |
| N4 | sandbox lease 创建、workdir ensure、release | `runtime/run-manager` / `sandbox` |
| N5 | run 基础设施持久化和事件桥接 | `runtime` |
| N6 | 生命周期 step 执行 | `core/lifecycle` |
| N7 | 上下文压缩与准备 | `core/context` |
| N8 | primary 物理 `contextScopeId` 迁移与旧消息回填 | 后续迁移批次 |

---

## 五、依赖约束

`core/agents` 允许依赖同层核心端口和类型，例如 `core/message`、`core/tool-scheduler`、`core/lifecycle` 的事件类型和 `core/llm-client` 的 message 类型。

禁止依赖：

- `packages/ohbaby-agent/src/agents`
- `packages/ohbaby-agent/src/adapters`
- `packages/ohbaby-agent/src/runtime` 的具体实现

---

## 六、文档自检

- [x] 能解释 `core/agents` 为什么属于 core。
- [x] 能解释它和 `agents` 服务层的区别。
- [x] 能说明 improve-1 与 improve-2 的 envelope 分界。
