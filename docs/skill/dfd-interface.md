# skill 模块 dfd-interface.md

本文档描述 `skill` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 1.1 模块位置

```
┌──────────────────────────────────────────────────────────────────┐
│                              用户                                 │
│                               │                                   │
│         ┌─────────────────────┼─────────────────────┐             │
│         │                     │                     │             │
│         ▼                     ▼                     ▼             │
│  ┌───────────┐      ┌──────────────────┐   ┌──────────────┐      │
│  │ 文件系统  │      │ CLI / Commands   │   │  Agent       │      │
│  │ SKILL.md  │      │ (/<skill-name>)  │   │ (LLM 决策)   │      │
│  └─────┬─────┘      └────────┬─────────┘   └──────┬───────┘      │
│        │                     │ 用户路径           │ Agent 路径    │
│        │                     │                    ▼               │
│        │                     │           ┌────────────────┐       │
│        │                     │           │ ToolScheduler  │       │
│        │                     │           │ • 注册SkillTool│       │
│        │                     │           │ • 权限评估     │       │
│        │                     │           │ • 调度执行     │       │
│        │                     │           └───────┬────────┘       │
│        │                     │                   │                │
│        ▼                     ▼                   ▼                │
│  ┌────────────────────────────────────────────────────────┐      │
│  │                    Skill 模块                            │      │
│  │                                                          │      │
│  │  SkillLoader ──扫描──→ SkillRegistry ──导出──→ SkillTool│      │
│  │                            │                              │      │
│  │              listUserInvocable()  listModelInvocable()   │      │
│  │              (供 Commands)         (供 SkillTool desc)   │      │
│  │              load()  ──── load()                          │      │
│  └──────────────────────────────────────────────────────────┘      │
│                              │                                     │
│                              ▼                                     │
│                    ┌───────────────────┐                          │
│                    │  Permission        │                          │
│                    │ (skill:<name>)     │ ← 仅 Agent 路径          │
│                    └───────────────────┘                          │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| 文件系统 | 输入 | 读取 SKILL.md 文件和目录中的辅助文件列表 |
| Config | 输入 | 获取配置目录路径 |
| **Commands** | **双向（用户路径）** | 启动时拉 `listUserInvocable()` 注册斜杠命令；用户触发时调 `load()`；接收 reload 命令 |
| **ToolScheduler** | **双向（Agent 路径）** | 启动时无条件注册 SkillTool 为 module 工具；构建 description 时调 `listModelInvocable()`；Agent 调用时调 `load()` |
| Permission | 间接（通过 SkillTool） | SkillTool 执行时评估 `skill:<name>` 权限规则 |

---

## 二、Data Flow Description（数据流描述）

### 2.1 Skill 发现流程

```
1. [外部] Config 模块提供配置目录列表（按优先级）
   ├── 项目目录: .ohbaby/skills/
   └── 全局目录: ~/.ohbaby/skills/

2. [内部] SkillLoader 扫描目录
   └── Glob 模式: **/SKILL.md

3. [内部] 对每个 Skill 目录进行解析
   ├── 读取 SKILL.md 文件内容
   ├── 解析 YAML frontmatter
   ├── 提取必填字段: name, description
   ├── 提取可选字段: user-invocable, disable-model-invocation, license, compatibility
   ├── 记录 baseDir（SKILL.md 所在目录）
   └── 记录 scope（'project' 或 'user'）

4. [内部] 验证字段
   ├── 基础验证：name (64 chars, lowercase+numbers+hyphens), description (1024 chars)
   ├── 有效 → 添加到结果集
   └── 无效 → 记录警告，跳过

5. [内部] 处理重复名称
   └── 项目级覆盖全局级（scope: 'project' 优先）

6. [内部] SkillRegistry 缓存结果
   └── Map<name, SkillInfo>（包含所有字段）
```

### 2.2 Skill 加载流程（用户调用 - 主要路径）

```
1. [外部] 用户输入斜杠命令
   └── 例如: /code-review "review this function"

2. [外部] Commands 模块识别命令
   ├── 在已注册的 user-invocable skills 中查找
   └── 找到: code-review

3. [外部] Commands 调用 Skill.load(name)
   └── 参数: "code-review"

4. [内部] SkillRegistry 查找 Skill
   ├── 缓存命中 → 返回 SkillInfo
   └── 缓存未命中 → 触发扫描

5. [内部] SkillLoader 读取 Skill 目录内容
   ├── 解析 SKILL.md，提取 content
   ├── 扫描目录，列出辅助文件
   └── 返回 SkillContent（含 files 列表）

6. [外部] Commands 将 Skill 内容注入到上下文
   ├── 包含 baseDir 路径
   ├── 包含 Skill 完整指令
   └── 附加用户的 prompt

7. [外部] Agent 接收包含 Skill 指令的上下文
   └── Agent 按照 Skill 指令执行任务
```

### 2.3 Skill 加载流程（Agent 调用 - Agent 路径）

**前置条件**：SkillTool 已由 ToolScheduler 在启动时无条件注册。Agent 在工具列表中看到 `skill` 工具及其 description（含所有 `disableModelInvocation: false` 的 skill 名+描述）。

```
1. [启动时] ToolScheduler 注册 SkillTool
   └── this.registry.register(SkillTool, 'module')

2. [构建工具列表时] SkillTool description 动态构建
   ├── 调用 SkillRegistry.listModelInvocable()
   ├── 应用 1% 上下文预算策略（详见 architecture.md §2.4）
   ├── 列表为空 → "No skills are currently available."
   └── 列表非空 → "<available_skills>...<skill>...</skill>...</available_skills>"

3. [外部] Agent 决策调用 skill 工具
   └── 参数: { name: "code-review" }

4. [外部] ToolScheduler 执行权限评估
   ├── pattern: skill:code-review
   ├── 查询 Policy 获取决策
   ├── 决策为 'ask' → 调用 Permission.ask()
   ├── 决策为 'deny' → 拒绝执行，返回错误
   └── 决策为 'allow' → 继续

5. [内部] SkillTool.execute() 被调用
   └── 调用 SkillRegistry.load(name)

6. [内部] SkillRegistry 查找 Skill
   ├── 缓存命中 → 返回 SkillInfo
   └── 缓存未命中 → 触发扫描

7. [内部] SkillLoader 读取 Skill 目录内容
   ├── 解析 SKILL.md，提取 content
   ├── 扫描目录，列出辅助文件
   └── 返回 SkillContent（含 files 列表）

8. [内部] SkillTool 格式化输出
   ├── 包含 baseDir
   ├── 包含 files 列表（如有辅助文件）
   └── 返回 { title, output, metadata }

9. [外部] ToolScheduler 返回 tool result 给 Agent
   └── Agent 可通过 baseDir 访问辅助文件
```

### 2.4 Skill 重载流程（CLI 命令）

```
1. [外部] 用户执行 CLI 命令
   └── ohbaby-agent skill reload

2. [外部] Commands 模块调用 Skill.reload()

3. [内部] SkillRegistry.reload()
   ├── 调用 SkillLoader.scan()
   └── 更新缓存

4. [内部] 记录加载结果日志

5. [外部] CLI 显示结果给用户
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外公共接口

#### Skill.all()

获取所有可用 Skill 列表。

```typescript
async function all(): Promise<SkillInfo[]>
```

| 项 | 说明 |
|----|------|
| 调用方 | SkillTool、Commands |
| 输入 | 无 |
| 输出 | SkillInfo 数组 |
| 副作用 | 首次调用触发目录扫描 |

#### Skill.get()

按名称获取单个 Skill。

```typescript
async function get(name: string): Promise<SkillInfo | undefined>
```

| 项 | 说明 |
|----|------|
| 调用方 | SkillTool |
| 输入 | Skill 名称 |
| 输出 | SkillInfo 或 undefined |
| 副作用 | 首次调用触发目录扫描 |

#### Skill.load()

加载 Skill 的完整内容。

```typescript
async function load(name: string): Promise<SkillContent>
```

| 项 | 说明 |
|----|------|
| 调用方 | SkillTool |
| 输入 | Skill 名称 |
| 输出 | SkillContent（包含完整 Markdown 内容） |
| 异常 | SkillNotFoundError、SkillLoadError |

#### Skill.invalidate()

使缓存失效。

```typescript
function invalidate(): void
```

| 项 | 说明 |
|----|------|
| 调用方 | Commands |
| 输入 | 无 |
| 输出 | 无 |
| 副作用 | 清除缓存，下次访问重新扫描 |

#### Skill.reload()

强制重新加载所有 Skill。

```typescript
async function reload(): Promise<void>
```

| 项 | 说明 |
|----|------|
| 调用方 | Commands |
| 输入 | 无 |
| 输出 | 无 |
| 副作用 | 立即重新扫描并更新缓存 |

#### Skill.listUserInvocable()

获取所有用户可调用的 Skill 列表（`userInvocable: true`）。

```typescript
async function listUserInvocable(): Promise<SkillInfo[]>
```

| 项 | 说明 |
|----|------|
| 调用方 | Commands（用于注册斜杠命令） |
| 输入 | 无 |
| 输出 | userInvocable 为 true 的 SkillInfo 数组 |
| 副作用 | 首次调用触发目录扫描 |

#### Skill.listModelInvocable()

获取所有模型可调用的 Skill 列表（`disableModelInvocation: false`）。

```typescript
async function listModelInvocable(): Promise<SkillInfo[]>
```

| 项 | 说明 |
|----|------|
| 调用方 | SkillTool（用于动态构建 description） |
| 输入 | 无 |
| 输出 | disableModelInvocation 为 false 的 SkillInfo 数组（按名排序） |
| 副作用 | 首次调用触发目录扫描 |

### 3.2 SkillTool 接口

**注册方式**：SkillTool 由 ToolScheduler 在启动时**无条件注册**为 module 工具，不依赖 Skill 列表是否为空。

```typescript
const SkillTool: Tool = {
  name: 'skill',
  description: await buildDescription(),  // 动态构建，列出 model-invocable Skill
  parameters: z.object({
    name: z.string().describe('The skill name to load')
  }),
  category: 'readonly',
  source: 'module',
  execute: async (params, context) => SkillToolResult
}

// description 构建逻辑
async function buildDescription(): Promise<string> {
  const skills = await Skill.listModelInvocable()
  if (skills.length === 0) {
    return 'No skills are currently available.'
  }
  // 应用 1% 上下文预算策略，详见 architecture.md §2.4
  return formatCommandsWithinBudget(skills, contextWindowTokens)
}
```

| 项 | 说明 |
|----|------|
| 注册条件 | **无条件**（始终注册） |
| 注册方 | ToolScheduler（启动时） |
| 参数 | `{ name: string }` |
| 返回值 | `{ title, output, metadata }` |
| 并发类别 | `readonly`（与 web_search / web_fetch 同档） |
| description 内容 | 仅列出 model-invocable Skill（不包含 user-only skills），按 1% 上下文预算 |
| description 刷新 | 每次 ToolScheduler 取 description 时调 `listModelInvocable()` 现算 |
| 空列表行为 | description 提示 "No skills are currently available."，工具仍存在 |

### 3.3 依赖的外部接口

#### Config.getGlobalConfigDir()

获取全局配置目录。

```typescript
function getGlobalConfigDir(): string
// Linux/macOS: ~/.ohbaby/
// Windows: %USERPROFILE%/.ohbaby/
```

#### Config.getProjectConfigDir()

获取项目配置目录。

```typescript
function getProjectConfigDir(): string | undefined
// 返回: {projectRoot}/.ohbaby/ 或 undefined
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据归属

| 数据 | 创建者 | 所有者 | 更新者 |
|------|--------|--------|--------|
| SKILL.md 文件 | 用户 | 用户 | 用户 |
| 辅助文件（脚本、模板等） | 用户 | 用户 | 用户 |
| SkillInfo 缓存 | SkillLoader | SkillRegistry | SkillRegistry |
| SkillContent（含 files） | SkillLoader | 临时（返回后释放） | - |

### 4.2 责任边界

| 职责 | 负责模块 |
|------|----------|
| SKILL.md 和辅助文件的创建、编辑、删除 | 用户（通过文件系统） |
| Skill 目录发现和解析 | Skill 模块（SkillLoader） |
| 辅助文件列表获取 | Skill 模块（SkillLoader） |
| 缓存管理 | Skill 模块（SkillRegistry） |
| 权限检查 | ToolScheduler + Permission |
| 工具调度 | ToolScheduler |
| 辅助文件的读取和执行 | Agent（通过 baseDir 路径） |

### 4.3 缓存一致性

**当前策略**：手动失效

- 文件变更后，缓存不会自动更新
- 用户需要通过 `Skill.reload()` 或 CLI 命令手动刷新
- 这是有意的设计决策（见 architecture.md）

**一致性保证**：
- 单次请求内，缓存数据一致
- 重载后，所有后续请求获取新数据
- 不存在部分更新状态

---

## 五、事件（可选扩展）

当前版本不发布事件。未来可扩展：

| 事件 | 触发时机 | 携带数据 | 用途 |
|------|----------|----------|------|
| `Skill.Event.Reloaded` | 重载完成 | 新的 Skill 列表 | 让 SkillTool 缓存的 description 失效；让 Commands 重新注册斜杠命令 |
| `Skill.Event.LoadFailed` | 加载失败 | 错误信息 | UI 通知 |

> 当前 description 采用"取时现算"策略（见 [architecture.md §9.3](architecture.md#L580)），不缓存，因此事件刷新机制属于性能优化而非必需。

---

## 六、与 Permission 的集成

### 6.1 权限类型

Skill 权限作为新的权限类型添加到 Permission 模块：

```typescript
type PermissionType = 'tool' | 'bash' | 'skill'
```

### 6.2 权限检查流程

```
1. ToolScheduler 接收 skill 工具调用
2. 查询 Policy 获取决策（基于 Agent 配置的 skill 权限）
3. 决策为 'ask' 时，调用 Permission.ask()
   └── type: 'skill'
   └── pattern: skill:<name>
   └── title: 'Load skill: <name>'
4. 用户响应后继续或拒绝
```

### 6.3 Agent 权限配置

```typescript
// Agent 配置中的 skill 权限
{
  permission: {
    skill: {
      '*': 'allow',           // 默认允许
      'dangerous-*': 'deny',  // 拒绝模式
    }
  }
}
```

---

## 七、与 Commands 模块的集成

### 7.1 Skill 命令注册流程

Commands 模块在启动时注册所有 user-invocable skills 为斜杠命令。

```typescript
// Commands 模块初始化时
async function registerSkillCommands() {
  const skills = await Skill.listUserInvocable()

  for (const skill of skills) {
    registerCommand({
      name: skill.name,
      description: skill.description,
      handler: async (args, context) => {
        // 加载 Skill 完整内容
        const content = await Skill.load(skill.name)

        // 将 Skill 内容注入到对话上下文
        await injectSkillToContext(content, context)
      }
    })
  }
}
```

### 7.2 数据流总结

```
用户输入 /<skill-name>
    ↓
Commands 模块识别命令
    ↓
Skill.load(name) 获取完整内容
    ↓
Commands 将内容注入到上下文
    ↓
Agent 接收包含 Skill 指令的上下文
    ↓
Agent 执行任务
```

用户路径的设计要点：
- **完整内容注入**：用户显式触发表示明确意图，注入完整 SKILL.md 内容到对话上下文
- **不经过 SkillTool**：用户路径与 Agent 路径解耦，Commands 直接调 `Skill.load()`，不走工具调度
- **不消耗 Agent 决策成本**：用户已替 Agent 做出"使用哪个 skill"的决定

> Agent 路径（SkillTool）的数据流见 §2.3。两条路径基于同一份 SkillRegistry 缓存，保证视图一致。

---

## 八、序列图

### 8.1 用户调用 Skill 序列（主要路径）

```
用户        Commands      SkillRegistry      SkillLoader      Agent
  │             │               │                  │            │
  │─ /code-review ────→│               │                  │            │
  │             │               │                  │            │
  │             │─── load("code-review") ─→│                  │            │
  │             │               │                  │            │
  │             │               │─── loadContent ─→│            │
  │             │               │                  │            │
  │             │               │←── SkillContent ─│            │
  │             │               │                  │            │
  │             │←── SkillContent ──────────│                  │            │
  │             │               │                  │            │
  │             │─────── inject context ───────────────────────→│
  │             │               │                  │            │
  │             │               │                  │            │─ execute task
  │             │               │                  │            │  with skill
  │             │               │                  │            │  instructions
```

### 8.2 Agent 调用 Skill 序列（Agent 路径 - SkillTool 始终注册）

```
Agent          ToolScheduler      Policy      Permission      SkillTool      SkillRegistry      SkillLoader
  │                 │               │             │              │                │                  │
  │─── execute ────→│               │             │              │                │                  │
  │    skill        │               │             │              │                │                  │
  │                 │─── check ────→│             │              │                │                  │
  │                 │               │             │              │                │                  │
  │                 │←── 'ask' ─────│             │              │                │                  │
  │                 │               │             │              │                │                  │
  │                 │────────── ask ────────────→│              │                │                  │
  │                 │               │             │              │                │                  │
  │                 │←─────── 'once' ────────────│              │                │                  │
  │                 │               │             │              │                │                  │
  │                 │───────────────────────────────── execute ─→│                │                  │
  │                 │               │             │              │                │                  │
  │                 │               │             │              │──── load ─────→│                  │
  │                 │               │             │              │                │                  │
  │                 │               │             │              │                │─── loadContent ─→│
  │                 │               │             │              │                │                  │
  │                 │               │             │              │                │←── SkillContent ─│
  │                 │               │             │              │                │                  │
  │                 │               │             │              │←── SkillContent│                  │
  │                 │               │             │              │                │                  │
  │                 │←───────────────────────────────── result ──│                │                  │
  │                 │               │             │              │                │                  │
  │←─── result ─────│               │             │              │                │                  │
```

---

## 九、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任不清或重复处理的风险已排除
- [x] 与 Permission、ToolScheduler 的集成流程清晰
- [x] 缓存一致性策略明确
- [x] Skill 目录和辅助文件的数据流已说明
- [x] Agent 访问辅助文件的责任边界已明确
- [x] 用户调用流程（用户路径）已清晰说明
- [x] Agent 调用流程（Agent 路径）已清晰说明，含 SkillTool 始终注册的语义
- [x] Commands 模块集成（用户路径）和 ToolScheduler 集成（Agent 路径）均已详细说明
- [x] 新增字段（userInvocable, disableModelInvocation, scope）已体现在数据流中
- [x] 新增接口（listUserInvocable, listModelInvocable）已完整定义
- [x] SkillTool 始终注册的语义已明确（包括空列表退化行为）
- [x] 两条路径基于同一份缓存的视图一致性已说明
