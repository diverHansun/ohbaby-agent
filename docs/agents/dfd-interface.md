# agent 模块 dfd-interface.md

本文档描述 `agent` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 1.1 模块位置

agent 模块在 ohbaby-agent 系统中的位置：

```
                  ┌─────────┐
                  │   UI    │
                  └────┬────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Lifecycle                            │
│  (获取 Agent 配置和系统提示词，执行循环)                  │
└──────────┬───────────────────────────────┬──────────────┘
           │                               │
           ▼                               ▼
    ┌──────────────┐               ┌──────────────┐
    │    Agent     │               │ToolScheduler │
    │   Module     │               │              │
    └──────┬───────┘               └──────────────┘
           │
           ├─────────────────┬─────────────────┐
           ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │System-Prompt │  │   Session    │  │   Policy     │
    │              │  │              │  │  (订阅变化)   │
    └──────────────┘  └──────────────┘  └──────────────┘
```

### 1.2 交互模块

| 模块 | 交互方式 | 说明 |
|------|----------|------|
| **Lifecycle** | 被调用 | 获取 Agent 配置和系统提示词 |
| **System-Prompt** | 调用 | 组装系统提示词 |
| **Session** | 调用 | 创建子 Session |
| **Policy** | 事件 | 发布 Agent 变化事件 |
| **ToolScheduler** | 被调用 | 读取工具配置 |
| **tools/task** | 被调用 | task 工具调用 SubagentExecutor.execute() |
| **Bus** | 调用 | 发布事件 |
| **Config** | 调用 | 读取配置文件路径 |

---

## 二、Data Flow Description（数据流描述）

### 2.1 配置加载数据流

```
1. 应用启动
   │
   ▼
2. AgentRegistry.initialize()
   │
   ├──▶ 加载内置代理配置（代码定义）
   │    └── build, plan, explore, research
   │
   ├──▶ 加载全局配置文件
   │    └── Config.getGlobalPath() → ~/.ohbaby-agent/agents/*.json
   │
   ├──▶ 加载项目配置文件
   │    └── Config.getProjectPath() → .ohbaby-agent/agents/*.json
   │
   └──▶ 合并配置（后者覆盖前者）
        └── 存储到内部 Map
```

### 2.2 获取 Agent 配置数据流

```
1. Lifecycle 需要 Agent 配置
   │
   ▼
2. AgentManager.get(agentName)
   │
   ├──▶ AgentRegistry.get(agentName)
   │    └── 返回 AgentConfig
   │
   └── 返回 AgentConfig 给 Lifecycle
```

### 2.3 获取系统提示词数据流

```
1. Lifecycle 需要系统提示词
   │
   ▼
2. AgentManager.getSystemPrompt(agentName)
   │
   ├──▶ AgentRegistry.get(agentName)
   │    └── 返回 AgentConfig
   │
   ├──▶ 判断代理类型
   │    ├── 主代理：agentPrompt = undefined
   │    └── 子代理：agentPrompt = agent.systemPrompt
   │
   ├──▶ 获取环境信息
   │    └── workingDirectory, platform, isGitRepo, date
   │
   ├──▶ 加载自定义指令（仅主代理）
   │    └── OHBABY.md 文件内容
   │
   ├──▶ SystemPrompt.assemble({
   │      agentName,
   │      agentPrompt,
   │      environment,
   │      customInstructions
   │    })
   │
   └── 返回 string[] 给 Lifecycle
```

### 2.4 子代理执行数据流

```
1. tools/task.ts 被 ToolScheduler 调用
   │
   ▼
2. task 工具调用 SubagentExecutor.execute(params)
   │
   ├──▶ 检查并发数
   │    └── runningCount < MAX_CONCURRENT_SUBAGENTS ?
   │        ├── Yes: 继续
   │        └── No: 抛出错误
   │
   ├──▶ AgentRegistry.get(params.agentName)
   │    └── 返回 AgentConfig
   │
   ├──▶ 验证 mode !== 'primary'
   │    └── 是 primary 则抛出错误
   │
   ├──▶ Session.create({
   │      parentId: params.parentSessionId,
   │      title: params.description
   │    })
   │    └── 返回子 Session
   │
   ├──▶ Bus.publish(SubagentStartedEvent)
   │
   ├──▶ AgentManager.getSystemPrompt(params.agentName)
   │    └── 返回系统提示词
   │
   ├──▶ Lifecycle.run({
   │      sessionId: childSession.id,
   │      agentConfig,
   │      systemPrompt,
   │      initialPrompt: params.prompt
   │    })
   │    └── 等待执行完成
   │
   ├──▶ 收集执行结果
   │    └── 工具调用记录、步数、耗时
   │
   ├──▶ Bus.publish(SubagentCompletedEvent)
   │
   └── 返回 SubagentResult 给 task 工具，task 工具返回给 ToolScheduler
```

### 2.5 Agent 切换数据流

```
1. Policy 模式切换（Plan ↔ Agent）
   │
   ▼
2. Policy.Event.ModeChanged
   │
   ├──▶ AgentManager.switchTo(agentName)
   │    ├── 'plan' → 切换到 plan Agent
   │    └── 'agent' → 切换到 build Agent
   │
   ├──▶ 更新当前 Agent
   │
   └──▶ Bus.publish(AgentChangedEvent)
        │
        ▼
        Policy 模块订阅，读取新 Agent 的 permission
```

---

## 三、Interface Definition（接口定义）

### 3.1 AgentManager 接口

```typescript
namespace AgentManager {
  /**
   * 获取指定代理的配置
   * @param name 代理名称
   * @returns 代理配置，不存在则返回 undefined
   */
  function get(name: string): Promise<AgentConfig | undefined>

  /**
   * 列出所有可用代理
   * @param filter 过滤条件
   * @returns 代理配置列表
   */
  function list(filter?: {
    mode?: AgentMode
    hidden?: boolean
  }): Promise<AgentConfig[]>

  /**
   * 获取默认主代理
   * @returns 默认代理名称
   */
  function getDefault(): Promise<string>

  /**
   * 获取代理的完整系统提示词
   * @param name 代理名称
   * @returns 组装后的系统提示词数组
   */
  function getSystemPrompt(name: string): Promise<string[]>

  /**
   * 切换当前代理
   * @param name 代理名称
   */
  function switchTo(name: string): Promise<void>

  /**
   * 获取当前代理名称
   * @returns 当前代理名称
   */
  function current(): string
}
```

### 3.2 SubagentExecutor 接口

```typescript
namespace SubagentExecutor {
  /**
   * 执行子代理任务
   * @param params 执行参数
   * @returns 执行结果
   * @throws 并发数超限时抛出错误
   */
  function execute(params: SubagentExecuteParams): Promise<SubagentResult>

  /**
   * 检查子代理是否正在运行
   * @param sessionId 子 Session ID
   */
  function isRunning(sessionId: string): boolean

  /**
   * 获取当前并发数
   */
  function getConcurrentCount(): number

  /**
   * 终止单个子代理执行
   * @param sessionId 子 Session ID
   * @param reason 终止原因
   */
  function terminate(
    sessionId: string,
    reason?: 'aborted_by_user' | 'aborted_by_parent' | 'timeout'
  ): Promise<void>

  /**
   * 终止指定父 Session 的所有子代理
   * 触发时机：用户双击 Ctrl+C
   * @param parentSessionId 父 Session ID
   */
  function terminateAll(parentSessionId: string): Promise<void>

  /**
   * 获取指定父 Session 的所有运行中子代理
   * @param parentSessionId 父 Session ID
   * @returns 运行中的子代理 Session ID 列表
   */
  function getRunningChildren(parentSessionId: string): string[]
}
```

### 3.3 事件定义

```typescript
namespace Agent {
  namespace Event {
    /** Agent 变化事件 */
    const Changed = 'agent.changed'

    /** 子代理开始事件 */
    const SubagentStarted = 'agent.subagent.started'

    /** 子代理完成事件 */
    const SubagentCompleted = 'agent.subagent.completed'
  }
}
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据归属

| 数据 | 创建者 | 所有者 | 更新者 | 销毁者 |
|------|--------|--------|--------|--------|
| AgentConfig | AgentRegistry | AgentRegistry | AgentRegistry | AgentRegistry |
| 子 Session | SubagentExecutor | Session 模块 | Lifecycle | Session 模块 |
| 系统提示词 | AgentManager | 调用方 | - | - |
| 执行结果 | SubagentExecutor | 调用方 | - | - |

### 4.2 责任边界

| 操作 | 责任模块 |
|------|----------|
| 加载代理配置 | AgentRegistry |
| 验证代理配置 | AgentRegistry |
| 组装系统提示词 | AgentManager + System-Prompt |
| 创建子 Session | SubagentExecutor + Session |
| 执行子代理循环 | Lifecycle |
| 控制并发数 | SubagentExecutor |
| 发布事件 | AgentManager / SubagentExecutor |

### 4.3 配置文件位置

| 类型 | 路径 | 说明 |
|------|------|------|
| 全局配置 | `~/.ohbaby-agent/agents/*.json` | 用户级配置 |
| 项目配置 | `.ohbaby-agent/agents/*.json` | 项目级配置 |
| 项目级记忆 | `{projectRoot}/OHBABY.md` | 项目根目录，与 .gitignore 同级 |
| 全局级记忆 | `~/.ohbaby-agent/OHBABY.md` | XDG 配置目录 |

**说明**：项目级 OHBABY.md 放在项目根目录（而非 `.ohbaby-agent/` 内），便于用户发现、编辑和版本控制。

---

## 五、依赖接口说明

### 5.1 System-Prompt 模块依赖

```typescript
// agent 模块调用 System-Prompt 模块
SystemPrompt.assemble({
  agentName: string
  agentPrompt?: string
  environment?: EnvironmentInfo
  customInstructions?: string[]
}): string[]
```

### 5.2 Session 模块依赖

```typescript
// SubagentExecutor 调用 Session 模块
Session.create({
  parentId?: string
  title?: string
}): Promise<SessionInfo>
```

### 5.3 Lifecycle 模块依赖

```typescript
// SubagentExecutor 创建 Lifecycle 实例并执行
interface LifecycleFactory {
  create(options: {
    sessionId: string
    agentConfig: AgentConfig
    systemPrompt: string[]
  }): Lifecycle
}

interface Lifecycle {
  run(prompt: string): Promise<LifecycleResult>
}
```

### 5.4 Bus 模块依赖

```typescript
// agent 模块发布事件
Bus.publish(eventName: string, payload: unknown): void
```

---

## 六、错误处理

### 6.1 配置加载错误

| 错误场景 | 处理方式 |
|----------|----------|
| 配置文件不存在 | 静默忽略，使用内置配置 |
| 配置文件格式错误 | 记录警告，跳过该文件 |
| 必填字段缺失 | 记录错误，跳过该代理 |
| 名称冲突 | 后加载的覆盖先加载的 |

### 6.2 执行错误

| 错误场景 | 错误类型 | 处理方式 |
|----------|----------|----------|
| 代理不存在 | `AgentNotFoundError` | 抛出错误 |
| 主代理作为子代理 | `InvalidAgentModeError` | 抛出错误 |
| 并发数超限 | `MaxConcurrentExceededError` | 抛出错误 |
| 子代理执行失败 | `SubagentExecutionError` | 返回失败结果 |

---

## 七、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 不存在数据责任不清或重复处理的风险
- [x] 依赖接口明确定义
- [x] 错误处理策略清晰
