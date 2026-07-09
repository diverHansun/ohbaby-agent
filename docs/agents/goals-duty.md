# agent 模块 goals-duty.md

本文档定义 `agents` 服务层在 subagent context/instance 化后的目标与职责边界。

---

## 一、模块定位

一句话说明：`agents` 是 agent 描述符、运行时解析和调度服务层；真正的 agent 执行原语位于 `core/agents`。

如果没有 `agents`：

- 系统无法集中管理 build、plan、explore、research 等 agent 配置。
- `subagent_run` 无法按名称解析目标 agent 并创建受控 child session。
- 长生命周期 subagent 缺少统一的状态机、关闭语义和 owner 恢复边界。
- Policy、System-Prompt、ToolScheduler 无法围绕 agent 描述符形成一致约定。

---

## 二、Design Goals

### G1: 统一的 agent 描述符管理

`AgentRegistry` 负责加载和合并内置、全局、项目级 agent 配置。配置对象描述“agent 是什么”，不承载执行循环。

### G2: 运行时 agent 解析

`AgentManager.getRuntimeAgent()` 负责把描述符解析为运行时所需信息，包括系统提示词、可用工具、LLM 参数和 maxSteps。

### G3: 受控的 subagent envelope

`SessionSubagentHost` 为 `subagent_run/status/close` 工具提供统一调用形态：

- 校验目标 agent 必须是 subagent role。
- 复用 parent 下的 child session，但每个 subagent 持有自己的 `contextScopeId`。
- 通过 `AgentInstance` 调用 `core/agents.runAgent({ waitMode: "waitForCompletion" })`。
- 将最终 assistant 输出包装成 `SubagentRunResult`。
- 维护 `cancelled/closedAt/timed_out/interrupted` 等可持久化状态。

### G4: 长生命周期 subagent 状态机

`SessionSubagentHost` 负责 background/foreground、排队、interrupt、close 和 status。它只管理状态和排队，不重新实现 run 生命周期。

### G5: 分层清晰

`agents` 不直接拥有 RunManager 细节，不自行写子代理 user message，不持有旧的 subagent session/message helper。所有“启动 + 等待 + 收口”的运行序列必须通过 `AgentInstance` 委托给 `core/agents.runAgent`。

---

## 三、Duties

| 编号 | 职责 | 负责对象 |
|------|------|----------|
| D1 | 加载、合并、列出 agent 描述符 | `AgentRegistry` |
| D2 | 提供内置 agent 描述符 | `builtin/*` |
| D3 | 解析 `RuntimeAgent` | `AgentManager` |
| D4 | 校验 subagent 可调用目标 | `SessionSubagentHost` / `AgentManager` |
| D5 | 创建或复用 child session | `SessionSubagentHost` 通过 `SessionManager` |
| D6 | 创建 `AgentInstance` 和 `contextScopeId` | `SessionSubagentHost` / `AgentInstanceFactory` |
| D7 | 管理长生命周期 subagent 状态、队列、close、timeout、recover | `SessionSubagentHost` / `SubagentInstanceStore` |
| D8 | 删除旧 subagent runner/executor API | `agents/index.ts` / package root exports |

---

## 四、Non-Duties

| 编号 | 非职责 | 所属模块 |
|------|--------|----------|
| N1 | LLM/tool 执行循环 | `core/lifecycle` |
| N2 | run 创建、取消、等待的基础设施 | `runtime/run-manager` |
| N3 | agent 执行原语 | `core/agents` |
| N4 | 消息持久化 | `core/message` |
| N5 | 初始 user message 写入 | `core/agents.runAgent` |
| N6 | session 存储和父子关系维护 | `services/session` |
| N7 | 工具实际执行 | `core/tool-scheduler` |
| N8 | 权限确认和策略执行 | policy / permission 相关模块 |
| N9 | primary stream envelope | agents improve-2 |

---

## 五、设计约束

1. `SessionSubagentHost` 不得绕过 `AgentInstance.turn()` 自行编排 run。
2. `agents` 可以依赖 `core/agents`，但 `core/agents` 不得依赖 `agents`。
3. `runtime` 不得依赖 `agents` 或 `core/agents`。
4. improve-1 直接删除 `SubagentExecutor`、`SubagentExecutorOptions`、`createSubagentRunner` 等旧 API。
5. primary 路径在 improve-1 不切换，任何文档和测试都应明确这一点。

---

## 六、模块关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `core/agents` | 依赖 | 调用 `runAgent` 执行 agent |
| `services/session` | 依赖 | 创建 root/child session，维护父子关系 |
| `core/message` | 依赖 | 读取 child session 输出 |
| `core/tool-scheduler` | 依赖 | 获取可用于本 agent 的工具定义 |
| `system-prompt` | 间接依赖 | 通过 `AgentManager` 组装 runtime prompt |
| `tools/subagent` | 被依赖 | `subagent_run/status/close` 工具调用 `SessionSubagentHost` |
| `runtime` | 通过端口间接协作 | 只通过 `AgentRunCoordinator` 端口进入 |

---

## 七、文档自检

- [x] 能用一句话说明 `agents` 的存在意义。
- [x] 能区分 `agents` 和 `core/agents`。
- [x] 能明确哪些旧职责已经移除。
- [x] 能为 improve-2 的 primary 切换留下清晰边界。
