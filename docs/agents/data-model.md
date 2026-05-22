# agents 模块 data-model.md

本文档定义 `agents` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 AgentMode（代理模式）

代理模式决定了代理的使用场景和调用方式。

| 模式 | 说明 | 调用方式 |
|------|------|----------|
| `primary` | 主代理 | 用户直接交互 |
| `subagent` | 子代理 | 被主代理通过 Task 工具调用 |
| `all` | 两者皆可 | 可直接交互，也可作为子代理 |

### 1.2 AgentConfig（代理配置）

代理配置是 agents 模块的核心数据结构，定义了代理的所有属性。

配置来源：
- **内置配置**：代码中定义的内置代理（build、plan、explore、research）
- **用户配置**：通过 config/agents 模块从配置文件加载

**主代理 vs 子代理的配置差异**：

| 字段 | 主代理 | 子代理 |
|------|--------|--------|
| `description` | 可选（用于 UI 展示） | **必填**（给 Task 工具描述子代理能力） |
| `maxSteps` | 较大（默认 50） | 较小（默认 20） |
| `timeout` | 较长（默认 5 分钟） | 较短（默认 3 分钟） |
| `tools.task` | 自动启用 | **自动禁用**（防止递归） |
| `tools.todowrite` | 启用 | 按 agent 配置启用 |
| `tools.todoread` | 启用 | 按 agent 配置启用 |

### 1.3 SubagentResult（子代理执行结果）

子代理执行完成后返回的结果，包含执行状态和输出内容。

### 1.4 配置与提示词的分离

agents 模块使用两种不同的数据来源：

| 数据类型 | 来源 | 说明 |
|----------|------|------|
| 配置数据 | config/agents 模块 | JSON 格式，定义代理行为参数 |
| 系统提示词 | system-prompt 模块 | Markdown/代码，定义代理对话风格 |

agents 模块负责将两者组装成完整的代理实例。

---

## 二、Data Types（数据类型）

### 2.1 枚举类型

```typescript
/** 代理模式 */
type AgentMode = 'primary' | 'subagent' | 'all'

/** 权限决策 */
type PermissionValue = 'allow' | 'deny' | 'ask'
```

### 2.2 代理配置类型

```typescript
/** 代理配置（从 config/agents 加载或内置定义） */
interface AgentConfig {
  // ==================== 基本信息 ====================

  /** 唯一标识名称 */
  name: string

  /**
   * 代理描述
   * - 主代理：可选，用于 UI 展示
   * - 子代理：必填，用于 Task 工具向 LLM 解释子代理能力
   */
  description?: string

  /** 代理模式 */
  mode: AgentMode

  // ==================== 显示配置 ====================

  /** 是否在 UI 中隐藏 */
  hidden?: boolean

  /** 是否为默认主代理 */
  default?: boolean

  /** UI 颜色标识（十六进制，如 #FF5733） */
  color?: string

  /** 是否禁用此代理 */
  disabled?: boolean

  // ==================== 执行配置 ====================

  /** 最大执行步数（由 lifecycle 模块控制） */
  maxSteps?: number

  /** 超时时间（毫秒） */
  timeout?: number

  /** 是否允许 doom loop */
  allowDoomLoop?: boolean

  // ==================== 模型参数（可选覆盖） ====================

  /**
   * 指定使用的模型
   * 格式：providerID/modelID（如 "anthropic/claude-sonnet-4.5"）
   * 未设置时：使用 config/llm 的全局配置
   */
  model?: string

  /**
   * 温度参数（覆盖 config/llm 配置）
   * 范围：0.0 - 2.0
   */
  temperature?: number

  /**
   * Top-P 参数（覆盖 config/llm 配置）
   * 范围：0.0 - 1.0
   */
  topP?: number

  /**
   * 最大响应 token 数（覆盖 config/llm 配置）
   */
  maxTokens?: number

  // ==================== 工具配置 ====================

  /**
   * 工具启用配置
   * 优先级：exclude > include > 默认工具集
   */
  tools?: ToolsConfig

  // ==================== 权限配置 ====================

  /**
   * 权限配置
   * 优先级：Agent 配置 > Policy 模式配置 > Policy 默认配置
   */
  permission?: PermissionConfig
}

/** 工具配置 */
interface ToolsConfig {
  /** 工具白名单：只启用列表中的工具 */
  include?: string[]

  /** 工具黑名单：禁用列表中的工具 */
  exclude?: string[]
}

/** 权限配置 */
interface PermissionConfig {
  /** 文件编辑权限 */
  edit?: PermissionValue

  /**
   * Bash 命令权限
   * 格式1：统一权限，如 "deny"
   * 格式2：通配符匹配，如 { "git *": "allow", "*": "ask" }
   */
  bash?: PermissionValue | Record<string, PermissionValue>

  /** Web 请求权限 */
  web?: PermissionValue

  /** MCP 工具权限 */
  mcp?: PermissionValue

  /** 外部目录访问权限 */
  externalDirectory?: PermissionValue

  /** Doom loop 权限 */
  doomLoop?: PermissionValue
}
```

### 2.3 运行时代理类型

```typescript
/**
 * 运行时代理实例
 * 由 agents 模块组装配置和提示词后生成
 */
interface RuntimeAgent {
  /** 代理配置 */
  config: AgentConfig

  /**
   * 系统提示词
   * 由 system-prompt 模块提供，agents 模块组装
   */
  systemPrompt: string

  /**
   * 可用工具列表
   * 根据 tools 配置计算得出
   */
  availableTools: string[]

  /**
   * 有效的 LLM 参数
   * 合并 agent 配置和 config/llm 全局配置
   */
  llmParams: {
    model: string
    temperature: number
    topP: number
    maxTokens: number
  }
}
```

### 2.4 子代理执行类型

```typescript
/** 子代理执行参数 */
interface SubagentExecuteParams {
  /** 子代理名称 */
  agentName: string

  /** 父 Session ID */
  parentSessionId: string

  /** 任务提示 */
  prompt: string

  /** 任务描述（用于 Session 标题） */
  description?: string

  /** 恢复已有 Session（可选） */
  resumeSessionId?: string
}

/** 子代理执行结果 */
interface SubagentResult {
  /** 子 Session ID */
  sessionId: string

  /** 执行是否成功 */
  success: boolean

  /** 输出文本 */
  output: string

  /** 执行摘要 */
  summary: {
    /** 工具调用列表 */
    toolCalls: Array<{
      id: string
      tool: string
      status: 'completed' | 'error'
      title?: string
    }>
    /** 执行步数 */
    steps: number
    /** 执行耗时（毫秒） */
    duration: number
  }
}
```

### 2.5 事件类型

```typescript
/** Agent 变化事件 */
interface AgentChangedEvent {
  /** 之前的 Agent 名称 */
  previousAgent: string
  /** 当前的 Agent 名称 */
  currentAgent: string
}

/** 子代理开始事件 */
interface SubagentStartedEvent {
  /** 父 Session ID */
  parentSessionId: string
  /** 子 Session ID */
  childSessionId: string
  /** 子代理名称 */
  agentName: string
}

/** 子代理完成事件 */
interface SubagentCompletedEvent {
  /** 父 Session ID */
  parentSessionId: string
  /** 子 Session ID */
  childSessionId: string
  /** 子代理名称 */
  agentName: string
  /** 是否成功 */
  success: boolean
}
```

---

## 三、配置加载与合并

### 3.1 配置来源优先级

```
用户配置（config/agents）
    |
    v 用户配置覆盖同名内置
内置配置（代码定义）
    |
    v 合并成最终配置
AgentRegistry
```

### 3.2 合并规则

```typescript
class AgentRegistry {
  async initialize(): Promise<void> {
    // 1. 加载内置代理
    const builtinAgents = this.loadBuiltinAgents()

    // 2. 加载用户配置
    const userConfig = await loadAgentConfig()  // from config/agents

    // 3. 合并（用户配置覆盖内置）
    this.agents = new Map()

    // 先注册内置代理
    for (const [name, config] of Object.entries(builtinAgents)) {
      this.agents.set(name, config)
    }

    // 用户配置覆盖（同名完全替换）
    for (const [name, config] of Object.entries(userConfig.agents)) {
      if (!config.disabled) {
        this.agents.set(name, config)
      } else {
        // disabled 的 agent 从注册表移除
        this.agents.delete(name)
      }
    }

    // 4. 业务验证
    this.validateBusinessRules()
  }
}
```

### 3.3 LLM 参数合并

```typescript
function resolveLlmParams(agentConfig: AgentConfig): LlmParams {
  const globalConfig = getLlmConfig()  // from config/llm

  return {
    model: agentConfig.model ?? globalConfig.model,
    temperature: agentConfig.temperature ?? globalConfig.temperature,
    topP: agentConfig.topP ?? globalConfig.topP,
    maxTokens: agentConfig.maxTokens ?? globalConfig.maxTokens
  }
}
```

---

## 四、内置代理配置

### 4.1 build（全功能主代理）

```typescript
const BuildAgent: AgentConfig = {
  name: 'build',
  mode: 'primary',
  description: 'Full-featured development agent with all capabilities',
  default: true,
  color: '#00A67E',
  maxSteps: 50,
  timeout: 300000,
  tools: {
    // 使用默认工具集（不设置 include/exclude）
  },
  permission: {
    edit: 'allow',
    bash: { '*': 'allow' },
    web: 'allow',
    mcp: 'ask'
  }
}
```

### 4.2 plan（只读分析主代理）

```typescript
const PlanAgent: AgentConfig = {
  name: 'plan',
  mode: 'primary',
  description: 'Read-only agent for analysis and planning',
  color: '#4A90D9',
  maxSteps: 30,
  timeout: 300000,
  tools: {
    exclude: ['write', 'edit', 'notebookedit']
  },
  permission: {
    edit: 'deny',
    bash: {
      'git diff*': 'allow',
      'git log*': 'allow',
      'git status*': 'allow',
      'ls*': 'allow',
      '*': 'ask'
    },
    web: 'allow',
    mcp: 'ask'
  }
}
```

### 4.3 explore（代码探索子代理）

```typescript
const ExploreAgent: AgentConfig = {
  name: 'explore',
  mode: 'subagent',
  description: 'Fast agent for exploring codebases. Use for finding files, searching code, and analyzing project structure.',
  color: '#9B59B6',
  maxSteps: 15,
  timeout: 180000,
  tools: {
    include: ['glob', 'grep', 'read', 'memory_list']
  },
  permission: {
    edit: 'deny',
    bash: { '*': 'deny' },
    web: 'deny',
    mcp: 'deny'
  }
}
```

### 4.4 research（深度研究子代理）

```typescript
const ResearchAgent: AgentConfig = {
  name: 'research',
  mode: 'subagent',
  description: 'Deep research agent for complex multi-step tasks. Use for in-depth analysis, web search, and information synthesis.',
  color: '#E67E22',
  maxSteps: 30,
  timeout: 180000,
  tools: {
    include: ['webfetch', 'websearch', 'glob', 'grep', 'read', 'write', 'memory_list', 'memory_add', 'memory_update', 'memory_remove']
  },
  permission: {
    edit: 'allow',
    bash: { '*': 'ask' },
    web: 'allow',
    mcp: 'ask'
  }
}
```

---

## 五、Constants（常量定义）

### 5.1 默认值

```typescript
/** 默认代理名称 */
const DEFAULT_AGENT = 'build'

/** 主代理默认最大步数 */
const DEFAULT_PRIMARY_MAX_STEPS = 100

/** 子代理默认最大步数 */
const DEFAULT_SUBAGENT_MAX_STEPS = 60

/** 主代理默认超时时间（毫秒） */
const DEFAULT_PRIMARY_TIMEOUT = 600000  // 10 分钟

/** 子代理默认超时时间（毫秒） */
const DEFAULT_SUBAGENT_TIMEOUT = 600000  // 10 分钟

/** 最大并发子代理数 */
const MAX_CONCURRENT_SUBAGENTS = 6

/** 双击 Ctrl+C 的时间窗口（毫秒） */
const DOUBLE_CTRL_C_WINDOW = 500
```

### 5.2 内置代理列表

```typescript
/** 内置代理名称 */
const BUILTIN_AGENTS = ['build', 'plan', 'explore', 'research'] as const

/** 内置主代理 */
const BUILTIN_PRIMARY_AGENTS = ['build', 'plan'] as const

/** 内置子代理 */
const BUILTIN_SUBAGENTS = ['explore', 'research'] as const
```

### 5.3 子代理禁用工具

```typescript
/** 子代理固定禁用的工具（防止递归） */
const SUBAGENT_DISABLED_TOOLS = ['task', 'agent_open', 'agent_eval', 'agent_status', 'agent_close'] as const
```

---

## 六、Validation Rules（验证规则）

### 6.1 格式验证（config/agents 模块负责）

由 config/agents 模块使用 Zod Schema 验证：

| 字段 | 验证规则 |
|------|----------|
| `name` | 非空字符串 |
| `mode` | 枚举：'primary' / 'subagent' / 'all' |
| `description` | subagent 模式必填 |
| `color` | 十六进制格式（#RRGGBB） |
| `model` | 格式：providerID/modelID |
| `temperature` | 范围：0.0 - 2.0 |
| `topP` | 范围：0.0 - 1.0 |
| `maxSteps` | 正整数 |
| `timeout` | 正整数 |

### 6.2 业务验证（agents 模块负责）

agents 模块在配置加载后执行业务验证：

| 验证项 | 说明 |
|--------|------|
| 工具存在性 | tools.include/exclude 中的工具名必须存在 |
| 模型可用性 | model 指定的模型必须是可用的 |
| 权限合法性 | bash 通配符格式正确 |
| 子代理工具限制 | 子代理自动禁用 task/agent_* 递归控制工具；todo 按配置启用 |

### 6.3 名称验证

```typescript
const AGENT_NAME_REGEX = /^[a-z0-9-]+$/
const MAX_AGENT_NAME_LENGTH = 50

function validateAgentName(name: string): void {
  if (!AGENT_NAME_REGEX.test(name)) {
    throw new Error('Agent name must contain only lowercase letters, numbers, and hyphens')
  }
  if (name.length > MAX_AGENT_NAME_LENGTH) {
    throw new Error(`Agent name must be at most ${MAX_AGENT_NAME_LENGTH} characters`)
  }
}
```

---

## 七、与其他模块的数据交互

### 7.1 与 config/agents 模块

```typescript
// agents 模块导入 config/agents
import { loadAgentConfig, AgentsConfig } from '@/config/agents'

// 加载用户配置
const userConfig: AgentsConfig = await loadAgentConfig()
```

### 7.2 与 config/llm 模块

```typescript
// agents 模块导入 config/llm
import { getLlmConfig, LlmConfig } from '@/config/llm'

// 获取全局 LLM 配置作为默认值
const globalLlm: LlmConfig = getLlmConfig()
```

### 7.3 与 system-prompt 模块

```typescript
// agents 模块导入 system-prompt
import { getAgentPrompt } from '@/core/system-prompt'

// 获取代理的系统提示词
const systemPrompt: string = getAgentPrompt(agentName)
```

### 7.4 与 lifecycle 模块

```typescript
// lifecycle 模块使用 agents 配置
import { AgentConfig } from '@/agents'

// lifecycle 读取 maxSteps 控制循环
const maxSteps = agentConfig.maxSteps ?? DEFAULT_PRIMARY_MAX_STEPS

// 达到 maxSteps 时返回
if (currentStep >= maxSteps) {
  return { finishReason: 'maxSteps', /* ... */ }
}
```

---

## 八、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 内置代理配置明确
- [x] 验证规则清晰（区分格式验证和业务验证）
- [x] 与相关模块的数据交互说明完整
- [x] 配置与提示词的分离原则明确
