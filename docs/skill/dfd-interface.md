# skill 模块 dfd-interface.md

本文档描述 `skill` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 1.1 模块位置

```
┌──────────────────────────────────────────────────────────────────┐
│                         用户                                     │
│                          │                                       │
│            ┌─────────────┴──────────────┐                        │
│            │                            │                        │
│            ▼                            ▼                        │
│   ┌─────────────────┐       ┌─────────────────────┐            │
│   │ 文件系统         │       │ CLI / Commands      │            │
│   │ (SKILL.md 文件)  │       │ (/<skill-name>)     │            │
│   └────────┬────────┘       └────────┬────────────┘            │
│            │                         │                          │
│            │                         │ (主要消费者)              │
│            ▼                         ▼                          │
│   ┌────────────────────────────────────────────────┐           │
│   │                 Skill 模块                      │           │
│   │                                                 │           │
│   │  SkillLoader ──→ SkillRegistry                 │           │
│   │                      │                          │           │
│   │                      │ (可选)                   │           │
│   │                      └──→ SkillTool             │           │
│   └──────────────────────┬──────────────────────────┘           │
│                          │                                      │
│                          ▼ (仅当存在 model-invocable skills)     │
│   ┌────────────────────────────────────────────────┐           │
│   │              ToolScheduler                      │           │
│   │                    │                            │           │
│   │                    ▼                            │           │
│   │  Permission ←── Policy ←── Agent/Lifecycle     │           │
│   └────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| 文件系统 | 输入 | 读取 SKILL.md 文件和目录中的辅助文件列表 |
| Config | 输入 | 获取配置目录路径 |
| **Commands** | **双向（主要）** | **注册 user-invocable skills 为斜杠命令；接收 reload 命令** |
| ToolScheduler | 输出（可选） | 仅当存在 model-invocable skills 时注册 SkillTool |
| Permission | 间接 | 通过 ToolScheduler 进行权限检查（仅 model-invocable） |

---

## 二、Data Flow Description（数据流描述）

### 2.1 Skill 发现流程

```
1. [外部] Config 模块提供配置目录列表（按优先级）
   ├── 项目目录: .iris-code/skill/
   └── 全局目录: ~/.config/iris-code/skill/

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

### 2.3 Skill 加载流程（Agent 调用 - 可选路径）

**注意**：此流程仅在 Skill 配置 `disable-model-invocation: false` 时才可用。默认情况下，Agent 不知道 Skill 的存在。

```
1. [外部] Agent 通过 ToolScheduler 调用 skill 工具
   └── 参数: { name: "code-review" }
   └── 前提: SkillTool 已注册（存在 model-invocable skills）

2. [外部] ToolScheduler 执行权限检查
   ├── 查询 Policy 获取决策
   ├── 决策为 'ask' → 调用 Permission.ask()
   └── 决策为 'deny' → 拒绝执行

3. [内部] SkillTool.execute() 被调用
   └── 调用 SkillRegistry.load(name)

4. [内部] SkillRegistry 查找 Skill
   ├── 缓存命中 → 返回 SkillInfo
   └── 缓存未命中 → 触发扫描

5. [内部] SkillLoader 读取 Skill 目录内容
   ├── 解析 SKILL.md，提取 content
   ├── 扫描目录，列出辅助文件
   └── 返回 SkillContent（含 files 列表）

6. [内部] SkillTool 格式化输出
   ├── 包含 baseDir
   ├── 包含 files 列表（如有辅助文件）
   └── 返回 { title, output, metadata }

7. [外部] ToolScheduler 返回结果给 Agent
   └── Agent 可通过 baseDir 访问辅助文件
```

### 2.4 Skill 重载流程（CLI 命令）

```
1. [外部] 用户执行 CLI 命令
   └── iris-code skill reload

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
| 调用方 | ToolScheduler（用于决定是否注册 SkillTool） |
| 输入 | 无 |
| 输出 | disableModelInvocation 为 false 的 SkillInfo 数组 |
| 副作用 | 首次调用触发目录扫描 |

### 3.2 SkillTool 接口（可选）

**注意**：SkillTool 仅在存在 `disableModelInvocation: false` 的 Skill 时才注册到 ToolScheduler。默认情况下，所有 Skills 都是 `disableModelInvocation: true`，因此 SkillTool 通常不会注册。

```typescript
const SkillTool: Tool = {
  name: 'skill',
  description: string,  // 动态生成，仅包含 model-invocable Skill 列表
  parameters: z.object({
    name: z.string()
  }),
  category: 'skill',
  source: 'module',
  execute: async (params, context) => SkillToolResult
}
```

| 项 | 说明 |
|----|------|
| 注册条件 | 存在至少一个 `disableModelInvocation: false` 的 Skill |
| 注册方 | ToolScheduler |
| 参数 | `{ name: string }` |
| 返回值 | `{ title, output, metadata }` |
| 权限类别 | skill（readonly 级别） |
| description 内容 | 仅包含 model-invocable 的 Skill（不包含 user-only skills） |

### 3.3 依赖的外部接口

#### Config.getGlobalConfigDir()

获取全局配置目录。

```typescript
function getGlobalConfigDir(): string
// Linux/macOS: ~/.config/iris-code/
// Windows: %APPDATA%/iris-code/
```

#### Config.getProjectConfigDir()

获取项目配置目录。

```typescript
function getProjectConfigDir(): string | undefined
// 返回: {projectRoot}/.iris-code/ 或 undefined
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

| 事件 | 触发时机 | 携带数据 |
|------|----------|----------|
| `Skill.Event.Reloaded` | 重载完成 | 新的 Skill 列表 |
| `Skill.Event.LoadFailed` | 加载失败 | 错误信息 |

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

这种设计的优势：
- **按需加载**：只在用户触发时加载 Skill，避免 Token 浪费
- **用户主导**：用户明确知道何时使用哪个 Skill
- **简洁上下文**：Agent 的系统 prompt 不被 Skill 列表干扰
- **明确控制**：Skill 默认对 Agent 不可见（disable-model-invocation: true）

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

### 8.2 Agent 调用 Skill 序列（可选路径 - 仅当 disable-model-invocation: false）

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
- [x] 用户调用流程（主要路径）已清晰说明
- [x] Agent 调用流程（可选路径）已标注条件
- [x] Commands 模块集成已详细说明
- [x] 新增字段（userInvocable, disableModelInvocation, scope）已体现在数据流中
- [x] 新增接口（listUserInvocable, listModelInvocable）已完整定义
- [x] SkillTool 作为可选组件的条件已明确
