# agent 模块 dfd-interface.md

本文档描述 agents improve-1 后的主要数据流与接口。当前重点是 Task 同步 subagent 路径；primary stream 路径仍在 improve-2 规划中。

---

## 一、Context & Scope

```text
tools/task
   |
   v
agents.AgentService
   |-- AgentManager
   |-- services/session
   |-- core/message
   |-- core/tool-scheduler
   v
core/agents.runAgent
   |
   v
AgentRunCoordinator port
   |
   v
runtime/run-manager
   |
   v
core/lifecycle.runSession
```

交互模块：

| 模块 | 交互方式 | 说明 |
|------|----------|------|
| `tools/task` | 调用方 | 调用 `AgentService.executeTask()` |
| `AgentManager` | 被调用 | 解析 `RuntimeAgent` |
| `services/session` | 被调用 | 创建或恢复 child session |
| `core/agents` | 被调用 | 执行 agent run 原语 |
| `core/message` | 被调用 | 写初始 user message、读取最终 assistant 输出 |
| `core/tool-scheduler` | 被调用 | 获取可用工具定义 |
| `runtime/run-manager` | 端口实现 | 满足 `AgentRunCoordinator` |

---

## 二、Data Flow

### 2.1 配置加载

```text
1. 应用初始化
2. AgentRegistry 加载 builtin agent
3. AgentRegistry 加载用户配置
4. 后加载配置覆盖同名配置
5. AgentManager 基于 Registry 对外提供 RuntimeAgent
```

### 2.2 RuntimeAgent 解析

```text
1. AgentService 需要执行 agentName
2. AgentManager.getRuntimeAgent(agentName, { isSubagent: true })
3. AgentManager 获取 AgentConfig
4. AgentManager 组装 system prompt、tool config、LLM params、maxSteps
5. 返回 RuntimeAgent
```

### 2.3 Task 同步执行

```text
1. tools/task 收到模型工具调用
2. AgentService.executeTask(params)
3. 检查 runningCount < maxConcurrency
4. 获取 RuntimeAgent 并拒绝 mode === "primary"
5. 如果 resumeSessionId 存在:
     SessionManager.get(resumeSessionId)
     校验 parentId、agentName、isSubagent
   否则:
     SessionManager.get(parentSessionId)
     SessionManager.create(parent.projectRoot, { parentId, agentName, title })
6. 调用 core/agents.runAgent({
     waitMode: "waitForCompletion",
     initialUserPrompt: params.prompt,
     sessionId: childSession.id,
     parentSessionId: params.parentSessionId
   })
7. runAgent 写入 child user message
8. runAgent buildPromptMessages(...)
9. runAgent 获取可用工具并创建 run
10. runAgent waitForCompletion(runId)
11. runAgent listBySession(childSession.id) 并提取最终 assistant 文本
12. AgentService 返回 SubagentResult
```

### 2.4 长生命周期 task

```text
1. agent_open 创建 AgentTaskRecord 和 child session
2. AgentTaskManager 将首轮 prompt 排入执行
3. 每一轮 runTurn 调用 core/agents.runAgent
4. sendInput 在运行中则入队；interrupt=true 时取消当前 run 并优先执行新输入
5. close 标记 cancelled 并取消当前 run
6. get 返回 store 中的任务状态和输出
```

---

## 三、Interfaces

### 3.1 AgentService

```typescript
class AgentService implements TaskExecutor {
  execute(params: SubagentExecuteParams): Promise<SubagentResult>
  executeTask(params: SubagentExecuteParams): Promise<SubagentResult>
  getConcurrentCount(): number
}
```

旧 `SubagentExecutor` / `SubagentExecutorOptions` alias 不再导出。内部和外部调用方应直接使用 `AgentService`。

### 3.2 core/agents

```typescript
type AgentRunner = (
  deps: AgentRunDeps,
  input: AgentRunInput,
) => Promise<AgentRunResult>

interface AgentRunInput {
  sessionId: string
  parentSessionId?: string
  agentName: string
  projectRoot: string
  initialUserPrompt?: string
  waitMode: "stream" | "waitForCompletion"
  buildPromptMessages: AgentPromptMessageBuilder
}
```

improve-1 仅实现 `waitMode: "waitForCompletion"`。`waitMode: "stream"` 的完整行为属于 improve-2。

### 3.3 SessionManager

```typescript
interface SessionManager {
  create(projectDirectory: string, options?: CreateSessionOptions): Promise<Session>
  get(sessionId: string): Promise<Session | null>
  ensureRoot(input: EnsureRootSessionInput): Promise<Session>
}
```

`ensureRoot` 用于 composition 保证 primary/root session 记录存在，替代旧 `RuntimeSubagentSessionManager.ensureRoot`。

---

## 四、Data Ownership

| 数据 | 创建者 | 所有者 | 说明 |
|------|--------|--------|------|
| AgentConfig | `AgentRegistry` | `agents` | 描述符配置 |
| RuntimeAgent | `AgentManager` | 调用方临时持有 | 运行时解析结果 |
| root/child Session | `SessionManager` | `services/session` | 父子关系由 session 层维护 |
| 初始 user message | `core/agents.runAgent` | `core/message` | `AgentService` 不再直接写消息 |
| RunRecord | `AgentRunCoordinator` | `runtime/run-manager` | `core/agents` 只依赖端口 |
| 最终输出 | `core/agents.extractFinalOutput` | 调用方消费 | 从 child session assistant 消息中提取 |

---

## 五、Error Handling

| 场景 | 行为 |
|------|------|
| 目标 agent 不存在 | `AgentManager.getRuntimeAgent` 抛错 |
| 目标 agent 是 pure primary | `AgentService` 抛错并包装失败结果 |
| parent session 不存在 | `AgentService` 抛错并包装失败结果 |
| resume session 不存在或不属于 parent | `AgentService` 抛错并包装失败结果 |
| 并发超限 | `AgentService` 直接抛出 `Maximum concurrent subagents reached` |
| run 失败 | `AgentService` 返回 `success: false` 和错误文本 |

---

## 六、文档自检

- [x] 数据流和当前代码路径一致。
- [x] 明确旧 `SubagentExecutor` alias 已删除。
- [x] 明确 `runAgent` 是执行原语。
- [x] 明确 primary stream 仍属于 improve-2。
