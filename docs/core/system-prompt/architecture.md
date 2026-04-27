# system-prompt 模块 architecture.md

本文档描述 `system-prompt` 模块的内部结构与设计模式。

---

## 一、Architecture Overview（总体架构）

system-prompt 模块采用**分层组装架构**，将提示词分为多个层次，按需组合：

```
+-------------------------------------------------------------+
| Public API Layer (公共接口层)                                |
| - SystemPrompt.assemble(): 组装完整提示词                    |
| - SystemPrompt.loadCustomInstructions(): 加载自定义指令      |
+-------------------------------------------------------------+
                         |
                         v
+-------------------------------------------------------------+
| Layer Components (层组件)                                    |
| - IdentityLayer: 身份层提示词                                |
| - AgentLayer: 代理层提示词（子代理专用）                      |
| - EnvironmentLayer: 环境层提示词                             |
| - CustomLayer: 自定义指令层                                  |
+-------------------------------------------------------------+
                         |
                         v
+-------------------------------------------------------------+
| Storage Layer (存储层)                                       |
| - prompts/: 提示词模板文件                                   |
| - File System: OHBABY.md 文件读取                              |
+-------------------------------------------------------------+
```

### 1.1 组件职责

| 组件 | 职责 |
|------|------|
| **SystemPrompt** | 对外统一接口，协调各层组件完成组装 |
| **IdentityLayer** | 管理基础身份提示词 |
| **AgentLayer** | 管理子代理专属提示词 |
| **EnvironmentLayer** | 生成运行时环境信息 |
| **CustomLayer** | 加载用户自定义指令 |

### 1.2 组件间依赖

```
SystemPrompt (Facade)
    |-- IdentityLayer (身份提示词)
    |-- AgentLayer (代理提示词)
    |-- EnvironmentLayer (环境信息)
    +-- CustomLayer (自定义指令)
            +-- Config (文件路径)
            +-- FileSystem (文件读取)
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 Facade 模式

**使用场景**：SystemPrompt 作为模块的统一入口

**理由**：
- 隐藏内部分层复杂性
- 为 Agent 模块提供简洁的调用接口
- 便于未来扩展新的提示词层

**实现方式**：
- SystemPrompt.assemble() 作为唯一的组装入口
- 内部委托给各层组件

### 2.2 Template Method 模式

**使用场景**：各层提示词的生成

**理由**：
- 每层有固定的生成流程
- 允许子类（各层组件）定制具体内容
- 统一的接口，差异化的实现

**实现方式**：
- 每层实现 `generate()` 方法
- 返回格式统一为 `string`

### 2.3 未使用的模式

**Builder 模式**：
- 考虑过用于逐步构建提示词
- 未使用原因：层次固定，不需要灵活的构建顺序

**Strategy 模式**：
- 考虑过用于不同 Provider 的提示词策略
- 未使用原因：MVP 阶段不区分 Provider

---

## 三、Module Structure & File Layout（模块结构与文件组织）

### 3.1 目录结构

```
ohbaby-agent/src/core/system-prompt/
|-- index.ts                 # 公共 API 导出
|-- assembler.ts             # SystemPrompt 组装器实现
|-- types.ts                 # 类型定义
|-- layers/                  # 层组件
|   |-- index.ts             # 层组件导出
|   |-- identity.ts          # 身份层
|   |-- agent.ts             # 代理层
|   |-- environment.ts       # 环境层
|   +-- custom.ts            # 自定义指令层
|-- prompts/                 # 提示词模板
|   |-- identity.ts          # 身份提示词模板
|   |-- agents/              # 子代理提示词
|   |   |-- explore.ts       # explore 代理提示词
|   |   +-- research.ts      # research 代理提示词
|   +-- environment.ts       # 环境信息模板
+-- __tests__/               # 测试文件
    |-- assembler.test.ts
    |-- layers/
    |   |-- identity.test.ts
    |   |-- agent.test.ts
    |   |-- environment.test.ts
    |   +-- custom.test.ts
    +-- integration.test.ts
```

### 3.2 文件职责

| 文件 | 职责 | 对外稳定性 |
|------|------|------------|
| `index.ts` | 公共 API 导出 | **稳定** |
| `types.ts` | 类型定义 | **稳定** |
| `assembler.ts` | 组装逻辑实现 | 内部实现 |
| `layers/*` | 各层组件实现 | 内部实现 |
| `prompts/*` | 提示词模板 | 内部实现（可能频繁更新） |

### 3.3 公共 API

```typescript
// index.ts

// 主要导出
export { SystemPrompt } from './assembler'
export type {
  AssembleOptions,
  EnvironmentInfo,
  LayerType
} from './types'
```

---

## 四、Layer Design（分层设计）

### 4.1 提示词层次结构

```
+---------------------------------------------------------------+
| Layer 1: Identity (身份层)                                     |
| - 基础身份描述（你是 ohbaby-agent，一个 AI 编程助手...）           |
| - 核心能力说明                                                 |
| - 基础行为准则                                                 |
| - 工具使用指南                                                 |
| - 输出格式规范                                                 |
| 大小：约 800 行（主代理完整版）                                 |
+---------------------------------------------------------------+
                         |
                         v
+---------------------------------------------------------------+
| Layer 2: Agent Prompt (代理层) - 可选                          |
| - 主代理：不注入此层                                           |
| - 子代理：注入精简专属提示（约 20 行）                          |
|   - 任务范围限定                                               |
|   - 可用工具说明                                               |
|   - 输出要求                                                   |
+---------------------------------------------------------------+
                         |
                         v
+---------------------------------------------------------------+
| Layer 3: Environment (环境层)                                  |
| - 工作目录路径                                                 |
| - 操作系统平台                                                 |
| - Git 仓库状态                                                 |
| - 当前日期                                                     |
| - 可用工具列表                                                 |
+---------------------------------------------------------------+
                         |
                         v
+---------------------------------------------------------------+
| Layer 4: Custom Instructions (自定义层) - 仅主代理             |
| - 项目级 OHBABY.md 内容                                          |
| - 全局级 OHBABY.md 内容                                          |
+---------------------------------------------------------------+
```

### 4.2 主代理 vs 子代理的组装差异

| 层次 | 主代理 | 子代理 |
|------|--------|--------|
| Identity | 完整版（约 800 行） | 不包含 |
| Agent Prompt | 不包含 | 精简专属（约 20 行） |
| Environment | 完整版 | 精简版（仅基本信息） |
| Custom Instructions | 加载 OHBABY.md | 不加载 |

### 4.3 组装流程

```
assemble(options) 调用
    |
    +-- 判断代理类型
    |       |
    |       +-- 主代理 (agentPrompt === undefined)
    |       |       |
    |       |       +-- IdentityLayer.generate()
    |       |       +-- EnvironmentLayer.generate(full)
    |       |       +-- CustomLayer.load()
    |       |
    |       +-- 子代理 (agentPrompt !== undefined)
    |               |
    |               +-- AgentLayer.generate(agentPrompt)
    |               +-- EnvironmentLayer.generate(minimal)
    |
    +-- 合并各层结果
    |
    +-- 返回 string[]
```

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 5.1 提示词存储在代码中

**决策**：提示词模板作为 TypeScript 文件存储在代码中，而非外部文件。

**理由**：
- 便于版本控制和代码审查
- 支持类型检查
- 构建时打包，无需运行时文件读取
- 便于国际化扩展（未来）

**代价**：
- 修改提示词需要重新构建
- 提示词与代码耦合

### 5.2 返回字符串数组

**决策**：assemble() 返回 `string[]` 而非单个字符串。

**理由**：
- 便于调用方灵活处理
- 支持不同 LLM Provider 的消息格式
- 便于调试和日志记录

**代价**：
- 调用方需要处理数组拼接

### 5.3 自定义指令延迟加载

**决策**：自定义指令（OHBABY.md）在组装时加载，而非启动时缓存。

**理由**：
- 支持用户实时修改 OHBABY.md
- 减少内存占用
- 简化初始化逻辑

**代价**：
- 每次组装都需要文件读取
- 文件不存在时需要处理错误

**缓解措施**：
- 使用 try-catch 优雅处理文件不存在
- 调用方可自行缓存结果

### 5.4 子代理不使用 Identity 层

**决策**：子代理使用精简的专属提示词，不包含完整的 Identity 层。

**理由**：
- 减少 Token 消耗
- 子代理任务明确，不需要完整能力描述
- 与 OpenCode 设计保持一致

**代价**：
- 子代理的行为可能与主代理有细微差异

---

## 六、关键实现说明

### 6.1 Identity 层结构

```typescript
// prompts/identity.ts
export const IDENTITY_PROMPT = `
You are ohbaby-agent, an AI coding assistant...

# Core Capabilities
- Code generation and modification
- File system operations
- Git operations
- Web search and fetch
...

# Tool Usage Guidelines
...

# Output Format
...
`
```

### 6.2 子代理提示词示例

```typescript
// prompts/agents/explore.ts
export const EXPLORE_PROMPT = `
You are a code exploration agent. Your task is to quickly find and analyze code.

Available tools: glob, grep, read
Disabled tools: write, edit, bash, task

Guidelines:
- Focus on finding relevant files and code patterns
- Provide concise summaries of findings
- Do not modify any files
`
```

### 6.3 环境信息生成

```typescript
// layers/environment.ts
export function generateEnvironment(info: EnvironmentInfo, minimal: boolean): string {
  const lines = [
    `Working directory: ${info.workingDirectory}`,
    `Platform: ${info.platform}`,
    `Date: ${info.date}`,
  ]

  if (!minimal) {
    lines.push(`Is Git repo: ${info.isGitRepo}`)
    if (info.tools) {
      lines.push(`Available tools: ${info.tools.join(', ')}`)
    }
  }

  return lines.join('\n')
}
```

---

## 七、文档自检

- [x] 可以清楚说出每个子组件存在的理由
- [x] 不存在无法追溯到 goals-duty.md 的结构
- [x] 没有为了"优雅"而增加的复杂性
- [x] 设计模式的使用有明确理由
- [x] 约束与权衡已明确记录
