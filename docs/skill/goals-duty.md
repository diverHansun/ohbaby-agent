# skill 模块 goals-duty.md

本文档定义 `skill` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/skill/`
- 文档：`docs/skill/`

**模块定位**：Skill 是用户的可扩展技能系统，允许用户通过 Markdown 文件定义专业指令，**用户按需触发**后注入到对话上下文，Agent 根据指令执行特定任务。

**重要概念**：Skill 是一个**目录**，而非单个文件。每个 Skill 目录包含：
- `SKILL.md`：必需的主文件，包含 YAML frontmatter 和 Markdown 指令
- 辅助文件（可选）：脚本、模板、资源文件等，供 Agent 在执行任务时使用

**ohbaby-code 设计理念**（与 Claude Code/opencode 的差异）：
```
┌─────────────────────────────────────────────────────────────────┐
│                    ohbaby-code Skill 设计                          │
├─────────────────────────────────────────────────────────────────┤
│  • 用户主导：Skill 默认不暴露给 Agent，用户通过 /<name> 触发     │
│  • 按需加载：启动时不加载 Skill 元数据，避免 Token 浪费          │
│  • 明确控制：用户清楚知道何时使用哪个 Skill                      │
│  • 简洁上下文：Agent 上下文不被 Skill 列表干扰                   │
└─────────────────────────────────────────────────────────────────┘

对比 Claude Code/opencode：
┌─────────────────────────────────────────────────────────────────┐
│  • Agent 自动发现：启动时加载 Skill 元数据到系统提示             │
│  • Agent 主动调用：Agent 可根据任务自动选择和加载 Skill          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 一、Design Goals（设计目标）

### G1: 提供用户主导的技能扩展机制

允许用户通过标准化的 Markdown 文件定义专业技能，用户通过 `/<skill-name>` 命令按需触发，将 Skill 内容注入到对话上下文中。

### G2: 兼容 OpenCode/Claude Code 的 Skill 格式

文件格式兼容，但加载机制不同：
- SKILL.md 文件格式兼容（YAML frontmatter + Markdown 内容）
- 支持 Skill 目录中的辅助文件（脚本、模板等）
- 支持 Claude Code 的 `user-invocable` 和 `disable-model-invocation` 字段
- 现有的 OpenCode/Claude Code Skill 文件可以直接复用

### G3: 支持多层级配置目录（XDG 标准）

支持用户级和项目级 Skill 配置，项目级配置覆盖用户级配置：
- **用户级**：`~/.config/ohbaby-code/skill/`（Linux/macOS）或 `%APPDATA%/ohbaby-code/skill/`（Windows）
- **项目级**：`{projectRoot}/.ohbaby-code/skill/`

### G4: 与 Commands 模块协同工作

Skill 模块提供数据和查询接口，Commands 模块负责：
- 注册 `/<skill-name>` 命令
- 处理用户触发
- 将 Skill 内容注入到对话上下文

### G5: 保持 Agent 上下文简洁

默认不将 Skill 元数据加载到系统提示中：
- 避免 Token 浪费
- 保持 Agent 上下文专注于当前任务
- 用户明确触发时才注入相关 Skill

---

## 二、Skill 在系统架构中的位置

Skill 模块是独立的数据提供模块，通过 Commands 模块与用户交互：

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户交互层                                │
│                                                                 │
│   用户输入: /commit "fix bug"                                   │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │              Commands 模块                               │  │
│   │  • 解析 /<skill-name> 命令                               │  │
│   │  • 调用 Skill.load(name) 获取内容                        │  │
│   │  • 将 Skill 内容注入到对话上下文                         │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │              Skill 模块（本模块）                         │  │
│   │  • 发现和解析 SKILL.md 文件                              │  │
│   │  • 提供 all()、get()、load() 查询接口                    │  │
│   │  • 管理 Skill 缓存                                       │  │
│   └─────────────────────────────────────────────────────────┘  │
│                    │                                            │
│                    ▼                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │              Agent / Session                             │  │
│   │  • 接收注入的 Skill 内容                                 │  │
│   │  • 根据 Skill 指令执行任务                               │  │
│   └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**注意**：ohbaby-code 设计中，Skill 不作为工具暴露给 Agent。Agent 通过对话上下文接收 Skill 内容，而非通过工具调用。

**可选的 SkillTool**（当 `disable-model-invocation: false` 时）：
- 如果用户希望 Agent 能主动调用 Skill，可将 `disable-model-invocation` 设为 `false`
- 此时 SkillTool 将 Skill 注册为工具，Agent 可通过工具调用加载
- 这是可选功能，默认禁用

---

## 三、Duties（职责）

### D1: 发现 Skill 目录

扫描配置目录，发现所有包含 SKILL.md 的 Skill 目录：
- 扫描模式：`skill/**/SKILL.md`
- 扫描目录：用户级配置目录、项目级配置目录
- 支持符号链接
- 记录 Skill 目录中的辅助文件列表（供 Agent 参考）
- 记录 Skill 来源（`scope: 'user' | 'project'`）

### D2: 解析 Skill 元数据

解析 SKILL.md 文件的 YAML frontmatter，提取：
- `name`：Skill 唯一标识（必填，最多 64 字符，小写+数字+连字符）
- `description`：Skill 描述（必填，最多 1024 字符）
- `user-invocable`：是否允许用户直接调用（可选，默认 `true`）
- `disable-model-invocation`：是否禁止 Agent 调用（可选，默认 `true`）

### D3: 管理 Skill 缓存

维护已发现 Skill 的缓存：
- 启动时懒加载（首次访问时扫描）
- 提供手动重载 API（`invalidate()` 或 `reload()`）
- 同名 Skill 处理：后发现的覆盖先发现的（项目级覆盖用户级）

### D4: 提供 Skill 查询接口

对外提供 Skill 查询能力（供 Commands 模块调用）：
- `all()`：获取所有可用 Skill 列表
- `get(name)`：按名称获取单个 Skill 元数据
- `load(name)`：加载 Skill 的完整内容
- `listUserInvocable()`：获取所有 `userInvocable: true` 的 Skill（用于命令注册）

### D5: 检测重复 Skill 名称

当发现同名 Skill 时：
- 记录警告日志，说明覆盖情况
- 按优先级覆盖（项目级 > 用户级）
- 在 SkillInfo 中标记 `scope` 字段

### D6: 提供可选的 SkillTool 实现

当 Skill 配置 `disable-model-invocation: false` 时，注册 SkillTool：
- 工具名称：`skill`
- 参数：`{ name: string }`
- 返回：Skill 内容，包含：
  - 基础目录路径（供 Agent 访问辅助文件）
  - Markdown 正文内容
  - 目录中的辅助文件列表
- **注意**：默认情况下不注册 SkillTool，因为 `disable-model-invocation` 默认为 `true`

### D7: 处理无效 Skill 文件

对格式不正确的 SKILL.md 文件：
- 缺少 frontmatter：跳过，记录警告
- 缺少必填字段：跳过，记录警告
- 字段验证失败（如 name 超长）：跳过，记录警告
- 不中断整体加载流程

### D8: 验证字段格式

对 frontmatter 字段进行基础验证：
- `name`：非空，最多 64 字符，符合 `^[a-z0-9]+(-[a-z0-9]+)*$` 格式
- `description`：非空，最多 1024 字符
- 验证失败时跳过该 Skill，记录警告

---

## 四、Non-Duties（非职责）

### N1: 不负责执行 Skill 中描述的任务

Skill 只是指令文本，具体任务执行由 Agent 根据指令自行完成。本模块只负责加载和提供 Skill 内容。

### N2: 不负责 Skill 的创建和编辑

用户通过文件系统直接创建/编辑 SKILL.md 文件。本模块不提供创建、编辑或删除 Skill 的功能。

### N3: 不负责命令注册和用户交互

`/<skill-name>` 命令的注册和处理由 Commands 模块负责。本模块只提供数据查询接口。

### N4: 不负责 Skill 市场或分享功能

不提供 Skill 的发布、下载、订阅等社区功能。

### N5: 不负责 Skill 版本管理

不跟踪 Skill 的版本历史或变更记录。

### N6: 不负责文件监听（当前版本）

当前版本不实现文件变化自动重载。如需更新 Skill 列表，需要手动调用 reload API。

### N7: 不负责脚本执行

Skill 目录中的脚本由 Agent 通过 Bash 工具执行，本模块只提供脚本路径信息（通过 `baseDir` 和 `files` 字段）。

### N8: 不负责将 Skill 注入到系统提示

ohbaby-code 设计中，Skill 元数据默认不加载到系统提示。注入时机和方式由 Commands 模块控制。

---

## 五、配置目录（XDG 标准）

### 用户级配置目录

| 平台 | 路径 | scope 值 |
|------|------|----------|
| Linux/macOS | `~/.config/ohbaby-code/skill/` | `user` |
| Windows | `%APPDATA%/ohbaby-code/skill/` | `user` |

### 项目级配置目录

| 路径 | scope 值 |
|------|----------|
| `{projectRoot}/.ohbaby-code/skill/` | `project` |

### 目录结构示例

```
~/.config/ohbaby-code/           # 用户级配置 (scope: 'user')
└── skill/
    ├── code-review/
    │   └── SKILL.md
    ├── commit-message/
    │   └── SKILL.md
    └── xlsx/                  # 包含辅助脚本的 Skill
        ├── SKILL.md
        ├── read-xlsx.ts       # 辅助脚本
        └── write-xlsx.ts      # 辅助脚本

{projectRoot}/.ohbaby-code/      # 项目级配置 (scope: 'project')
└── skill/
    ├── code-review/           # 覆盖用户级的 code-review
    │   └── SKILL.md
    └── project-specific/      # 项目特有
        ├── SKILL.md
        ├── templates/         # 辅助资源目录
        │   └── component.tsx
        └── utils.ts           # 辅助脚本
```

**Skill 目录内容**：
- `SKILL.md`（必需）：包含 YAML frontmatter 和 Markdown 指令
- 辅助文件（可选）：脚本、模板、资源等，Agent 可通过 baseDir 路径访问

### 扫描优先级

1. **用户级配置目录**（先扫描，`scope: 'user'`）
2. **项目级配置目录**（后扫描，同名覆盖，`scope: 'project'`）

### 覆盖规则

当项目级和用户级存在同名 Skill 时：
- 项目级 Skill 覆盖用户级 Skill
- 记录警告日志，说明覆盖情况
- 最终 SkillInfo 的 `scope` 为 `'project'`

---

## 六、与其他模块的关系

| 模块 | 代码位置 | 关系 | 说明 |
|------|----------|------|------|
| **Commands** | `src/cli/commands/` | **主要依赖方** | 注册 `/<skill-name>` 命令，调用 Skill 查询接口 |
| Config | `src/config/` | 依赖 | 获取配置目录路径 |
| ToolScheduler | `src/core/tool-scheduler/` | 可选依赖 | 当 `disable-model-invocation: false` 时注册 SkillTool |
| Bus | `src/bus/` | 可选依赖 | 未来可发布 Skill 变化事件 |
| Log | `src/log/` | 依赖 | 记录警告和错误日志 |

### 与 Commands 模块的关系（主要交互）

```
Commands 模块                           Skill 模块
┌─────────────────────┐                ┌─────────────────────┐
│                     │                │                     │
│  启动时:            │   listUser     │                     │
│  注册 Skill 命令    │───Invocable()─→│  返回可调用 Skill   │
│                     │                │  列表               │
│                     │                │                     │
│  用户输入 /commit:  │                │                     │
│  处理命令           │───load(name)──→│  加载 Skill 内容    │
│  注入到对话上下文   │←───────────────│                     │
│                     │                │                     │
└─────────────────────┘                └─────────────────────┘
```

### 与 Agent 模块的关系

当 `disable-model-invocation: false` 时，Agent 可通过 SkillTool 调用 Skill：
```typescript
// Agent.permission 配置（可选）
permission: {
  skill: {
    '*': 'allow',           // 默认允许所有 Skill
    'dangerous-*': 'deny',  // 拒绝特定模式
  }
}
```

**注意**：由于 `disable-model-invocation` 默认为 `true`，大多数情况下 Agent 不会直接与 Skill 模块交互。

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义：Skill 模块提供用户主导的技能扩展系统，用户通过 `/<name>` 按需触发，将专业指令注入到对话上下文
- [x] 可以清楚回答"这个模块不该做什么"：不执行任务、不创建编辑、不注册命令、不做市场分享、不做版本管理、不做文件监听、不注入系统提示
- [x] 不存在职责与其他模块明显重叠的风险（Commands 负责命令注册，Skill 负责数据提供）
- [x] 与 OpenCode/Claude Code 文件格式兼容，但加载机制不同（按需 vs 自动发现）
- [x] 配置目录遵循 XDG 标准（用户级 + 项目级）
- [x] Skill 作为目录的概念已明确（含辅助文件支持）
- [x] 新增字段（userInvocable, disableModelInvocation, scope）职责已定义
- [x] ohbaby-code 独特设计理念已明确说明（用户主导、按需加载）
- [x] 与 Commands 模块的交互流程已明确
