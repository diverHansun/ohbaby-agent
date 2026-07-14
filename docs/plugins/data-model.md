# plugins 模块 data-model.md

本文档定义 `plugins` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话说明 |
|------|-----------|
| **PluginId** | 插件的全局唯一标识符，格式 `name@marketplace`（本地插件省略 `@marketplace`） |
| **PluginScope** | 插件安装的作用域（user / project / local / managed），决定写入哪份 settings 文件 |
| **PluginState** | 插件当前生命周期状态：installed / enabled / disabled |
| **PluginSource** | 插件来源的类型抽象：本地路径 / 已安装 cache / marketplace 引用（Phase 2） |
| **PluginManifest** | `.claude-plugin/plugin.json` 经解析校验后的结构化数据 |
| **PluginInstallRecord** | 安装动作完成后持久化的安装记录，包含插件标识、scope、pluginRoot 等 |
| **PluginRiskSummary** | 插件能力的风险声明：列出高危组件类型，供上层决策是否向用户提示 |
| **PluginContribution** | 核心中间表示——一个已启用插件带来的所有组件发现结果的汇总，作为 Dispatcher 分发给各子系统的 Handoff DTO |
| **\*Contribution** | PluginContribution 内每类组件的轻量 DTO：只携带路径或已替换变量的配置，不携带业务语义 |

**Handoff DTO 原则**：所有 `*Contribution` 类型的语义是"我在这个插件包里发现了这些东西，请对应模块接手校验和加载"。它们不是 skill/agents/mcp 的运行时模型，也不是缓存对象——只是交接凭证。

---

## 二、Identifiers & Primitive Types（标识符与基础类型）

```typescript
/** 插件唯一标识符，格式：name 或 name@marketplace */
type PluginId = string

/** 已解析的绝对路径（branded string，防止相对路径混入） */
type AbsolutePath = string & { readonly _brand: 'AbsolutePath' }

/** manifest 中声明的插件内相对路径，必须解析在 pluginRoot 内 */
type PluginRelativePath = string & { readonly _brand: 'PluginRelativePath' }

/** settings.json 中插件配置段的 JSON 结构（由 config/plugins 负责读写） */
type PluginSettingsJson = Record<string, unknown>
```

---

## 三、PluginScope & PluginState（枚举）

```typescript
/** 安装作用域 */
type PluginScope =
  | 'user'     // ~/.ohbaby/settings.json，用户级，跨项目可用
  | 'project'  // .ohbaby/settings.json，项目级，随仓库共享
  | 'local'    // .ohbaby/settings.local.json，本地覆盖，不入 git
  | 'managed'  // 由管理员通过 managed settings 写入，只读

/** 插件生命周期状态 */
type PluginState =
  | 'enabled'    // 已安装且已激活，contribution 已分发给子系统
  | 'disabled'   // 已安装但未激活
  | 'installed'  // 已写入安装记录，但尚未 enable（过渡状态）
```

---

## 四、PluginSource（来源类型，区分模式）

```typescript
/**
 * LocalPath：--plugin-dir 等价，直接引用原始目录，不复制到 cache
 * 用于本地开发调试插件场景
 */
interface LocalPathSource {
  type: 'local'
  path: AbsolutePath
}

/**
 * InstalledCache：已通过 install 写入 cache 的版本目录
 * enable / reload 时从 cache 路径引用
 */
interface InstalledCacheSource {
  type: 'cache'
  pluginId: PluginId
  version: string
  cachePath: AbsolutePath  // ~/.ohbaby/plugins/cache/<name>/<version>/
}

/**
 * MarketplaceRef：远程来源（Phase 2 预留，MVP 不实现 resolve 逻辑）
 * GitHub owner/repo、Git URL、远程 marketplace.json 中的 plugin entry
 */
interface MarketplaceRef {
  type: 'marketplace'
  ref: string      // "anthropics/claude-plugins" 或 git URL 等
  name: string     // 插件名
  version?: string
}

type PluginSource = LocalPathSource | InstalledCacheSource | MarketplaceRef
```

---

## 五、PluginManifest（manifest 解析结果）

`.claude-plugin/plugin.json` 经 ManifestLoader 读取和 schema 校验后的类型。字段含义对齐 Anthropic plugin 规范。

```typescript
interface PluginManifest {
  /** kebab-case，唯一标识，必填 */
  name: string

  /** semver 字符串，未设置时以 git commit SHA 代替 */
  version?: string

  description?: string
  author?: { name?: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]

  /**
   * 各组件的路径覆写配置。
   * 未设置时使用默认路径（skills/、agents/、hooks/hooks.json 等）。
   * ManifestLoader 只做格式校验和规范化，保留为插件根目录内的相对路径。
   * ContributionBuilder 在绑定 pluginRoot 后解析为绝对路径、替换变量并做越界检查。
   */
  skills?: PluginRelativePath[]
  commands?: PluginRelativePath[]
  agents?: PluginRelativePath[]
  hooks?: PluginRelativePath | PluginInlineJson
  mcpServers?: PluginRelativePath | PluginInlineJson
  lspServers?: PluginRelativePath | PluginInlineJson
  monitors?: PluginRelativePath[]
  themes?: PluginRelativePath[]
  outputStyles?: PluginRelativePath[]
  bin?: PluginRelativePath

  /** 插件级别的 settings.json 默认值（目前仅 agent、subagentStatusLine 有效） */
  settings?: Record<string, unknown>

  /** 用户配置声明（enable 时提示用户填写） */
  userConfig?: Record<string, PluginUserConfigSchema>

  /** 插件依赖（Phase 2：semver 约束，MVP 仅记录不解析） */
  dependencies?: PluginDependency[]
}

/** manifest 内联 JSON 配置（允许 hooks/mcp/lsp 直接写在 manifest 里） */
type PluginInlineJson = Record<string, unknown>

/** 单条依赖声明 */
interface PluginDependency {
  name: string
  version?: string  // semver range，如 "~2.1.0"
}
```

---

## 六、PluginUserConfigSchema（userConfig 字段声明）

```typescript
/** manifest 中 userConfig 的单项声明 */
interface PluginUserConfigSchema {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  sensitive?: boolean   // true → 写入 keychain（Phase 2），MVP 标记但不实现
  required?: boolean
  default?: unknown
  multiple?: boolean    // string 类型专用，允许多值
  min?: number          // number 类型专用
  max?: number          // number 类型专用
}

/**
 * enable 时收集完成后的已解析 userConfig 值
 * 非敏感字段来自 settings.json，sensitive 字段在 Phase 2 来自 keychain
 */
type PluginUserConfigValues = Record<string, unknown>
```

---

## 七、PluginInstallRecord（安装记录）

由 Registry 通过 config/plugins 持久化到 settings.json。

```typescript
interface PluginInstallRecord {
  /** 插件唯一标识 */
  pluginId: PluginId

  /** 安装来源（用于 reload 时重新定位插件目录） */
  source: PluginSource

  /** 当前实际加载的插件根目录；LocalPath 为原始目录，InstalledCache 为 cachePath */
  pluginRoot: AbsolutePath

  /** 安装作用域 */
  scope: PluginScope

  /** 当前状态 */
  state: PluginState

  /** manifest 中的 name 字段 */
  name: string

  /** manifest 中的 version（未设置时为 undefined） */
  version?: string

  /** install 完成时间（ISO 8601） */
  installedAt: string

  /** 用户已填写的 userConfig 值（非敏感）  */
  userConfigValues?: PluginUserConfigValues
}
```

---

## 八、PluginRiskSummary（风险摘要）

由 `security.summarizeRisks()` 生成，附在 PluginContribution 上，供上层（CLI/TUI）决策是否向用户显示风险提示。

```typescript
/** 能力风险等级 */
type PluginRiskLevel = 'high' | 'medium' | 'low'

/** 单条高危能力声明 */
interface PluginRiskEntry {
  capability: 'hooks' | 'bin' | 'mcp-stdio' | 'mcp-remote' | 'monitors' | 'skills' | 'agents'
  level: PluginRiskLevel
  reason: string
}

interface PluginRiskSummary {
  pluginId: PluginId
  /** 是否包含任何 high 级别能力 */
  hasHighRisk: boolean
  entries: PluginRiskEntry[]
}

/**
 * 各能力类型的默认风险级别参考（security.ts 中维护）：
 *
 * | 能力       | 风险   | 原因                   |
 * |-----------|--------|----------------------|
 * | hooks     | high   | 可执行任意命令          |
 * | bin       | high   | 注入 PATH 可执行文件     |
 * | mcp-stdio | high   | 启动本地子进程          |
 * | mcp-remote| medium | 访问外部服务，数据泄露风险|
 * | monitors  | medium | 后台长期运行进程         |
 * | agents    | low    | 主要是提示词影响         |
 * | skills    | low    | 主要是提示词影响         |
 */
```

---

## 九、PluginContribution 及组件 Handoff DTO

`PluginContribution` 是 plugins 模块唯一的核心跨模块数据结构，由 ContributionBuilder 生成，由 Dispatcher 分发。**所有路径变量（`${CLAUDE_PLUGIN_ROOT}` 等）在 ContributionBuilder 阶段已完成替换**。

```typescript
interface PluginContribution {
  pluginId: PluginId

  /** 插件安装目录绝对路径（替换后的 CLAUDE_PLUGIN_ROOT） */
  pluginRoot: AbsolutePath

  /** 插件持久化目录绝对路径（替换后的 CLAUDE_PLUGIN_DATA） */
  pluginData: AbsolutePath

  /** 校验后的 manifest */
  manifest: PluginManifest

  /** 已解析的 userConfig 值 */
  userConfigValues: PluginUserConfigValues

  /** 风险摘要 */
  risk: PluginRiskSummary

  // ── 各类组件 Handoff DTO ──

  skills: PluginSkillContribution[]
  agents: PluginAgentContribution[]
  hooks?: PluginHookContribution
  mcpServers?: PluginMcpContribution
  lspServers?: PluginLspContribution
  monitors: PluginMonitorContribution[]
  bin?: PluginBinContribution
  themes: PluginThemeContribution[]
  outputStyles: PluginOutputStyleContribution[]
}
```

### 9.1 PluginSkillContribution

```typescript
/**
 * 交给 skill 模块：这个目录下有 skill，请你接手扫描和加载 SKILL.md。
 * skill 模块负责调用自己的 SkillLoader，plugins 不解析 SKILL.md 内容。
 */
interface PluginSkillContribution {
  pluginId: PluginId
  /** skill 目录绝对路径（对应 skills/<name>/ 或 commands/<name>.md 所在目录） */
  skillDir: AbsolutePath
  /**
   * 命名空间前缀，用于 skill 模块注册命令时防止名称冲突
   * 格式：插件 name 字段，如 "commit-commands"
   * 注册后 skill 调用形如 /commit-commands:commit
   */
  namespace: string
  /** 标记来源是 skills/ 目录（有 SKILL.md 结构）还是 commands/ 目录（平铺 .md 文件） */
  format: 'skills-dir' | 'commands-dir'
}
```

### 9.2 PluginAgentContribution

```typescript
/**
 * 交给 agents / config/agents 模块：这个文件是一个 agent 定义，请接手验证和注册。
 * agents 模块负责读取 Markdown frontmatter，plugins 不解析 agent 配置。
 */
interface PluginAgentContribution {
  pluginId: PluginId
  /** agent 定义文件的绝对路径（agents/<name>.md） */
  file: AbsolutePath
  /** 命名空间前缀，注册后 agent 名称形如 plugin-name:agent-name */
  namespace: string
}
```

### 9.3 PluginHookContribution

```typescript
/**
 * 交给 runtime/hooks 模块：这是 hooks 配置，请接手注册到 hook 系统。
 * 路径变量已替换，runtime/hooks 负责最终 schema 校验和注册。
 */
interface PluginHookContribution {
  pluginId: PluginId
  /**
   * hooks 配置内容（来自 hooks/hooks.json 或 plugin.json 内联）
   * 路径变量（${CLAUDE_PLUGIN_ROOT} 等）已被 ContributionBuilder 替换为绝对路径
   */
  config: Record<string, unknown>
}
```

### 9.4 PluginMcpContribution

```typescript
/**
 * 交给 mcp / config/mcp 模块：这些是 MCP server 配置，请接手 schema 校验和连接管理。
 * command 路径变量已替换，mcp / config/mcp 模块负责验证 MCP server schema 并建立连接。
 */
interface PluginMcpContribution {
  pluginId: PluginId
  /**
   * mcpServers map（来自 .mcp.json 或 plugin.json 内联）
   * 各 server 的 command / env / args 中的路径变量已替换
   * key 为 server 名称，value 为标准 MCP server 配置 JSON
   */
  servers: Record<string, Record<string, unknown>>
}
```

### 9.5 PluginMonitorContribution

```typescript
/**
 * 交给 runtime 监控层：这些是后台 monitor 配置，请接手启动和管理。
 * command 中的路径变量已替换。
 */
interface PluginMonitorContribution {
  pluginId: PluginId
  name: string
  /** 监控命令（路径变量已替换） */
  command: string
  description: string
  when?: 'always' | `on-skill-invoke:${string}`
}
```

### 9.6 PluginBinContribution

```typescript
/**
 * 交给 shell/runtime：这个目录下有可执行文件，请将其加入 Bash tool 的 PATH。
 * plugins 不验证可执行文件内容。
 */
interface PluginBinContribution {
  pluginId: PluginId
  /** bin/ 目录绝对路径 */
  binDir: AbsolutePath
}
```

### 9.7 PluginLspContribution（可选）

```typescript
/**
 * 交给 lsp 模块：这些是 LSP server 配置，请接手校验和连接。
 * 路径变量已替换。
 */
interface PluginLspContribution {
  pluginId: PluginId
  servers: Record<string, Record<string, unknown>>
}
```

### 9.8 其他轻量 Contribution

```typescript
/** 交给 theme 模块：这些 JSON 文件是主题定义 */
interface PluginThemeContribution {
  pluginId: PluginId
  file: AbsolutePath
}

/** 交给 output-style 模块：这些文件是输出风格定义 */
interface PluginOutputStyleContribution {
  pluginId: PluginId
  file: AbsolutePath
}
```

---

## 十、Lifecycle & Ownership（生命周期与归属）

| 数据类型 | 创建者 | 持久化 | 消费者 | 失效时机 |
|---------|--------|--------|--------|---------|
| `PluginSource` | SourceResolver | 存入 PluginInstallRecord | Installer / reload 路径恢复 | 插件卸载时 |
| `PluginManifest` | ManifestLoader | 不单独持久化；InstallRecord 只保存 name/version/pluginRoot 等摘要字段 | ContributionBuilder | 每次 enable/reload 重新读取 |
| `PluginInstallRecord` | Registry | config/plugins → settings.json | Registry 状态迁移 | 插件 uninstall 时删除 |
| `PluginRiskSummary` | security | 不持久化，仅内存 | CLI/TUI 风险提示 | PluginContribution 被清除时 |
| `PluginContribution` | ContributionBuilder | 不持久化，仅内存 | Dispatcher → 各子系统 | reload / disable 时清除 |
| `*Contribution` | ContributionBuilder（从 PluginContribution 中提取） | 不持久化 | 各目标子系统 | 随 PluginContribution 一起清除 |
| `PluginUserConfigValues` | Registry（enable 时收集） | 非敏感值写 settings.json | ContributionBuilder 变量替换 | 插件 uninstall 时删除 |

---

## 十一、Contribution 交接矩阵

| Contribution 类型 | Dispatcher 交给谁 | 接收方的责任 |
|-----------------|-----------------|------------|
| `PluginSkillContribution` | skill 模块 | SkillLoader 扫描 skill 目录，解析 SKILL.md，完成最终注册 |
| `PluginAgentContribution` | agents / config/agents 模块 | 读取 agent Markdown frontmatter，验证 AgentConfig schema |
| `PluginHookContribution` | runtime/hooks | 验证 hook 配置 schema，注册到 hook 事件系统 |
| `PluginMcpContribution` | mcp / config/mcp | 验证 MCP server 配置，管理连接生命周期 |
| `PluginMonitorContribution` | runtime 监控层 | 按 when 条件启动后台进程 |
| `PluginBinContribution` | shell/runtime | 将 binDir 追加到 Bash tool PATH |
| `PluginLspContribution` | lsp 模块 | 验证 LSP 配置，管理语言服务器连接 |
| `PluginThemeContribution` | theme 模块 | 注册主题，在 /theme 中展示 |

---

## 十二、文档自检

- [x] 所有概念可用自然语言解释
- [x] PluginContribution 和 *Contribution 明确定位为 Handoff DTO，不是运行时模型
- [x] 未引入 SkillInfo / McpTool / AgentConfig 等子模块的业务类型
- [x] 每种数据类型都在架构中有对应的创建者和消费者
- [x] Phase 2 预留点（MarketplaceRef / keychain）已标注，不影响 MVP 类型完整性
