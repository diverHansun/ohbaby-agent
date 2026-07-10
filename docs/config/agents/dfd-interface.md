# config/agents 模块 dfd-interface.md

> **状态：部分过时。** 本文曾列出的 config 层 subagent timeout 常量不是当前源码导出，也不是 runtime deadline 真相源。当前 deadline 由 `SessionSubagentHost` 管理，默认与最大值均为 2 小时；调用与恢复语义以 [`../../agents/2026-07-09-subagent-context`](../../agents/2026-07-09-subagent-context/README.md) 为准。

本文档描述 `config/agents` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

config/agents 模块在系统中的位置：

```
文件系统（配置文件）
     |
     v
config/agents 模块 <-- 本文档讨论范围
     |
     v
agents 模块（业务层）
```

### 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| 文件系统 | 输入 | 读取 settings.json 配置文件 |
| agents 模块 | 输出 | 提供验证后的配置数据 |

### 讨论范围

本文档仅讨论：
- 配置文件的读取流程
- 配置的验证和合并逻辑
- 对外提供的接口

不讨论：
- agents 模块如何使用配置
- 系统提示词的组装
- Agent 的执行逻辑

---

## 二、Data Flow Description（数据流描述）

### 2.1 主数据流：配置加载

```
1. agents 模块调用 loadAgentConfig()
   |
   v
2. config/agents 模块确定配置文件路径
   - 全局：~/.ohbaby-agent/agents/settings.json
   - 项目：{project}/.ohbaby-agent/agents/settings.json
   |
   v
3. 从文件系统读取全局配置文件
   - 文件存在：读取并解析 JSON
   - 文件不存在：使用空配置 { agents: {} }
   |
   v
4. 从文件系统读取项目配置文件
   - 文件存在：读取并解析 JSON
   - 文件不存在：使用空配置 { agents: {} }
   |
   v
5. 合并配置（项目覆盖全局）
   - 同名 Agent：项目配置完全替换全局配置
   - 不同名 Agent：合并到同一集合
   |
   v
6. Zod Schema 验证合并后的配置
   - 验证通过：继续
   - 验证失败：抛出 ConfigValidationError
   |
   v
7. 返回 AgentsConfig 对象给 agents 模块
```

### 2.2 错误数据流

```
配置加载过程中可能发生的错误：

1. JSON 解析失败
   |
   v
   抛出 ConfigParseError
   - 包含：文件路径、解析错误位置、原始错误信息

2. Schema 验证失败
   |
   v
   抛出 ConfigValidationError
   - 包含：文件路径、失败字段路径、期望类型、实际值

3. 文件读取权限错误
   |
   v
   抛出 ConfigAccessError
   - 包含：文件路径、系统错误信息
```

---

## 三、Interface Definition（接口定义）

### 3.1 公共接口

#### loadAgentConfig()

主入口函数，加载并返回完整的 Agent 配置。

```typescript
/**
 * 加载 Agent 配置
 *
 * 从全局和项目配置文件加载配置，合并后返回。
 * 项目配置覆盖全局配置（同名 Agent 完全替换）。
 *
 * @returns 验证后的完整配置对象
 * @throws ConfigParseError JSON 解析失败
 * @throws ConfigValidationError Schema 验证失败
 * @throws ConfigAccessError 文件读取权限错误
 */
export async function loadAgentConfig(): Promise<AgentsConfig>
```

**数据流映射**：对应主数据流步骤 1-7

**调用场景**：
- agents 模块启动时初始化
- 用户请求刷新配置时

### 3.2 类型导出

```typescript
// 配置类型
export type { AgentConfig } from './types.js'
export type { AgentsConfig } from './types.js'
export type { AgentMode } from './types.js'
export type { PermissionValue } from './types.js'
export type { ToolsConfig } from './types.js'
export type { PermissionConfig } from './types.js'

// Schema 导出（供测试或高级用户使用）
export { AgentConfigSchema } from './types.js'
export { AgentsConfigSchema } from './types.js'
```

### 3.3 运行时 timeout 边界

当前 `config/agents` 不导出 primary/subagent 的 runtime timeout 常量。历史文档中的
`DEFAULT_SUBAGENT_TIMEOUT = 180000` 已失效，不能作为实现或测试依据。

subagent 的 deadline 只由运行时决定：`subagent_run.timeout_ms` 可为单轮覆盖，
`SessionSubagentHost` 在未设置时使用 `7200000`（2 小时），并拒绝更大的值。
配置路径等静态信息应以实际 `config/agents` 源码为准。

---

## 四、Internal Functions（内部函数）

这些函数不对外导出，仅在模块内部使用。

### 4.1 loadFromPath

```typescript
/**
 * 从指定路径加载单个配置文件
 *
 * @param filepath 配置文件绝对路径
 * @returns 配置对象，如果文件不存在返回空配置
 * @throws ConfigParseError JSON 解析失败
 */
async function loadFromPath(filepath: string): Promise<AgentsConfig>
```

实现逻辑：
```typescript
async function loadFromPath(filepath: string): Promise<AgentsConfig> {
  // 1. 检查文件是否存在
  if (!await fileExists(filepath)) {
    return { agents: {} }
  }

  // 2. 读取文件内容
  const content = await readFile(filepath, 'utf-8')

  // 3. 解析 JSON
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new ConfigParseError({
      path: filepath,
      message: error.message,
      position: extractPosition(error)
    })
  }
}
```

### 4.2 mergeConfigs

```typescript
/**
 * 合并多个配置对象
 *
 * @param global 全局配置
 * @param project 项目配置
 * @returns 合并后的配置
 */
function mergeConfigs(
  global: AgentsConfig,
  project: AgentsConfig
): AgentsConfig
```

实现逻辑：
```typescript
function mergeConfigs(
  global: AgentsConfig,
  project: AgentsConfig
): AgentsConfig {
  return {
    agents: {
      ...global.agents,
      ...project.agents  // 项目配置完全覆盖同名 Agent
    }
  }
}
```

### 4.3 validateConfig

```typescript
/**
 * 验证配置对象
 *
 * @param config 待验证的配置
 * @param sourcePath 配置来源路径（用于错误信息）
 * @returns 验证后的配置
 * @throws ConfigValidationError 验证失败
 */
function validateConfig(
  config: unknown,
  sourcePath: string
): AgentsConfig
```

实现逻辑：
```typescript
function validateConfig(
  config: unknown,
  sourcePath: string
): AgentsConfig {
  const result = AgentsConfigSchema.safeParse(config)

  if (!result.success) {
    throw new ConfigValidationError({
      path: sourcePath,
      issues: result.error.issues
    })
  }

  return result.data
}
```

---

## 五、Integration with agents Module（与 agents 模块集成）

### 5.1 调用方式

```typescript
// agents 模块中使用
import { loadAgentConfig } from '@/config/agents'

class AgentRegistry {
  private agents: Map<string, AgentConfig>

  async initialize(): Promise<void> {
    // 1. 加载内置 agents
    const builtinAgents = this.loadBuiltinAgents()

    // 2. 加载用户配置
    const userConfig = await loadAgentConfig()

    // 3. 合并（用户配置覆盖内置）
    this.agents = new Map()

    for (const [name, config] of Object.entries(builtinAgents)) {
      this.agents.set(name, config)
    }

    for (const [name, config] of Object.entries(userConfig.agents)) {
      if (!config.disabled) {
        this.agents.set(name, config)
      }
    }

    // 4. 业务验证（工具存在性、权限合法性等）
    this.validateBusinessRules()
  }
}
```

### 5.2 数据流向

```
config/agents 模块
   | loadAgentConfig()
   v
AgentsConfig 对象
   | 传递给
   v
agents 模块
   | 遍历 config.agents
   v
与内置 agents 合并
   | 用户配置覆盖内置
   v
存储到 AgentRegistry
```

---

## 六、Configuration File Locations（配置文件位置）

### 6.1 全局配置

路径：`~/.ohbaby-agent/agents/settings.json`

用途：
- 用户级别的默认 Agent 配置
- 跨项目共享的自定义 Agent

示例：
```json
{
  "agents": {
    "security-scanner": {
      "name": "security-scanner",
      "mode": "subagent",
      "description": "Scans code for security vulnerabilities",
      "maxSteps": 20,
      "tools": {
        "include": ["read", "grep", "glob"]
      }
    }
  }
}
```

### 6.2 项目配置

路径：`{project}/.ohbaby-agent/agents/settings.json`

用途：
- 项目特定的 Agent 配置
- 覆盖全局配置的 Agent 设置
- 项目专属的自定义 Agent

示例：
```json
{
  "agents": {
    "build": {
      "name": "build",
      "mode": "primary",
      "description": "Project-specific build agent",
      "maxSteps": 40,
      "permission": {
        "bash": {
          "npm *": "allow",
          "git *": "allow",
          "*": "ask"
        }
      }
    }
  }
}
```

### 6.3 合并结果示例

全局配置：
```json
{
  "agents": {
    "explore": { "maxSteps": 15, "temperature": 0.5 },
    "security-scanner": { "maxSteps": 20 }
  }
}
```

项目配置：
```json
{
  "agents": {
    "explore": { "maxSteps": 25 }
  }
}
```

合并结果：
```json
{
  "agents": {
    "explore": { "maxSteps": 25 },
    "security-scanner": { "maxSteps": 20 }
  }
}
```

注意：`explore` 的 `temperature` 字段被丢弃，因为项目配置完全替换全局配置。

---

## 七、Error Types（错误类型）

### 7.1 ConfigParseError

```typescript
class ConfigParseError extends Error {
  constructor(
    public readonly path: string,
    public readonly position?: { line: number; column: number },
    public readonly originalError: Error
  ) {
    super(`Failed to parse config file: ${path}`)
  }
}
```

### 7.2 ConfigValidationError

```typescript
class ConfigValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: ZodIssue[]
  ) {
    super(`Invalid config at ${path}: ${formatIssues(issues)}`)
  }
}
```

### 7.3 ConfigAccessError

```typescript
class ConfigAccessError extends Error {
  constructor(
    public readonly path: string,
    public readonly originalError: Error
  ) {
    super(`Cannot access config file: ${path}`)
  }
}
```

---

## 八、Data Ownership & Responsibility（数据归属与责任）

### 配置数据的责任边界

| 数据 | 创建者 | 所有者 | 更新者 | 销毁者 |
|------|--------|--------|--------|--------|
| settings.json 文件 | 用户 | 用户 | 用户 | 用户 |
| AgentsConfig 对象 | config/agents | agents 模块 | - | agents 模块 |

### 责任划分

- **config/agents 模块负责**：
  - 读取配置文件
  - 解析 JSON
  - 验证格式
  - 合并配置
  - 返回类型安全的对象

- **agents 模块负责**：
  - 缓存配置（如需要）
  - 业务验证（工具存在性等）
  - 与内置 agents 合并
  - 配置的生命周期管理

- **用户负责**：
  - 创建和维护配置文件
  - 确保配置内容正确

---

## 九、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 错误处理流程明确
- [x] 与 agents 模块的集成方式清晰
