# skill 模块 architecture.md

本文档描述 `skill` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

skill 模块负责 Skill 目录的发现、解析、缓存和查询，**同时为 Commands 模块和 SkillTool 提供数据服务**。

**重要**：Skill 是一个目录，包含 SKILL.md 主文件和可选的辅助文件（脚本、模板等）。

**设计特点**（对齐 claude-code 的二维属性正交模型）：
- 两条触发路径正交：用户路径（`/<skill-name>` 斜杠命令）与 Agent 路径（SkillTool）互不干扰
- 默认对两条路径都开放：`user-invocable: true` + `disable-model-invocation: false`
- SkillTool 作为 module 工具**始终注册**到 ToolScheduler，由 ToolScheduler 统一调度
- Skill 列表通过 SkillTool 的 description 暴露给 Agent（采用 1% 上下文预算策略，对齐 claude-code）

### 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         Skill 模块                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │   SkillRegistry  │  │   SkillLoader    │                     │
│  │                  │  │                  │                     │
│  │  - skills cache  │  │  - scan()        │                     │
│  │  - all()         │  │  - parse()       │                     │
│  │  - get()         │  │  - validate()    │                     │
│  │  - load()        │  │  - listFiles()   │                     │
│  │  - listUser      │  │                  │                     │
│  │    Invocable()   │  │                  │                     │
│  │  - invalidate()  │  │                  │                     │
│  └──────────────────┘  └──────────────────┘                     │
│           │                     │                                │
│           └─────────┬───────────┘                                │
│                     │                                            │
│  ┌──────────────────┴───────────────────┐                       │
│  │              SkillTool                 │                       │
│  │                                        │                       │
│  │  始终注册为 module 工具                 │                       │
│  │  description 动态列出 model-invocable  │                       │
│  │  Skill 列表（1% 上下文预算）            │                       │
│  └───────────────────────────────────────┘                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
       ┌──────────┬───────────┼───────────┬──────────┐
       │          │           │           │          │
       ▼          ▼           ▼           ▼          ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐ ┌─────┐
   │ Config │ │Commands│ │  Tool  │ │  Permission  │ │ Log │
   │(目录)  │ │(/<name>│ │Scheduler│ │(skill:<name>)│ │     │
   │        │ │ 注册)  │ │(注册   │ │              │ │     │
   │        │ │        │ │SkillTool)│ │              │ │     │
   └────────┘ └────────┘ └────────┘ └──────────────┘ └─────┘
```

### 主要组件职责

| 组件 | 职责 |
|------|------|
| **SkillRegistry** | 管理 Skill 缓存，提供查询接口（all/get/load/listUserInvocable/listModelInvocable），处理缓存失效 |
| **SkillLoader** | 扫描目录、解析 frontmatter、验证格式、列出辅助文件 |
| **SkillTool** | 始终注册为 module 工具，description 动态列出所有 `disableModelInvocation: false` 的 Skill；execute 时按名加载并返回内容、baseDir、辅助文件列表 |

---

## 二、Core Components（核心组件）

### 2.1 SkillRegistry

**职责**：管理 Skill 的缓存和查询，**主要为 Commands 模块提供服务**

**核心逻辑**：
```typescript
class SkillRegistry {
  private cache: Map<string, SkillInfo> | null = null
  private loader: SkillLoader

  // 获取所有 Skill（懒加载）
  async all(): Promise<SkillInfo[]> {
    if (!this.cache) {
      this.cache = await this.loader.scan()
    }
    return Array.from(this.cache.values())
  }

  // 按名称获取 Skill 元数据
  async get(name: string): Promise<SkillInfo | undefined> {
    const skills = await this.all()
    return this.cache?.get(name)
  }

  // 加载 Skill 完整内容（供 Commands 模块调用）
  async load(name: string): Promise<SkillContent> {
    const skill = await this.get(name)
    if (!skill) throw new SkillNotFoundError(name, await this.listNames())
    return this.loader.loadContent(skill.location)
  }

  // 获取所有 user-invocable 的 Skill（供 Commands 模块注册命令）
  async listUserInvocable(): Promise<SkillInfo[]> {
    const all = await this.all()
    return all.filter(s => s.userInvocable)
  }

  // 获取所有允许 Agent 调用的 Skill（供 SkillTool 使用）
  async listModelInvocable(): Promise<SkillInfo[]> {
    const all = await this.all()
    return all.filter(s => !s.disableModelInvocation)
  }

  // 获取所有 Skill 名称
  async listNames(): Promise<string[]> {
    const all = await this.all()
    return all.map(s => s.name)
  }

  // 使缓存失效（下次访问重新扫描）
  invalidate(): void {
    this.cache = null
  }

  // 强制重新加载
  async reload(): Promise<void> {
    this.cache = await this.loader.scan()
  }
}
```

**缓存策略**：
- 懒加载：首次调用 `all()` 或 `get()` 时才扫描
- 手动失效：通过 `invalidate()` 清除缓存
- 强制重载：通过 `reload()` 立即重新扫描

### 2.2 SkillLoader

**职责**：文件扫描、解析和验证

**扫描流程**：
```
1. 获取配置目录列表
   ├── Config.getUserConfigDir() → ~/.config/ohbaby-agent/ (scope: 'user')
   └── Config.getProjectConfigDir() → .ohbaby-agent/ (scope: 'project')

2. 对每个目录执行 Glob 扫描
   └── pattern: skill/**/SKILL.md

3. 解析每个 SKILL.md 文件
   ├── 读取文件内容
   ├── 解析 YAML frontmatter
   ├── 提取必填字段：name, description
   ├── 提取可选字段：user-invocable, disable-model-invocation
   ├── 记录 baseDir (SKILL.md 所在目录)
   └── 记录 scope (user 或 project)

4. 验证字段
   ├── name 缺失/无效 → 跳过，记录警告
   ├── description 缺失/无效 → 跳过，记录警告
   └── 应用默认值：user-invocable=true, disable-model-invocation=false

5. 处理重复名称
   ├── 后扫描的覆盖先扫描的（项目级覆盖用户级）
   └── 记录警告日志

6. 返回 Map<name, SkillInfo>
```

**辅助文件列表获取**（在 load 时执行）：
```
1. 扫描 Skill 目录
   └── listFiles(baseDir)

2. 过滤文件列表
   ├── 排除 SKILL.md
   └── 递归包含子目录文件

3. 生成相对路径列表
   └── 相对于 baseDir

4. 返回 files: string[]
```

**Frontmatter 解析**：
```typescript
// 使用 gray-matter 或类似库解析
interface ParsedSkillFile {
  data: {
    name: string
    description: string
    'user-invocable'?: boolean              // 默认 true
    'disable-model-invocation'?: boolean    // 默认 false
    license?: string
    compatibility?: string
    metadata?: Record<string, unknown>
  }
  content: string  // Markdown 正文
}
```

### 2.3 SkillTool

**职责**：作为 module 工具始终注册到 ToolScheduler，让 Agent 通过统一的工具调用路径加载 Skill。

**注册时机**：ToolScheduler 启动时**无条件**调用 `register(SkillTool, 'module')`。即便当前没有任何 model-invocable skill，SkillTool 仍存在，description 中提示 "No skills are currently available."（与 opencode 行为一致）。这样工具集合不随配置变化，避免"工具突然消失/出现"的不确定性。

**并发类别**：归到 `readonly`（与 `web_search` / `web_fetch` 同档）——加载一个 SKILL.md 是只读操作，可与其他只读工具并行，不阻塞写操作。

**工具定义**：
```typescript
const SkillTool: Tool = {
  name: 'skill',
  description: await buildDescription(),  // 动态构建，见 §2.4
  parameters: z.object({
    name: z.string().describe('The skill name to load')
  }),
  category: 'readonly',
  source: 'module',

  async execute(params, context) {
    const content = await registry.load(params.name)
    return formatOutput(content)
  }
}
```

**输出格式化**：
```typescript
function formatOutput(content: SkillContent): string {
  const lines = [
    `## Skill: ${content.info.name}`,
    '',
    `**Base directory**: ${content.baseDir}`,
    `**Source**: ${content.info.scope}`,  // user / project
  ]

  if (content.files.length > 0) {
    lines.push('')
    lines.push('**Available files**:')
    for (const file of content.files) {
      lines.push(`- ${file}`)
    }
  }

  lines.push('')
  lines.push(content.content.trim())

  return lines.join('\n')
}
```

### 2.4 SkillTool description 构建策略

**目标**：把所有 `disableModelInvocation: false` 的 Skill 名称+描述塞进 SkillTool 的 description，让 Agent 在看到工具列表时就知道有哪些 skill 可用。**约束**：description 不能撑爆系统提示。

**预算策略**（对齐 [claude-code 的 SkillTool prompt](claude-code/packages/builtin-tools/src/tools/SkillTool/prompt.ts)）：

| 常量 | 值 | 含义 |
|------|----|----|
| `SKILL_BUDGET_CONTEXT_PERCENT` | `0.01` | description 占上下文窗口的比例（1%） |
| `CHARS_PER_TOKEN` | `4` | token 估算系数 |
| `DEFAULT_CHAR_BUDGET` | `8000` | 当上下文窗口未知时的兜底预算（≈200k × 4 × 1%） |
| `MAX_LISTING_DESC_CHARS` | `250` | 单条 skill description 的硬上限 |

**构建流程**：

```
1. 获取所有 model-invocable skill（按名排序）
   └── registry.listModelInvocable()

2. 若列表为空
   └── 返回 "No skills are currently available."（SkillTool 仍注册，但 Agent 不会调）

3. 计算预算
   └── budget = floor(contextWindow × CHARS_PER_TOKEN × 0.01) || DEFAULT_CHAR_BUDGET

4. 全量拼接尝试
   ├── 每条格式：- <name>: <description>（description 单条截到 MAX_LISTING_DESC_CHARS）
   └── 若总长度 ≤ budget，直接返回

5. 超预算时的截断策略
   ├── 计算名字开销（- name: ）和分隔符开销
   ├── 剩余预算 / skill 数量 = 每条平均可用字符数
   ├── 每条 description 截到该长度
   └── 极端情况（剩余预算不够 MIN_DESC_LENGTH=20）：仅列名字
```

**description 格式示例**：

```
Load a skill to get detailed instructions for a specific task.

<available_skills>
- code-review: Comprehensive code review with focus on security, performance, and maintainability
- commit: Generate well-formatted commit messages following project conventions
- xlsx: Read and write Excel files using bundled scripts (read-xlsx.ts, write-xlsx.ts)
</available_skills>
```

**为什么走 SkillTool description 路线**（不走 opencode 的 system prompt 路线）：
- 与 ohbaby-agent 的 ToolScheduler 模型一致：所有"Agent 可见的能力"统一通过工具系统暴露
- 工具数+1 比 system prompt 膨胀代价小，且工具 description 是工具系统天然支持的扩展点
- 不需要改 system prompt 构建器，对其他模块零侵入

---

## 三、Design Patterns（设计模式）

### 3.1 懒加载模式（Lazy Loading）

**应用场景**：SkillRegistry 的缓存初始化

**实现方式**：
- 首次访问时才执行目录扫描
- 减少启动时间
- 按需加载

**选择理由**：
- Skill 扫描涉及文件系统 I/O，启动时未必需要
- 符合按需使用原则

### 3.2 缓存失效模式（Cache Invalidation）

**应用场景**：Skill 文件变更后的更新

**实现方式**：
- `invalidate()`：清除缓存，下次访问重新扫描
- `reload()`：立即重新扫描

**选择理由**：
- 简单可靠，避免文件监听的复杂性
- 用户可通过 CLI 命令触发重载
- 符合 YAGNI 原则

### 3.3 策略模式（Strategy Pattern）- 未使用

**考虑过但未使用的原因**：
- Skill 解析逻辑单一（只有 YAML frontmatter + Markdown）
- 不需要支持多种格式
- 保持简单

---

## 四、Module Structure & File Layout（模块结构与文件组织）

### 4.1 目录结构

```
src/skill/
├── index.ts              # 公共 API 导出
├── registry.ts           # SkillRegistry 实现
├── loader.ts             # SkillLoader 实现
├── tool.ts               # SkillTool 实现
├── types.ts              # 类型定义
├── errors.ts             # 自定义错误
└── __tests__/
    ├── registry.test.ts
    ├── loader.test.ts
    └── tool.test.ts
```

### 4.2 文件职责

| 文件 | 职责 | 对外稳定性 |
|------|------|------------|
| `index.ts` | 公共 API 导出 | **稳定** |
| `types.ts` | 类型定义 | **稳定** |
| `registry.ts` | 缓存管理和查询 | 内部实现 |
| `loader.ts` | 文件扫描和解析 | 内部实现 |
| `tool.ts` | SkillTool 实现 | 内部实现 |
| `errors.ts` | 错误类型定义 | **稳定** |

### 4.3 公共 API

```typescript
// index.ts

// 主要导出
export { Skill } from './registry'
export { SkillTool } from './tool'

// 类型导出
export type { SkillInfo, SkillContent } from './types'

// 错误导出
export { SkillNotFoundError, SkillInvalidError } from './errors'
```

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 5.1 懒加载 vs 启动时加载

**当前选择**：懒加载

**代价**：
- 首次访问时有延迟
- 可能在运行时才发现配置错误

**理由**：
- 减少启动时间
- 用户可能不使用 Skill 功能
- 可通过 CLI 命令提前验证

### 5.2 手动重载 vs 文件监听

**当前选择**：手动重载

**代价**：
- 文件变更后不会自动更新
- 需要用户手动触发

**理由**：
- 简化实现，避免跨平台文件监听问题
- Skill 文件不频繁变更
- 可在后续版本添加文件监听
- 符合 YAGNI 原则

### 5.3 同名覆盖 vs 报错

**当前选择**：同名覆盖（项目级覆盖全局级）

**代价**：
- 用户可能不知道 Skill 被覆盖

**理由**：
- 符合 OpenCode 行为
- 允许项目定制全局 Skill
- 通过警告日志提示用户

### 5.4 独立模块 vs 集成到 tools

**当前选择**：独立模块

**代价**：
- 增加一个模块
- 需要额外的注册逻辑

**理由**：
- 职责清晰（Skill 有独立的发现和解析逻辑）
- 便于独立测试
- 便于未来扩展（如 Skill 市场）

---

## 六、Error Handling（错误处理）

### 6.1 错误类型

| 错误类型 | 场景 | 处理方式 |
|----------|------|----------|
| `SkillNotFoundError` | 请求的 Skill 不存在 | 返回错误信息，列出可用 Skill |
| `SkillInvalidError` | SKILL.md 格式错误 | 跳过该文件，记录警告 |
| `SkillLoadError` | 文件读取失败 | 返回错误信息 |

### 6.2 错误处理策略

**扫描阶段**：
- 单个文件错误不影响其他文件
- 记录警告日志，继续扫描
- 返回所有有效的 Skill

**加载阶段**：
- 文件不存在或格式错误时抛出异常
- 由调用方（SkillTool）处理异常

---

## 七、Dependencies（依赖关系）

### 7.1 外部依赖

| 依赖 | 用途 |
|------|------|
| gray-matter | 解析 YAML frontmatter |
| zod | 参数验证 |
| glob | 文件模式匹配 |

### 7.2 内部依赖

| 依赖模块 | 依赖方式 | 用途 |
|----------|----------|------|
| Config | 运行时依赖 | 获取配置目录路径 |
| Log | 运行时依赖 | 记录警告和错误 |

### 7.3 被依赖

| 依赖方 | 调用接口 | 用途 |
|--------|----------|------|
| **Commands** | `listUserInvocable()`, `load()` | 注册 `/<name>` 命令，处理用户触发时加载 Skill 内容 |
| **ToolScheduler** | `SkillTool`（始终注册） | 注册为 module 工具，让 Agent 通过统一工具路径访问 |
| Permission | 间接（通过 SkillTool） | 评估 `skill:<name>` 权限规则 |

---

## 八、与 Commands 模块的集成（主要）

### 8.1 命令注册

Commands 模块在启动时获取所有 user-invocable 的 Skill：

```typescript
// 在 Commands 模块初始化时
import { Skill } from '@/skill'

async function registerSkillCommands() {
  const skills = await Skill.listUserInvocable()

  for (const skill of skills) {
    // 注册 /<skill-name> 命令
    registerCommand({
      name: skill.name,
      description: skill.description,
      handler: async (args, context) => {
        const content = await Skill.load(skill.name)
        // 将 Skill 内容注入到对话上下文
        await injectSkillToContext(content, context)
      }
    })
  }
}
```

### 8.2 Skill 内容注入

当用户触发 `/<skill-name>` 命令时：

```typescript
async function injectSkillToContext(
  content: SkillContent,
  context: ConversationContext
) {
  // 格式化 Skill 内容
  const formatted = formatSkillContent(content)

  // 注入到对话上下文（作为系统消息或用户消息）
  context.addMessage({
    role: 'user',  // 或 'system'，取决于实现
    content: formatted
  })
}
```

---

## 九、与 ToolScheduler 的集成

### 9.1 始终注册

ToolScheduler 启动时**无条件**注册 SkillTool 为 module 工具：

```typescript
// 在 ToolScheduler 初始化时
import { Skill, SkillTool } from '@/skill'

class ToolScheduler {
  async initialize() {
    // ... 注册 builtin 工具

    // 始终注册 SkillTool（无条件，与 builtin/module/mcp 来源模型一致）
    this.registry.register(SkillTool, 'module')

    // ... 注册 mcp 工具
  }
}
```

**为什么始终注册**：
- 工具集合不随配置变化，避免"工具突然消失/出现"破坏 prompt 缓存
- 即便当前没有 model-invocable skill，SkillTool description 提示 "No skills are currently available."，Agent 不会调用——零成本
- 用户运行时新增 skill 后只需 `Skill.invalidate()` + 重建 description，无需重新注册工具
- 与 claude-code 的 SkillTool 注册行为对齐

### 9.2 并发控制

SkillTool 归到 `readonly` 并发类别（与 `web_search` / `web_fetch` 同档）：
- 加载 SKILL.md 是只读操作，可与其他只读工具并行
- 不阻塞其他只读操作
- 被写操作阻塞

### 9.3 description 刷新

当 Skill 列表变化（`Skill.invalidate()` 后首次访问、Skill.reload() 显式重载）时，SkillTool 的 description 需重新构建。两种实现方式：

| 方式 | 说明 | 选择 |
|------|------|------|
| 每次拉取 description 时动态构建 | ToolScheduler 取 description 时调 `Skill.listModelInvocable()` 现算 | **推荐**：实现简单，与懒加载模式一致 |
| 缓存 description，按 invalidate 信号刷新 | Skill 模块通过 Bus 发事件，SkillTool 订阅刷新 | 性能更优，但增加耦合，YAGNI |

---

## 十、文档自检

- [x] 可以清楚说出每个子组件存在的理由
- [x] 不存在无法追溯到 goals-duty.md 的结构
- [x] 没有为了"优雅"而增加的复杂性
- [x] 设计模式的使用有明确理由
- [x] 约束与权衡已明确记录
- [x] 与 Commands 模块的集成方式清晰（用户路径）
- [x] 与 ToolScheduler 的集成方式清晰（Agent 路径，始终注册）
- [x] Skill 目录结构和辅助文件扫描逻辑已说明
- [x] 输出格式化包含文件列表
- [x] 新增接口（listUserInvocable, listModelInvocable）已定义
- [x] SkillTool description 预算策略已定义（1% 上下文，250 字符单条上限）
- [x] 设计理念（二维属性正交、对齐 claude-code）已贯穿全文
