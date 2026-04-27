# agents 模块 architecture.md

本文档描述 `agents` 模块的内部结构与设计模式。

---

## 一、Architecture Overview（总体架构）

agents 模块采用**分层架构**，分为三个主要层次：

```
┌─────────────────────────────────────────────────────────┐
│ Public API Layer (公共接口层)                           │
│ - AgentManager: 对外统一接口                            │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Core Layer (核心层)                                     │
│ - AgentRegistry: 配置加载与管理                         │
│ - SubagentExecutor: 子代理执行                          │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Data Source Layer (数据源层)                            │
│ - config/agents: 用户配置加载                           │
│ - system-prompt: 系统提示词                             │
│ - builtin: 内置代理定义                                 │
└─────────────────────────────────────────────────────────┘
```

### 1.1 组件职责

| 组件 | 职责 |
|------|------|
| **AgentManager** | 对外统一接口，协调 Registry 和 Executor |
| **AgentRegistry** | 合并、存储、验证代理配置 |
| **SubagentExecutor** | 执行子代理任务，管理并发控制 |
| **Builtin Agents** | 定义内置代理的默认配置 |

### 1.2 组件间依赖

```
AgentManager
    ├── AgentRegistry (配置获取)
    ├── SubagentExecutor (子代理执行)
    └── SystemPrompt (提示词组装)

AgentRegistry
    ├── config/agents (用户配置加载)
    ├── config/llm (LLM 参数默认值)
    └── builtin (内置代理配置)

SubagentExecutor
    ├── AgentRegistry (获取子代理配置)
    ├── Session (创建子 Session)
    └── Lifecycle (执行子代理循环)
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 Registry 模式

**使用场景**：AgentRegistry

**理由**：
- 需要集中管理多个代理配置
- 支持从多个来源（内置、用户配置）加载配置
- 提供统一的查询和验证机制

**实现方式**：
- 内部使用 Map 存储代理配置
- 启动时加载内置配置
- 通过 config/agents 模块加载用户配置
- 用户配置覆盖内置配置（同名完全替换）

### 2.2 Facade 模式

**使用场景**：AgentManager

**理由**：
- 为外部模块提供简化的统一接口
- 隐藏 Registry 和 Executor 的内部复杂性
- 便于未来扩展和重构

**实现方式**：
- AgentManager 作为模块的唯一对外接口
- 内部委托给 Registry 和 Executor
- 外部模块只依赖 AgentManager

### 2.3 职责分离

**配置与提示词分离**：

| 职责 | 负责模块 | 说明 |
|------|----------|------|
| 配置加载 | config/agents | 从文件系统加载 JSON 配置 |
| 配置合并 | agents (AgentRegistry) | 内置配置与用户配置合并 |
| 提示词存储 | system-prompt | 集中存储所有提示词 |
| 提示词组装 | agents (AgentManager) | 组装配置与提示词 |

**理由**：
- 配置使用 JSON 格式，便于 Zod Schema 验证
- 提示词使用代码/Markdown，便于版本控制和复杂组装逻辑
- 分离后各模块职责更清晰

### 2.4 未使用的模式

**策略模式**：
- 考虑过用于不同类型代理的执行策略
- 未使用原因：当前主代理和子代理执行逻辑差异由 Lifecycle 处理，不需要在 agents 模块实现

**工厂模式**：
- 考虑过用于创建代理实例
- 未使用原因：代理是配置对象而非行为对象，直接返回配置即可

---

## 三、Module Structure & File Layout（模块结构与文件组织）

### 3.1 目录结构

```
ohbaby-agent/src/core/agents/
├── index.ts                 # 公共 API 导出
├── manager.ts               # AgentManager 实现
├── registry.ts              # AgentRegistry 实现
├── executor.ts              # SubagentExecutor 实现
├── types.ts                 # 类型定义
├── builtin/                 # 内置代理
│   ├── index.ts             # 内置代理导出
│   ├── build.ts             # build 代理配置
│   ├── plan.ts              # plan 代理配置
│   ├── explore.ts           # explore 代理配置
│   └── research.ts          # research 代理配置
└── __tests__/               # 测试文件
    ├── manager.test.ts
    ├── registry.test.ts
    └── executor.test.ts
```

### 3.2 文件职责

| 文件 | 职责 | 对外稳定性 |
|------|------|------------|
| `index.ts` | 公共 API 导出 | **稳定** |
| `types.ts` | 类型定义 | **稳定** |
| `manager.ts` | AgentManager 实现 | 内部实现 |
| `registry.ts` | AgentRegistry 实现 | 内部实现 |
| `executor.ts` | SubagentExecutor 实现 | 内部实现 |
| `builtin/*` | 内置代理定义 | 内部实现 |

### 3.3 公共 API

```typescript
// index.ts

// 主要导出
export { AgentManager } from './manager'
export type {
  AgentConfig,
  AgentMode,
  ToolsConfig,
  PermissionConfig,
  RuntimeAgent,
  SubagentExecuteParams,
  SubagentResult
} from './types'

// 内置代理名称常量
export const BUILTIN_AGENTS = ['build', 'plan', 'explore', 'research'] as const
```

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 4.1 并发控制在 Executor 层

**决策**：并发控制（最多 3 个子代理）在 SubagentExecutor 中实现，而非 AgentManager。

**理由**：
- SubagentExecutor 负责子代理执行，天然知道并发状态
- 符合单一职责原则
- AgentManager 只负责配置管理，不关心执行状态

**代价**：
- 如果未来需要更复杂的并发策略（如优先级队列），需要修改 Executor

### 4.2 同名配置完全替换

**决策**：用户配置与内置配置同名时，用户配置完全替换内置配置（非深度合并）。

**理由**：
- 语义更清晰：用户配置覆盖内置
- 避免深度合并的复杂性和不可预测性
- 用户可以完整控制自定义 Agent

**代价**：
- 用户无法只修改内置 Agent 的部分字段
- 如需修改内置 Agent，需要复制完整配置

**缓解措施**：
- 提供清晰的内置 Agent 配置文档
- 未来可考虑提供 `extends` 机制

### 4.3 子代理独立 Session

**决策**：子代理在独立 Session 中运行。

**理由**：
- 上下文完全隔离，避免干扰
- 便于查看和调试子代理历史
- 支持子代理恢复（通过 session_id）

**代价**：
- 增加 Session 存储开销
- 需要清理长期未使用的子 Session

### 4.4 子代理禁用特定工具

**决策**：子代理硬编码禁用 task、todowrite、todoread 工具。

**理由**：
- 防止递归创建子代理
- 子代理不需要任务管理能力
- 简化实现，降低风险

**代价**：
- 灵活性降低
- 未来如需调整需修改代码

### 4.5 格式验证与业务验证分离

**决策**：格式验证由 config/agents 模块负责，业务验证由 agents 模块负责。

**理由**：
- config/agents 使用 Zod Schema，天然适合格式验证
- 业务验证（如工具存在性）需要运行时信息
- 职责清晰，易于维护

**代价**：
- 验证分散在两个模块
- 错误信息来源可能不一致

**缓解措施**：
- 两个模块的错误类型统一命名规范
- 错误信息包含足够的上下文

---

## 五、关键实现说明

### 5.1 配置加载流程

```
1. AgentRegistry.initialize()
   │
   ├── 1. 加载内置代理 (builtin/*.ts)
   │       → Map<string, AgentConfig>
   │
   ├── 2. 调用 config/agents.loadAgentConfig()
   │       → AgentsConfig { agents: Record<string, AgentConfig> }
   │
   ├── 3. 合并配置
   │       ├── 遍历内置代理，注册到 Map
   │       └── 遍历用户配置
   │           ├── disabled=true: 从 Map 删除
   │           └── disabled=false: 覆盖 Map 中同名配置
   │
   └── 4. 业务验证
           ├── 验证工具存在性
           ├── 验证模型可用性
           └── 验证权限格式
```

### 5.2 运行时代理组装流程

```
1. AgentManager.getRuntimeAgent(agentName)
   │
   ├── 1. 获取 Agent 配置
   │       AgentRegistry.get(agentName)
   │
   ├── 2. 获取系统提示词
   │       SystemPrompt.getAgentPrompt(agentName)
   │
   ├── 3. 计算可用工具
   │       resolveAvailableTools(config.tools)
   │
   ├── 4. 合并 LLM 参数
   │       resolveLlmParams(config, globalLlmConfig)
   │
   └── 5. 返回 RuntimeAgent
           {
             config,
             systemPrompt,
             availableTools,
             llmParams
           }
```

### 5.3 子代理执行流程

```
1. SubagentExecutor.execute(params)
   │
   ├── 1. 检查并发数 (< MAX_CONCURRENT_SUBAGENTS)
   │
   ├── 2. 获取并验证子代理配置
   │       ├── AgentRegistry.get(agentName)
   │       └── 验证 mode !== 'primary'
   │
   ├── 3. 创建子 Session
   │       Session.create({ parentId: parentSessionId })
   │
   ├── 4. 组装运行时代理
   │       AgentManager.getRuntimeAgent(agentName)
   │
   ├── 5. 应用子代理工具限制
   │       禁用 task, todowrite, todoread
   │
   ├── 6. 执行 Lifecycle
   │       Lifecycle.run(runtimeAgent, session)
   │
   └── 7. 返回 SubagentResult
```

### 5.4 LLM 参数合并流程

```
1. resolveLlmParams(agentConfig)
   │
   ├── 1. 获取全局 LLM 配置
   │       config/llm.getLlmConfig()
   │
   └── 2. 合并参数（Agent 配置优先）
           {
             model: agentConfig.model ?? globalConfig.model,
             temperature: agentConfig.temperature ?? globalConfig.temperature,
             topP: agentConfig.topP ?? globalConfig.topP,
             maxTokens: agentConfig.maxTokens ?? globalConfig.maxTokens
           }
```

---

## 六、与其他模块的依赖关系

### 6.1 依赖的模块

| 模块 | 依赖类型 | 用途 |
|------|----------|------|
| config/agents | 直接依赖 | 加载用户配置 |
| config/llm | 直接依赖 | 获取 LLM 参数默认值 |
| system-prompt | 直接依赖 | 获取系统提示词 |
| session | 直接依赖 | 创建子代理 Session |
| lifecycle | 直接依赖 | 执行子代理循环 |

### 6.2 被依赖的模块

| 模块 | 依赖类型 | 用途 |
|------|----------|------|
| lifecycle | 直接依赖 | 获取 Agent 配置和 maxSteps |
| tool-scheduler | 直接依赖 | 获取可用工具列表 |
| TUI | 直接依赖 | 显示 Agent 列表和状态 |

---

## 七、文档自检

- [x] 可以清楚说出每个子组件存在的理由
- [x] 不存在无法追溯到 goals-duty.md 的结构
- [x] 没有为了"优雅"而增加的复杂性
- [x] 设计模式的使用有明确理由
- [x] 约束与权衡已明确记录
- [x] 与 config/agents 模块的依赖关系清晰
- [x] 配置与提示词分离的设计理由明确
