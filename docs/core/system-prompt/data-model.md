# system-prompt 模块 data-model.md

本文档定义 `system-prompt` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 LayerType（提示词层类型）

提示词分为四个层次，每层有特定的用途：

| 层类型 | 说明 | 使用场景 |
|--------|------|----------|
| `identity` | 身份层 | 定义 AI 助手的基础身份和能力 |
| `agent` | 代理层 | 子代理的专属提示词 |
| `environment` | 环境层 | 运行时环境信息 |
| `custom` | 自定义层 | 用户自定义指令 |

### 1.2 AssembleOptions（组装选项）

组装系统提示词时需要传递的参数，决定了最终提示词的内容和结构。

### 1.3 EnvironmentInfo（环境信息）

运行时环境的描述信息，包含工作目录、平台、Git 状态等。

---

## 二、Data Types（数据类型）

### 2.1 枚举类型

```typescript
/** 提示词层类型 */
type LayerType = 'identity' | 'agent' | 'environment' | 'custom'
```

### 2.2 组装选项类型

```typescript
/** 系统提示词组装选项 */
interface AssembleOptions {
  /** 代理名称 */
  agentName: string

  /**
   * 代理专属提示词
   * - undefined: 主代理，使用完整 Identity 层
   * - string: 子代理，使用此提示词替代 Identity 层
   */
  agentPrompt?: string

  /** 运行时环境信息 */
  environment: EnvironmentInfo

  /**
   * 自定义指令内容
   * - 仅主代理使用
   * - 子代理应传递 undefined
   */
  customInstructions?: string[]

  /**
   * 可用工具列表
   * - 用于在环境信息中展示
   */
  tools?: string[]
}
```

### 2.3 环境信息类型

```typescript
/** 运行时环境信息 */
interface EnvironmentInfo {
  /** 当前工作目录 */
  workingDirectory: string

  /** 操作系统平台 */
  platform: NodeJS.Platform

  /** 是否为 Git 仓库 */
  isGitRepo: boolean

  /** 当前日期（格式：YYYY-MM-DD） */
  date: string

  /** 操作系统版本（可选） */
  osVersion?: string
}
```

### 2.4 层组件接口

```typescript
/** 提示词层组件接口 */
interface PromptLayer {
  /** 层类型 */
  type: LayerType

  /**
   * 生成此层的提示词内容
   * @param options 生成选项（各层不同）
   * @returns 提示词文本
   */
  generate(options?: unknown): string
}

/** Identity 层组件 */
interface IdentityLayer extends PromptLayer {
  type: 'identity'
  generate(): string
}

/** Agent 层组件 */
interface AgentLayer extends PromptLayer {
  type: 'agent'
  /**
   * 生成子代理提示词
   * @param agentPrompt 代理专属提示词内容
   */
  generate(agentPrompt: string): string
}

/** Environment 层组件 */
interface EnvironmentLayer extends PromptLayer {
  type: 'environment'
  /**
   * 生成环境信息提示词
   * @param options 环境信息和是否精简模式
   */
  generate(options: {
    info: EnvironmentInfo
    minimal: boolean
    tools?: string[]
  }): string
}

/** Custom 层组件 */
interface CustomLayer extends PromptLayer {
  type: 'custom'
  /**
   * 加载自定义指令
   * @returns 自定义指令内容数组
   */
  load(): Promise<string[]>
  /**
   * 生成自定义指令提示词
   * @param instructions 已加载的指令内容
   */
  generate(instructions: string[]): string
}
```

### 2.5 组装结果类型

```typescript
/** 系统提示词组装结果 */
interface AssembleResult {
  /** 组装后的提示词数组 */
  prompts: string[]

  /** 各层的贡献（用于调试） */
  layers: Array<{
    type: LayerType
    length: number
  }>

  /** 总字符数 */
  totalLength: number
}
```

---

## 三、Prompt Templates（提示词模板）

### 3.1 Identity 提示词结构

Identity 层提示词包含以下部分（约 800 行）：

```typescript
interface IdentityPromptStructure {
  /** 身份声明 */
  identity: string
  // "You are ohbaby-agent, an AI coding assistant..."

  /** 核心能力 */
  capabilities: string
  // "# Core Capabilities\n- Code generation..."

  /** 工具使用指南 */
  toolGuidelines: string
  // "# Tool Usage Guidelines\n..."

  /** 输出格式规范 */
  outputFormat: string
  // "# Output Format\n..."

  /** 安全准则 */
  safetyGuidelines: string
  // "# Safety Guidelines\n..."

  /** 行为准则 */
  behaviorGuidelines: string
  // "# Behavior Guidelines\n..."
}
```

### 3.2 内置子代理提示词

| 代理名称 | 提示词长度 | 主要内容 |
|----------|------------|----------|
| explore | 约 20 行 | 代码探索任务说明、可用工具、输出要求 |
| research | 约 25 行 | 深度研究任务说明、网络搜索指南、信息整合要求 |

### 3.3 Environment 提示词格式

```typescript
/** 环境信息提示词格式 */
const ENVIRONMENT_TEMPLATE = `
<env>
Working directory: {workingDirectory}
Platform: {platform}
Is Git repo: {isGitRepo}
Date: {date}
</env>
`

/** 精简版（子代理使用） */
const ENVIRONMENT_MINIMAL_TEMPLATE = `
<env>
Working directory: {workingDirectory}
Platform: {platform}
Date: {date}
</env>
`
```

---

## 四、Constants（常量定义）

### 4.1 层顺序常量

```typescript
/** 主代理的层组装顺序 */
const PRIMARY_LAYER_ORDER: LayerType[] = [
  'identity',
  'environment',
  'custom'
]

/** 子代理的层组装顺序 */
const SUBAGENT_LAYER_ORDER: LayerType[] = [
  'agent',
  'environment'
]
```

### 4.2 文件路径常量

```typescript
/** 项目级自定义指令文件名 */
const PROJECT_INSTRUCTIONS_FILE = 'OHBABY.md'

/** 项目级配置目录 */
const PROJECT_CONFIG_DIR = '.ohbaby-agent'

/** 全局配置目录名 */
const GLOBAL_CONFIG_DIR = '.ohbaby-agent'
```

### 4.3 限制常量

```typescript
/** 单层提示词最大字符数 */
const MAX_LAYER_LENGTH = 100 * 1024  // 100KB

/** 自定义指令最大字符数 */
const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 50 * 1024  // 50KB
```

---

## 五、Validation Rules（验证规则）

### 5.1 AssembleOptions 验证

| 字段 | 验证规则 |
|------|----------|
| `agentName` | 必填，非空字符串 |
| `agentPrompt` | 可选，如提供则非空 |
| `environment` | 必填，符合 EnvironmentInfo 结构 |
| `environment.workingDirectory` | 必填，有效路径 |
| `environment.platform` | 必填，有效平台标识 |
| `environment.date` | 必填，YYYY-MM-DD 格式 |
| `customInstructions` | 可选，如提供则为字符串数组 |
| `tools` | 可选，如提供则为字符串数组 |

### 5.2 提示词内容验证

- 单层提示词不超过 100KB
- 自定义指令总长度不超过 50KB
- 提示词不包含可能导致注入的特殊模式

---

## 六、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 提示词结构明确
- [x] 验证规则清晰
- [x] 类型定义符合 TypeScript 规范
