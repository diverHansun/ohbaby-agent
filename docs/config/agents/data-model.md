# config/agents 模块 data-model.md

> **状态：部分过时。** 本文中的 agent 配置结构仍可作为历史设计参考；其中 `timeout` 只保留为旧配置字段，不会作为当前 subagent turn 的 runtime deadline。当前 deadline 真相源是 `subagent_run.timeout_ms` 与 `SessionSubagentHost`，默认和上限均为 2 小时；运行模型以 [`../../agents/2026-07-09-subagent-context`](../../agents/2026-07-09-subagent-context/README.md) 为准。

本文档定义 `config/agents` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 AgentConfig（Agent 配置）

表示单个 Agent 的完整配置信息，包含基本信息、显示配置、执行配置、模型参数、工具配置和权限配置。

本质：Value Object（值对象），配置加载后不可变。

### 1.2 AgentsConfig（完整配置对象）

表示从配置文件加载的完整配置结构，包含多个 Agent 的配置集合。

本质：Value Object，作为 loadAgentConfig() 的返回值。

### 1.3 AgentMode（代理模式）

定义 Agent 的使用场景，决定 Agent 是作为主代理、子代理还是两者皆可。

### 1.4 PermissionValue（权限值）

定义权限的三种状态：允许、拒绝、询问用户。

---

## 二、Data Types（数据类型）

### 2.1 枚举类型

```typescript
/** 代理模式 */
type AgentMode = 'primary' | 'subagent' | 'all'

/** 权限值 */
type PermissionValue = 'allow' | 'deny' | 'ask'
```

### 2.2 AgentConfig 类型

```typescript
/** 单个 Agent 的配置 */
interface AgentConfig {
  // ==================== 基本信息 ====================

  /**
   * Agent 名称（必需，唯一标识）
   * 与内置 agent 同名时会覆盖内置配置
   */
  name: string

  /**
   * Agent 描述
   * - 主代理：可选，用于 UI 展示
   * - 子代理：必填，用于 Task 工具向 LLM 解释子代理能力
   */
  description?: string

  /**
   * Agent 模式
   * - primary: 主代理，用户直接交互
   * - subagent: 子代理，通过 Task 工具调用
   * - all: 两者皆可
   */
  mode: AgentMode

  // ==================== 显示配置 ====================

  /**
   * 是否在 UI 中隐藏
   * 用于内部子代理（如自动化测试、代码格式化等）
   * 默认：false
   */
  hidden?: boolean

  /**
   * 是否为默认主代理
   * 仅 primary 或 all 模式有效
   * 多个设为 true 时，取第一个
   * 默认：false
   */
  default?: boolean

  /**
   * UI 显示颜色
   * 格式：十六进制（如 "#FF5733"）
   * 用于 TUI 中区分不同 agent
   */
  color?: string

  /**
   * 是否禁用此 agent
   * 禁用后不会出现在 agent 列表中，也无法调用
   * 默认：false
   */
  disabled?: boolean

  // ==================== 执行配置 ====================

  /**
   * 最大执行步数
   *
   * 默认值：
   * - 主代理（primary）：50
   * - 子代理（subagent）：20
   *
   * 用途：防止无限循环，控制成本
   * 由 lifecycle 模块控制，达到 maxSteps 时强制停止
   */
  maxSteps?: number

  /**
   * 旧配置字段（毫秒）。
   *
   * 当前 runtime 不读取它作为 subagent turn deadline。应通过
   * subagent_run.timeout_ms 设置单轮覆盖；未设置时 SessionSubagentHost
   * 使用 7200000（2 小时）的实例默认值和上限。
   */
  timeout?: number

  /**
   * 是否允许 doom loop（循环检测）
   * 当检测到重复的工具调用模式时是否继续执行
   *
   * 默认：false（检测到 doom loop 时会警告并中止）
   */
  allowDoomLoop?: boolean

  // ==================== 模型参数（可选覆盖全局配置） ====================

  /**
   * 指定使用的模型
   *
   * 格式：providerID/modelID（如 "anthropic/claude-sonnet-4.5"）
   *
   * 未设置时，使用 config/llm 的全局模型
   * 用户通过 /model 切换时，不会影响指定了 model 的 agent
   */
  model?: string

  /**
   * 温度参数（覆盖全局配置）
   * 范围：0.0 - 2.0
   *
   * 未设置时，继承 model.json 中的 temperature
   */
  temperature?: number

  /**
   * Top-P 参数（覆盖全局配置）
   * 范围：0.0 - 1.0
   *
   * 未设置时，继承 model.json 中的 topP
   */
  topP?: number

  /**
   * Max tokens（覆盖全局配置）
   * 单次响应的最大 token 数
   *
   * 未设置时，继承 model.json 中的 maxTokens
   */
  maxTokens?: number

  // ==================== 工具配置 ====================

  /**
   * 工具启用配置
   *
   * 优先级：exclude > include > 默认工具集
   *
   * 特殊规则：
   * - 子代理自动禁用：task 和 agent 控制工具（防止递归）
   * - todo 工具按 agent 配置启用，可用于子代理自己的 session 计划
   * - 主代理自动启用：task（用于调用子代理）
   */
  tools?: ToolsConfig

  // ==================== 权限配置 ====================

  /**
   * 权限配置
   *
   * 优先级：Agent 配置 > Policy 模式配置 > Policy 默认配置
   */
  permission?: PermissionConfig
}
```

### 2.3 ToolsConfig 类型

```typescript
/** 工具配置 */
interface ToolsConfig {
  /**
   * 工具白名单
   * 只启用列表中的工具，其他工具禁用
   */
  include?: string[]

  /**
   * 工具黑名单
   * 禁用列表中的工具，其他工具启用
   */
  exclude?: string[]
}
```

### 2.4 PermissionConfig 类型

```typescript
/** 权限配置 */
interface PermissionConfig {
  /**
   * 文件编辑权限
   * - allow: 直接允许
   * - deny: 直接拒绝
   * - ask: 询问用户
   */
  edit?: PermissionValue

  /**
   * Bash 命令权限
   *
   * 格式1：统一权限
   * "bash": "deny"
   *
   * 格式2：通配符匹配
   * "bash": {
   *   "git *": "allow",
   *   "npm *": "ask",
   *   "rm -rf *": "deny",
   *   "*": "ask"
   * }
   */
  bash?: PermissionValue | Record<string, PermissionValue>

  /**
   * Web 请求权限
   */
  web?: PermissionValue

  /**
   * MCP 工具权限
   */
  mcp?: PermissionValue

  /**
   * 外部目录访问权限
   * 访问工作区外的目录时的权限
   */
  externalDirectory?: PermissionValue

  /**
   * Doom loop 权限
   * 检测到循环时是否允许继续执行
   */
  doomLoop?: PermissionValue

  /**
   * 关键操作配置
   *
   * 关键操作即使在 edit-automatically 模式下仍需要 HITL 确认
   * 这些操作始终返回 ASK 决策
   *
   * 默认关键操作（内置，无需配置）：
   * - git push / git push -f / git push --force
   * - git reset --hard
   * - rm -rf / rm -r -f
   * - 访问项目根目录外的路径（external_directory）
   *
   * 可通过此配置扩展或覆盖默认关键操作
   */
  critical?: CriticalOperationsConfig
}

/** 关键操作配置 */
interface CriticalOperationsConfig {
  /**
   * 额外的关键 bash 命令模式
   * 使用通配符匹配
   *
   * 示例：["docker rm *", "kubectl delete *"]
   */
  bashPatterns?: string[]

  /**
   * 是否禁用默认关键操作检查
   * 默认：false
   *
   * 警告：禁用可能导致危险操作被自动执行
   */
  disableDefaults?: boolean
}
```

### 2.5 AgentsConfig 类型

```typescript
/** 完整配置对象 */
interface AgentsConfig {
  agents: Record<string, AgentConfig>
}
```

---

## 三、Zod Schema Definitions（Schema 定义）

### 3.1 基础 Schema

```typescript
import { z } from 'zod'

// 代理模式 Schema
export const AgentModeSchema = z.enum(['primary', 'subagent', 'all'])

// 权限值 Schema
export const PermissionValueSchema = z.enum(['allow', 'deny', 'ask'])

// 十六进制颜色 Schema
export const HexColorSchema = z.string().regex(
  /^#[0-9a-fA-F]{6}$/,
  'Invalid hex color format (expected #RRGGBB)'
)

// 模型标识 Schema
export const ModelIdSchema = z.string().regex(
  /^[a-z0-9-]+\/[a-z0-9-]+$/i,
  'Invalid model ID format (expected providerID/modelID)'
)
```

### 3.2 工具配置 Schema

```typescript
export const ToolsConfigSchema = z.object({
  include: z.array(z.string()).optional()
    .describe('Tool whitelist - only enable these tools'),
  exclude: z.array(z.string()).optional()
    .describe('Tool blacklist - disable these tools'),
}).strict()
```

### 3.3 权限配置 Schema

```typescript
// 关键操作配置 Schema
export const CriticalOperationsConfigSchema = z.object({
  bashPatterns: z.array(z.string()).optional()
    .describe('Additional critical bash command patterns'),
  disableDefaults: z.boolean().optional().default(false)
    .describe('Disable default critical operation checks (dangerous)'),
}).strict()

export const PermissionConfigSchema = z.object({
  edit: PermissionValueSchema.optional(),
  bash: z.union([
    PermissionValueSchema,
    z.record(z.string(), PermissionValueSchema)
  ]).optional(),
  web: PermissionValueSchema.optional(),
  mcp: PermissionValueSchema.optional(),
  externalDirectory: PermissionValueSchema.optional(),
  doomLoop: PermissionValueSchema.optional(),
  critical: CriticalOperationsConfigSchema.optional(),
}).strict()
```

### 3.4 AgentConfig Schema

```typescript
export const AgentConfigSchema = z.object({
  // 基本信息
  name: z.string().min(1).describe('Agent name'),
  description: z.string().optional().describe('Agent description'),
  mode: AgentModeSchema.describe('Agent mode'),

  // 显示配置
  hidden: z.boolean().optional().default(false),
  default: z.boolean().optional().default(false),
  color: HexColorSchema.optional(),
  disabled: z.boolean().optional().default(false),

  // 执行配置
  maxSteps: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
  allowDoomLoop: z.boolean().optional().default(false),

  // 模型参数
  model: ModelIdSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),

  // 工具配置
  tools: ToolsConfigSchema.optional(),

  // 权限配置
  permission: PermissionConfigSchema.optional(),
}).strict().refine(
  (data) => data.mode !== 'subagent' || data.description,
  {
    message: 'Subagent must have a description',
    path: ['description'],
  }
)

export type AgentConfig = z.infer<typeof AgentConfigSchema>
```

### 3.5 AgentsConfig Schema

```typescript
export const AgentsConfigSchema = z.object({
  agents: z.record(z.string(), AgentConfigSchema),
}).strict()

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>
```

---

## 四、Field Definitions（字段说明表格）

### 4.1 基本信息字段

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| name | string | 是 | - | Agent 唯一标识名称 |
| description | string | 子代理必需 | undefined | Agent 描述（子代理必填） |
| mode | AgentMode | 是 | - | 代理模式 |

### 4.2 显示配置字段

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| hidden | boolean | 否 | false | 是否在 UI 中隐藏 |
| default | boolean | 否 | false | 是否为默认主代理 |
| color | string | 否 | undefined | UI 显示颜色（十六进制） |
| disabled | boolean | 否 | false | 是否禁用此 agent |

### 4.3 执行配置字段

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| maxSteps | number | 否 | 主代理50/子代理20 | 最大执行步数 |
| timeout | number | 否 | 无 runtime 默认值 | 旧配置字段；当前 subagent deadline 由 `subagent_run.timeout_ms`/host 管理 |
| allowDoomLoop | boolean | 否 | false | 是否允许循环检测 |

### 4.4 模型参数字段

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| model | string | 否 | 继承全局 | 指定模型（providerID/modelID） |
| temperature | number | 否 | 继承全局 | 温度参数（0.0-2.0） |
| topP | number | 否 | 继承全局 | Top-P 参数（0.0-1.0） |
| maxTokens | number | 否 | 继承全局 | 最大响应 token 数 |

### 4.5 工具配置字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| tools.include | string[] | 否 | 工具白名单 |
| tools.exclude | string[] | 否 | 工具黑名单 |

### 4.6 权限配置字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| permission.edit | PermissionValue | 否 | 文件编辑权限 |
| permission.bash | PermissionValue 或 Record | 否 | Bash 命令权限 |
| permission.web | PermissionValue | 否 | Web 请求权限 |
| permission.externalDirectory | PermissionValue | 否 | 外部目录访问权限 |
| permission.doomLoop | PermissionValue | 否 | Doom loop 权限 |
| permission.critical | CriticalOperationsConfig | 否 | 关键操作配置 |
| permission.critical.bashPatterns | string[] | 否 | 额外的关键 bash 命令模式 |
| permission.critical.disableDefaults | boolean | 否 | 禁用默认关键操作检查（危险） |

---

## 五、Configuration Examples（配置示例）

### 5.1 覆盖内置 explore agent

```json
{
  "agents": {
    "explore": {
      "name": "explore",
      "mode": "subagent",
      "description": "Enhanced codebase exploration with web search",
      "model": "anthropic/claude-haiku-4",
      "maxSteps": 15,
      "temperature": 0.5,
      "tools": {
        "include": ["read", "grep", "glob", "web-search"]
      },
      "permission": {
        "edit": "deny",
        "bash": "deny",
        "web": "allow"
      }
    }
  }
}
```

### 5.2 自定义主代理

```json
{
  "agents": {
    "code-reviewer": {
      "name": "code-reviewer",
      "mode": "primary",
      "description": "Specialized code review agent",
      "color": "#FF5733",
      "maxSteps": 30,
      "temperature": 0.3,
      "tools": {
        "include": ["read", "grep", "glob", "web-search"],
        "exclude": ["write", "edit", "bash"]
      },
      "permission": {
        "edit": "deny",
        "bash": "deny",
        "web": "allow"
      }
    }
  }
}
```

### 5.3 自定义子代理

```json
{
  "agents": {
    "security-scanner": {
      "name": "security-scanner",
      "mode": "subagent",
      "description": "Scans code for security vulnerabilities (OWASP Top 10)",
      "color": "#DC3545",
      "maxSteps": 20,
      "temperature": 0.3,
      "tools": {
        "include": ["read", "grep", "glob"]
      },
      "permission": {
        "edit": "deny",
        "bash": "deny",
        "web": "ask",
        "mcp": "deny"
      }
    }
  }
}
```

### 5.4 带通配符的 bash 权限

```json
{
  "agents": {
    "build": {
      "name": "build",
      "mode": "primary",
      "description": "Full-featured development agent with restricted bash",
      "default": true,
      "color": "#00A67E",
      "maxSteps": 50,
      "permission": {
        "edit": "ask",
        "bash": {
          "git *": "allow",
          "npm *": "ask",
          "rm -rf *": "deny",
          "*": "ask"
        },
        "web": "ask",
        "mcp": "ask"
      }
    }
  }
}
```

### 5.5 禁用内置 agent

```json
{
  "agents": {
    "research": {
      "name": "research",
      "mode": "subagent",
      "disabled": true
    }
  }
}
```

### 5.6 带关键操作配置的 agent

```json
{
  "agents": {
    "devops": {
      "name": "devops",
      "mode": "primary",
      "description": "DevOps agent with extended critical operations",
      "color": "#FF9800",
      "maxSteps": 50,
      "permission": {
        "edit": "ask",
        "bash": {
          "git *": "allow",
          "docker *": "ask",
          "kubectl *": "ask",
          "*": "ask"
        },
        "critical": {
          "bashPatterns": [
            "docker rm *",
            "docker rmi *",
            "kubectl delete *",
            "terraform destroy *"
          ]
        }
      }
    }
  }
}
```

**说明**：
- `bashPatterns` 中的命令即使在 edit-automatically 模式下仍需要确认
- 这些命令会与默认关键操作（git push、rm -rf 等）一起检查

---

## 六、文档自检

- [x] 所有概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 每个概念在架构或数据流中都有使用场景
- [x] Schema 定义与类型定义保持一致
- [x] 配置示例覆盖常见使用场景
