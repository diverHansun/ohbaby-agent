# skill 模块 data-model.md

本文档描述 `skill` 模块的核心数据结构定义。

---

## 一、Core Types（核心类型）

### 1.1 SkillInfo

Skill 的元数据信息，用于列表展示和命令注册。

```typescript
interface SkillInfo {
  /** Skill 唯一标识（来自 YAML frontmatter 的 name 字段） */
  name: string

  /** Skill 描述（来自 YAML frontmatter 的 description 字段） */
  description: string

  /** SKILL.md 文件的绝对路径 */
  location: string

  /** Skill 目录的绝对路径（SKILL.md 所在目录） */
  baseDir: string

  /** 是否允许用户通过 /<name> 直接调用，默认 true */
  userInvocable: boolean

  /** 是否禁止 Agent 主动调用，默认 true（iris-code 设计：Skill 默认不暴露给 Agent） */
  disableModelInvocation: boolean

  /** Skill 来源：user（用户级）或 project（项目级） */
  scope: 'user' | 'project'
}
```

**Zod Schema**：
```typescript
const SkillInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  location: z.string(),
  baseDir: z.string(),
  userInvocable: z.boolean(),
  disableModelInvocation: z.boolean(),
  scope: z.enum(['user', 'project']),
})
```

### 1.2 SkillContent

Skill 的完整内容，用于实际加载。

```typescript
interface SkillContent {
  /** Skill 元数据 */
  info: SkillInfo

  /** SKILL.md 所在目录的绝对路径 */
  baseDir: string

  /** Markdown 正文内容（不包含 frontmatter） */
  content: string

  /**
   * Skill 目录中的辅助文件列表（相对于 baseDir 的路径）
   * 不包含 SKILL.md 本身
   * 示例: ['read-xlsx.ts', 'write-xlsx.ts', 'templates/component.tsx']
   */
  files: string[]
}
```

**辅助文件说明**：
- `files` 列出 Skill 目录中除 SKILL.md 之外的所有文件
- 路径相对于 `baseDir`，包含子目录中的文件
- Agent 可根据此列表了解可用的辅助资源
- 符合 opencode 的设计理念：提供 baseDir，让 Agent 自行探索

### 1.3 SkillFile

SKILL.md 文件的解析结果。

```typescript
interface SkillFile {
  /** YAML frontmatter 数据 */
  data: {
    name: string
    description: string
    [key: string]: unknown  // 允许扩展字段
  }

  /** Markdown 正文内容 */
  content: string
}
```

---

## 二、SKILL.md 文件格式

### 2.1 文件结构

```markdown
---
name: skill-name
description: Brief description of the skill
user-invocable: true
disable-model-invocation: true
---

# Skill Title

Detailed instructions and guidelines...
```

### 2.2 Frontmatter 字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | **是** | - | Skill 唯一标识，用于 `/<name>` 命令调用 |
| `description` | string | **是** | - | 简短描述，显示在命令列表中 |
| `user-invocable` | boolean | 否 | `true` | 是否允许用户通过 `/<name>` 直接调用 |
| `disable-model-invocation` | boolean | 否 | `true` | 是否禁止 Agent 主动调用 |
| `license` | string | 否 | - | 许可证信息 |
| `compatibility` | string | 否 | - | 兼容性说明 |
| `metadata` | object | 否 | - | 自定义元数据 |

**iris-code 设计理念**：
- `disable-model-invocation` 默认为 `true`，即 **Skill 默认不暴露给 Agent**
- 用户通过 `/<skill-name>` 手动触发，按需注入到对话上下文
- 这与 Claude Code 不同（Claude Code 默认暴露给 Agent 自动发现）

**验证 Schema**：
```typescript
/**
 * name 字段基础验证
 */
const SkillNameSchema = z.string()
  .min(1, 'Skill name is required')
  .max(64, 'Skill name must be at most 64 characters')
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Skill name must be lowercase letters, numbers, and hyphens only'
  )

/**
 * description 字段基础验证
 */
const SkillDescriptionSchema = z.string()
  .min(1, 'Skill description is required')
  .max(1024, 'Skill description must be at most 1024 characters')

/**
 * 完整 Frontmatter Schema
 */
const SkillFrontmatterSchema = z.object({
  // 必填字段
  name: SkillNameSchema,
  description: SkillDescriptionSchema,

  // 可选字段
  'user-invocable': z.boolean().optional().default(true),
  'disable-model-invocation': z.boolean().optional().default(true),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
```

### 2.3 命名规范

**name 字段规范**：
- 小写字母、数字、连字符（`-`）
- 不能以连字符开头或结尾
- 不能包含连续连字符
- 最多 64 字符
- 示例：`code-review`、`commit-message`、`react-best-practices`

**文件路径规范**：
- 目录名建议与 name 一致
- 文件必须命名为 `SKILL.md`（大写）

---

## 三、错误类型

### 3.1 SkillNotFoundError

请求的 Skill 不存在时抛出。

```typescript
class SkillNotFoundError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly availableSkills: string[]
  ) {
    super(`Skill "${skillName}" not found. Available skills: ${availableSkills.join(', ') || 'none'}`)
    this.name = 'SkillNotFoundError'
  }
}
```

### 3.2 SkillInvalidError

SKILL.md 文件格式无效时使用（记录警告，不抛出）。

```typescript
interface SkillInvalidError {
  path: string
  message: string
  issues?: z.ZodIssue[]  // Zod 验证错误详情
}
```

### 3.3 SkillLoadError

文件读取失败时抛出。

```typescript
class SkillLoadError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: Error
  ) {
    super(`Failed to load skill from ${path}: ${cause.message}`)
    this.name = 'SkillLoadError'
  }
}
```

---

## 四、SkillTool 相关类型

### 4.1 工具参数

```typescript
const SkillToolParamsSchema = z.object({
  /** 要加载的 Skill 名称 */
  name: z.string().describe('The skill name to load (e.g., "code-review")')
})

type SkillToolParams = z.infer<typeof SkillToolParamsSchema>
```

### 4.2 工具返回值

```typescript
interface SkillToolResult {
  /** 显示标题 */
  title: string

  /** 格式化的输出内容 */
  output: string

  /** 元数据 */
  metadata: {
    name: string
    dir: string
    files: string[]  // 辅助文件列表
  }
}
```

**输出格式示例**：

简单 Skill（无辅助文件）：
```
## Skill: code-review

**Base directory**: /path/to/.iris-code/skill/code-review

# Code Review Guidelines

[Skill 内容...]
```

包含辅助文件的 Skill：
```
## Skill: xlsx

**Base directory**: /path/to/.iris-code/skill/xlsx

**Available files**:
- read-xlsx.ts
- write-xlsx.ts

# XLSX Processing Skill

[Skill 内容...]
```

---

## 五、配置相关类型

### 5.1 Skill 权限配置

在 Agent 配置中定义 Skill 权限：

```typescript
interface SkillPermissionConfig {
  /** 权限规则映射，支持通配符 */
  [pattern: string]: 'allow' | 'deny' | 'ask'
}

// 示例
const skillPermission: SkillPermissionConfig = {
  '*': 'allow',           // 默认允许
  'dangerous-*': 'deny',  // 拒绝以 dangerous- 开头的 Skill
  'external-*': 'ask',    // 需要询问用户
}
```

### 5.2 Permission Pattern

Skill 权限的 Pattern 格式：

```
skill:<name>

示例：
- skill:*           → 匹配所有 Skill
- skill:code-*      → 匹配以 code- 开头的 Skill
- skill:code-review → 匹配特定 Skill
```

---

## 六、内部类型

### 6.1 ScanResult

目录扫描结果。

```typescript
interface ScanResult {
  /** 有效的 Skill 映射 */
  skills: Map<string, SkillInfo>

  /** 无效的文件列表（用于日志记录） */
  invalid: SkillInvalidError[]
}
```

### 6.2 ConfigDirectory

配置目录信息。

```typescript
interface ConfigDirectory {
  /** 目录类型 */
  type: 'global' | 'project'

  /** 目录绝对路径 */
  path: string

  /** 优先级（数字越大优先级越高） */
  priority: number
}
```

---

## 七、与 OpenCode/Claude Code 的兼容性

### 7.1 类型对照

| OpenCode | Claude Code | iris-code | 说明 |
|----------|-------------|-----------|------|
| `Skill.Info` | - | `SkillInfo` | 兼容，iris-code 增加 scope、userInvocable 等字段 |
| `Skill.InvalidError` | - | `SkillInvalidError` | 结构相同 |
| - | `user-invocable` | `userInvocable` | 兼容 Claude Code 字段 |
| - | `disable-model-invocation` | `disableModelInvocation` | 兼容 Claude Code 字段 |

### 7.2 文件格式兼容性

iris-code 的 SKILL.md 格式与 OpenCode/Claude Code 兼容：
- YAML frontmatter 格式相同
- 必填字段相同（name, description）
- 可选字段兼容 Claude Code（user-invocable, disable-model-invocation）
- Markdown 正文格式相同

### 7.3 目录结构兼容性

iris-code 完全支持 OpenCode/Claude Code 的 Skill 目录结构：
- Skill 是一个目录，包含 SKILL.md 和可选的辅助文件
- 辅助文件可以是脚本、模板、资源等
- opencode 提供 `baseDir`（通过 `dir` 字段）让 Agent 自行探索
- iris-code 额外提供 `files` 列表，方便 Agent 了解可用资源

### 7.4 设计差异

iris-code 与 Claude Code/opencode 的主要差异：

| 特性 | Claude Code | opencode | iris-code |
|------|-------------|----------|-----------|
| Agent 自动发现 Skill | ✅ 默认启用 | ✅ 默认启用 | ❌ 默认禁用 |
| `disable-model-invocation` 默认值 | `false` | - | `true` |
| Skill 触发方式 | Agent 自动 + 用户手动 | Agent 自动 + 用户手动 | **仅用户手动** |
| Skill 元数据加载时机 | 启动时 | 启动时 | 按需（用户触发时） |

**iris-code 设计理念**：
- Skill 是用户的专属工具，用户明确知道何时需要使用
- 避免 Skill 元数据占用系统提示 Token
- 通过 `/<skill-name>` 按需注入，保持上下文简洁

### 7.5 增强功能

iris-code 在兼容基础上增加：
- `SkillInfo.baseDir`：在元数据中直接提供目录路径
- `SkillInfo.scope`：标识 Skill 来源（user/project）
- `SkillContent.files`：列出目录中的辅助文件
- 输出中显示 `Available files` 列表（当有辅助文件时）

---

## 八、文档自检

- [x] 所有核心类型都有明确定义
- [x] 类型与 architecture.md 中的组件对应
- [x] 错误类型覆盖所有异常场景
- [x] 与 OpenCode/Claude Code 的兼容性已说明
- [x] Zod Schema 用于运行时验证
- [x] Skill 目录结构和辅助文件支持已说明
- [x] files 字段的用途和格式已明确
- [x] 新增字段（userInvocable, disableModelInvocation, scope）已定义
- [x] iris-code 与 Claude Code 的设计差异已明确说明
- [x] 字段验证规则（name 64字符限制、description 1024字符限制）已定义
