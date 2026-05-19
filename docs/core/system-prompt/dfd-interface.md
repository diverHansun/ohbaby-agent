# system-prompt 模块 dfd-interface.md

本文档描述 `system-prompt` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 1.1 模块位置

system-prompt 模块在 ohbaby-agent 系统中的位置：

```
                  +-------------+
                  |  Lifecycle  |
                  +------+------+
                         |
                         v
                  +-------------+
                  |    Agent    |
                  | (调用组装)   |
                  +------+------+
                         |
                         v
              +--------------------+
              |   System-Prompt    |
              | (提示词存储与组装) |
              +--------------------+
                    |         |
          +---------+         +---------+
          v                             v
    +----------+                  +----------+
    |  Config  |                  |   Tool   |
    | (路径)   |                  | (工具列表)|
    +----------+                  +----------+
```

### 1.2 交互模块

| 模块 | 交互方式 | 说明 |
|------|----------|------|
| **Agent** | 被调用 | Agent 调用 assemble() 获取系统提示词 |
| **Config** | 调用 | 获取 OHBABY.md 文件路径 |
| **Tool** | 调用 | 获取可用工具列表（用于环境信息） |
| **Lifecycle** | 间接 | 通过 Agent 模块间接使用 |

---

## 二、Data Flow Description（数据流描述）

### 2.1 主代理提示词组装数据流

```
1. Agent 模块请求主代理系统提示词
   |
   v
2. SystemPrompt.assemble({
     agentName: 'build',
     agentPrompt: '...',      // 可选：主代理 runtime prompt
     isSubagent: false,
     environment: {...},
     customInstructions: [...],
     tools: [...]
   })
   |
   +---> 判断 isSubagent === false
   |     --> 确认是主代理
   |
   +---> IdentityLayer.generate()
   |     --> 返回完整身份提示词（约 800 行）
   |
   +---> EnvironmentLayer.generate({
   |       info: environment,
   |       minimal: false,
   |       tools: [...]
   |     })
   |     --> 返回完整环境信息
   |
   +---> AgentLayer.generate(agentPrompt) [optional]
   |     --> 返回主代理 runtime prompt
   |
   +---> CustomLayer.generate(customInstructions)
   |     --> 返回自定义指令内容
   |
   +---> 合并各层结果
   |
   v
3. 返回 string[] 给 Agent 模块
```

### 2.2 子代理提示词组装数据流

```
1. Agent 模块请求子代理系统提示词
   |
   v
2. SystemPrompt.assemble({
     agentName: 'explore',
     agentPrompt: '...',  // 子代理专属提示
     isSubagent: true,
     environment: {...},
     customInstructions: undefined,  // 子代理不使用
     tools: ['glob', 'grep', 'read']
   })
   |
   +---> 判断 isSubagent === true
   |     --> 确认是子代理
   |
   +---> AgentLayer.generate(agentPrompt)
   |     --> 返回子代理专属提示词（约 20 行）
   |
   +---> EnvironmentLayer.generate({
   |       info: environment,
   |       minimal: true,  // 精简模式
   |       tools: ['glob', 'grep', 'read']
   |     })
   |     --> 返回精简环境信息
   |
   +---> 不调用 CustomLayer（子代理不使用）
   |
   +---> 合并各层结果
   |
   v
3. 返回 string[] 给 Agent 模块
```

### 2.3 自定义指令加载数据流

```
1. Agent 模块需要加载自定义指令
   |
   v
2. SystemPrompt.loadCustomInstructions()
   |
   +---> Config.getProjectPath()
   |     --> 返回项目配置目录路径
   |
   +---> 读取 {projectPath}/.ohbaby-agent/OHBABY.md
   |     --> 文件存在则读取内容
   |     --> 文件不存在则跳过
   |
   +---> Config.getGlobalPath()
   |     --> 返回全局配置目录路径
   |
   +---> 读取 {globalPath}/.ohbaby-agent/OHBABY.md
   |     --> 文件存在则读取内容
   |     --> 文件不存在则跳过
   |
   +---> 合并两个文件内容
   |
   v
3. 返回 string[] 给调用方
```

---

## 三、Interface Definition（接口定义）

### 3.1 SystemPrompt 主接口

```typescript
namespace SystemPrompt {
  /**
   * 组装完整系统提示词
   * @param options 组装选项
   * @returns 组装后的提示词数组
   */
  function assemble(options: AssembleOptions): string[]

  /**
   * 加载自定义指令
   * @returns 自定义指令内容数组
   */
  function loadCustomInstructions(): Promise<string[]>

  /**
   * 获取身份层提示词
   * @returns 身份提示词文本
   */
  function getIdentity(): string

  /**
   * 获取子代理专属提示词
   * @param agentName 代理名称
   * @returns 代理专属提示词，不存在则返回 undefined
   */
  function getAgentPrompt(agentName: string): string | undefined

  /**
   * 生成环境信息提示词
   * @param info 环境信息
   * @param minimal 是否精简模式
   * @param tools 可用工具列表
   * @returns 环境信息提示词文本
   */
  function getEnvironment(
    info: EnvironmentInfo,
    minimal?: boolean,
    tools?: string[]
  ): string
}
```

### 3.2 AssembleOptions 接口

```typescript
interface AssembleOptions {
  /** 代理名称 */
  agentName: string

  /**
   * 代理专属提示词
   * - undefined: 主代理
   * - string: 子代理
   */
  agentPrompt?: string

  /** Explicit primary/subagent boundary; do not infer from agentPrompt */
  isSubagent: boolean

  /** 运行时环境信息 */
  environment: EnvironmentInfo

  /** 自定义指令（仅主代理） */
  customInstructions?: string[]

  /** 可用工具列表 */
  tools?: string[]
}
```

### 3.3 EnvironmentInfo 接口

```typescript
interface EnvironmentInfo {
  /** 当前工作目录 */
  workingDirectory: string

  /** 操作系统平台 */
  platform: NodeJS.Platform

  /** 是否为 Git 仓库 */
  isGitRepo: boolean

  /** 当前日期（YYYY-MM-DD） */
  date: string

  /** 操作系统版本 */
  osVersion?: string
}
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据归属

| 数据 | 创建者 | 所有者 | 更新者 | 销毁者 |
|------|--------|--------|--------|--------|
| Identity 提示词 | 开发者 | SystemPrompt | 开发者 | - |
| Agent 提示词 | 开发者 | SystemPrompt | 开发者 | - |
| 环境信息 | Agent 模块 | Agent 模块 | Agent 模块 | - |
| 自定义指令 | 用户 | 文件系统 | 用户 | 用户 |
| 组装结果 | SystemPrompt | 调用方 | - | 调用方 |

### 4.2 责任边界

| 操作 | 责任模块 |
|------|----------|
| 存储提示词模板 | SystemPrompt |
| 组装系统提示词 | SystemPrompt |
| 生成环境信息 | SystemPrompt |
| 读取 OHBABY.md | SystemPrompt |
| 提供文件路径 | Config |
| 提供工具列表 | Tool |
| 决定调用时机 | Agent |
| 缓存组装结果 | Agent（可选） |

### 4.3 文件位置

| 文件类型 | 路径 | 说明 |
|----------|------|------|
| 项目级指令 | `.ohbaby-agent/OHBABY.md` | 项目根目录 |
| 全局级指令 | `~/.ohbaby-agent/OHBABY.md` | 用户主目录 |

---

## 五、依赖接口说明

### 5.1 Config 模块依赖

```typescript
// SystemPrompt 调用 Config 模块
Config.getProjectPath(): string    // 获取项目配置目录
Config.getGlobalPath(): string     // 获取全局配置目录
```

### 5.2 Tool 模块依赖

```typescript
// SystemPrompt 调用 Tool 模块（可选）
Tool.list(): string[]  // 获取可用工具列表
```

### 5.3 文件系统依赖

```typescript
// SystemPrompt 使用文件系统
import { readFile, access } from 'fs/promises'

// 读取 OHBABY.md 文件
await readFile(path, 'utf-8')

// 检查文件是否存在
await access(path)
```

---

## 六、错误处理

### 6.1 文件读取错误

| 错误场景 | 处理方式 |
|----------|----------|
| OHBABY.md 不存在 | 静默忽略，返回空数组 |
| OHBABY.md 读取失败 | 记录警告，返回空数组 |
| OHBABY.md 内容过大 | 截断并记录警告 |

### 6.2 组装错误

| 错误场景 | 错误类型 | 处理方式 |
|----------|----------|----------|
| agentName 为空 | `InvalidArgumentError` | 抛出错误 |
| environment 缺失 | `InvalidArgumentError` | 抛出错误 |
| 未知代理提示词 | - | 返回空字符串 |

---

## 七、使用示例

### 7.1 Agent 模块调用示例

```typescript
// 获取主代理系统提示词
async function getPrimaryAgentPrompt(): Promise<string[]> {
  const customInstructions = await SystemPrompt.loadCustomInstructions()
  const tools = await Tool.list()

  return SystemPrompt.assemble({
    agentName: 'build',
    agentPrompt: undefined,
    isSubagent: false,
    environment: {
      workingDirectory: process.cwd(),
      platform: process.platform,
      isGitRepo: await isGitRepository(),
      date: new Date().toISOString().split('T')[0]
    },
    customInstructions,
    tools
  })
}

// 获取子代理系统提示词
function getSubagentPrompt(
  agentName: string,
  agentPrompt: string,
  tools: string[]
): string[] {
  return SystemPrompt.assemble({
    agentName,
    agentPrompt,
    isSubagent: true,
    environment: {
      workingDirectory: process.cwd(),
      platform: process.platform,
      isGitRepo: false,  // 子代理通常不需要
      date: new Date().toISOString().split('T')[0]
    },
    customInstructions: undefined,
    tools
  })
}
```

---

## 八、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 不存在数据责任不清或重复处理的风险
- [x] 依赖接口明确定义
- [x] 错误处理策略清晰
