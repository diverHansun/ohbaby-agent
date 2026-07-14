# skill 模块 goals-duty.md

本文档定义 `skill` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/skill/`
- 文档：`docs/skill/`

**模块定位**：Skill 是可扩展的技能系统，允许用户通过 Markdown 文件定义专业指令。Skill 同时支持两条触发路径：用户通过 `/<name>` 斜杠命令手动触发，Agent 通过 `SkillTool` 自动发现并加载——两条路径正交、互不干扰。

**重要概念**：Skill 是一个**目录**，而非单个文件。每个 Skill 目录包含：
- `SKILL.md`：必需的主文件，包含 YAML frontmatter 和 Markdown 指令
- 辅助文件（可选）：脚本、模板、资源文件等，供 Agent 在执行任务时使用

**设计理念**（对齐 claude-code 的二维属性正交模型）：
```
┌─────────────────────────────────────────────────────────────────┐
│                ohbaby-agent Skill 触发模型                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   user-invocable      ×       disable-model-invocation           │
│   （是否注册斜杠命令）         （是否禁止 Agent 自动调用）          │
│                                                                  │
│   ┌──────────────────────┬──────────────────────────┐            │
│   │ user-invocable: true │ user-invocable: false    │            │
│ ┌─┼──────────────────────┼──────────────────────────┤            │
│ │ │ 双路径开放（默认）   │ 仅 Agent 路径            │            │
│ │D│ /<name> + SkillTool  │ SkillTool only           │            │
│ │M│                      │                          │            │
│ │I├──────────────────────┼──────────────────────────┤            │
│ │T│ 仅用户路径           │ 完全隐藏                 │            │
│ │R│ /<name> only         │ 无任何触发途径           │            │
│ │U│                      │                          │            │
│ │E└──────────────────────┴──────────────────────────┘            │
│ │                                                                │
│ └─ DMI = disable-model-invocation                                │
│                                                                  │
│   默认值：user-invocable=true, disable-model-invocation=false    │
│   即：默认双路径开放，与 claude-code/opencode 行为对齐           │
└─────────────────────────────────────────────────────────────────┘
```

**与参考实现的对齐与差异**：
- 与 claude-code 完全对齐：二维属性、默认值、SkillTool 始终注册、description 1% 上下文预算
- 与 opencode 对齐：SkillTool 在零 skill 时仍存在（提示 "No skills are currently available."）
- 与 opencode 的差异：Skill 列表通过 SkillTool description 暴露给 Agent，**不**塞进 system prompt（保持对其他模块零侵入）

---

## 一、Design Goals（设计目标）

### G1: 提供双路径触发的技能扩展机制

允许用户通过标准化的 Markdown 文件定义专业技能，同时支持两条触发路径：
- **用户路径**：`/<skill-name>` 斜杠命令，Skill 内容注入对话上下文
- **Agent 路径**：通过 SkillTool 自动发现并按需加载，纳入工具调用流

### G2: 完全兼容 claude-code 的 Skill 格式与触发模型

- SKILL.md 文件格式兼容（YAML frontmatter + Markdown 内容）
- 支持 Skill 目录中的辅助文件（脚本、模板等）
- 默认值与 claude-code 一致：`user-invocable: true`、`disable-model-invocation: false`
- `user-invocable` × `disable-model-invocation` 二维正交语义对齐
- 现有的 claude-code/opencode Skill 文件可以直接复用

### G3: 支持多层级配置目录（XDG 标准）

支持用户级和项目级 Skill 配置，项目级配置覆盖用户级配置：
- **用户级**：`~/.ohbaby/skills/`（Linux/macOS）或 `%USERPROFILE%/.ohbaby/skills/`（Windows）
- **项目级**：`{projectRoot}/.ohbaby/skills/`

### G4: 同时为 Commands 和 ToolScheduler 提供数据服务

- Commands 调 `listUserInvocable()` 注册 `/<name>` 斜杠命令
- ToolScheduler 注册的 SkillTool 调 `listModelInvocable()` 构建 description
- 两个查询接口基于同一份扫描结果，保证视图一致

### G5: 控制 SkillTool description 对系统提示的占用

通过 1% 上下文预算策略 + 250 字符单条上限，确保 Skill 数量增长不会撑爆 prompt：
- 全量优先，超预算时按剩余预算均摊截断
- 极端情况退化到"仅列名字"，保留发现能力

---

## 二、Skill 在系统架构中的位置

Skill 模块是独立的数据提供模块，通过两条路径与外界交互——用户路径走 Commands，Agent 路径走 ToolScheduler 注册的 SkillTool：

```
┌──────────────────────────────────────────────────────────────────┐
│                     用户路径               │     Agent 路径        │
│                                            │                       │
│  用户输入: /commit "fix bug"               │ Agent 调用: skill({   │
│           │                                │   name: "commit"})    │
│           ▼                                │           │           │
│  ┌─────────────────────┐                  │           ▼           │
│  │   Commands 模块     │                  │  ┌─────────────────┐  │
│  │ • 解析 /<name>      │                  │  │  ToolScheduler  │  │
│  │ • 注入对话上下文    │                  │  │ • 注册 SkillTool│  │
│  └──────────┬──────────┘                  │  │ • 调度执行      │  │
│             │                              │  └────────┬────────┘  │
│   load(name)│                              │           │ load(name)│
│             │       ┌────────────┐         │           │           │
│             └──────→│            │←────────┴───────────┘           │
│                     │ Skill 模块 │                                 │
│              all() ─┤  (本模块)  │── listModelInvocable()          │
│   listUserInvocable┤            │                                 │
│                     │            │ ← Commands 启动时拉             │
│                     └─────┬──────┘ ← SkillTool description 动态构建│
│                           │                                        │
│                           ▼                                        │
│              ┌────────────────────────┐                            │
│              │ Skill 目录 / SKILL.md  │                            │
│              │ (用户级 + 项目级)      │                            │
│              └────────────────────────┘                            │
└──────────────────────────────────────────────────────────────────┘
```

**两条路径的语义差异**：

| 维度 | 用户路径（Commands） | Agent 路径（SkillTool） |
|------|---------------------|------------------------|
| 触发方 | 用户显式输入 `/<name>` | Agent 根据 SkillTool description 自主决定 |
| 数据来源 | `Skill.listUserInvocable()` | `Skill.listModelInvocable()` |
| 可见性控制 | `user-invocable` 字段 | `disable-model-invocation` 字段 |
| 内容呈现 | 注入对话上下文 | 作为 tool result 返回 |
| 权限模型 | 命令级（用户主动行为） | `skill:<name>` Permission pattern |

**SkillTool 始终注册**：即便所有 Skill 都设了 `disable-model-invocation: true`，SkillTool 仍然存在，description 提示 "No skills are currently available."。这与 claude-code/opencode 的行为一致，避免"工具集合随配置变化"破坏 prompt 缓存。

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
- `disable-model-invocation`：是否禁止 Agent 调用（可选，默认 `false`）

### D3: 管理 Skill 缓存

维护已发现 Skill 的缓存：
- 启动时懒加载（首次访问时扫描）
- 提供手动重载 API（`invalidate()` 或 `reload()`）
- 同名 Skill 处理：后发现的覆盖先发现的（项目级覆盖用户级）

### D4: 提供 Skill 查询接口

对外提供 Skill 查询能力（供 Commands 和 SkillTool 调用）：
- `all()`：获取所有可用 Skill 列表
- `get(name)`：按名称获取单个 Skill 元数据
- `load(name)`：加载 Skill 的完整内容（含 baseDir、辅助文件列表、Markdown 正文）
- `listUserInvocable()`：获取所有 `userInvocable: true` 的 Skill（供 Commands 注册斜杠命令）
- `listModelInvocable()`：获取所有 `disableModelInvocation: false` 的 Skill（供 SkillTool 构建 description）
- `invalidate()` / `reload()`：使缓存失效 / 强制重载

### D5: 检测重复 Skill 名称

当发现同名 Skill 时：
- 记录警告日志，说明覆盖情况
- 按优先级覆盖（项目级 > 用户级）
- 在 SkillInfo 中标记 `scope` 字段

### D6: 提供 SkillTool 实现

提供 SkillTool 给 ToolScheduler **始终注册**（无条件、`source: 'module'`）：
- 工具名称：`skill`
- 参数：`{ name: string }`
- 返回：Skill 内容，包含：
  - 基础目录路径（供 Agent 访问辅助文件）
  - Markdown 正文内容
  - 目录中的辅助文件列表
- description 动态构建：列出所有 `disableModelInvocation: false` 的 Skill，采用 1% 上下文预算策略（详见 [architecture.md §2.4](architecture.md#L233)）
- 当无 model-invocable skill 时，description 提示 "No skills are currently available."（工具仍存在，Agent 不会调）
- 并发类别：`readonly`（与 `web_search` / `web_fetch` 同档）

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

### N8: 不负责修改系统提示

Skill 列表通过 SkillTool 的 description 暴露给 Agent，不通过系统提示（这是与 opencode 的关键差异）。Skill 模块不与 SystemPrompt 构建器交互，对其他模块零侵入。

用户路径（`/<name>`）下，Skill 内容如何注入对话上下文由 Commands 模块决定（作为系统消息或用户消息），不在本模块职责内。

---

## 五、配置目录（XDG 标准）

### 用户级配置目录

| 平台 | 路径 | scope 值 |
|------|------|----------|
| Linux/macOS | `~/.ohbaby/skills/` | `user` |
| Windows | `%USERPROFILE%/.ohbaby/skills/` | `user` |

### 项目级配置目录

| 路径 | scope 值 |
|------|----------|
| `{projectRoot}/.ohbaby/skills/` | `project` |

### 目录结构示例

```
~/.ohbaby/           # 用户级配置 (scope: 'user')
└── skill/
    ├── code-review/
    │   └── SKILL.md
    ├── commit-message/
    │   └── SKILL.md
    └── xlsx/                  # 包含辅助脚本的 Skill
        ├── SKILL.md
        ├── read-xlsx.ts       # 辅助脚本
        └── write-xlsx.ts      # 辅助脚本

{projectRoot}/.ohbaby/      # 项目级配置 (scope: 'project')
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
| **Commands** | `packages/ohbaby-agent/src/commands/` | **依赖方（用户路径）** | 启动时拉 `listUserInvocable()` 注册 `/<name>` 斜杠命令；用户触发时调 `load(name)` |
| **ToolScheduler** | `src/core/tool-scheduler/` | **依赖方（Agent 路径）** | 启动时无条件注册 SkillTool 为 module 工具；SkillTool 内部调 `listModelInvocable()` 构建 description、调 `load()` 执行 |
| Permission | `src/permission/` | 间接（通过 SkillTool） | SkillTool 执行时评估 `skill:<name>` 权限规则 |
| Config | `src/config/` | 依赖 | 获取配置目录路径 |
| Bus | `src/bus/` | 可选依赖 | 未来可发布 Skill 变化事件，用于 description 缓存刷新 |
| Log | `src/log/` | 依赖 | 记录警告和错误日志 |

### 与 Commands 模块的关系（用户路径）

```
Commands 模块                           Skill 模块
┌─────────────────────┐                ┌─────────────────────┐
│                     │                │                     │
│  启动时:            │   listUser     │                     │
│  注册斜杠命令       │───Invocable()─→│  返回 user-invocable│
│                     │                │  Skill 列表         │
│                     │                │                     │
│  用户输入 /commit:  │                │                     │
│  处理命令           │───load(name)──→│  加载完整 Skill 内容│
│  注入到对话上下文   │←───────────────│                     │
│                     │                │                     │
└─────────────────────┘                └─────────────────────┘
```

### 与 ToolScheduler 模块的关系（Agent 路径）

```
ToolScheduler                           Skill 模块
┌─────────────────────┐                ┌─────────────────────┐
│                     │                │                     │
│  启动时:            │                │                     │
│  无条件注册         │←─SkillTool─────│  导出 SkillTool      │
│  register(SkillTool,│   实例          │  实例（始终注册）    │
│           'module') │                │                     │
│                     │                │                     │
│  构建工具列表时:    │  listModel     │                     │
│  动态构建           │──Invocable()──→│  返回 model-invocable│
│  SkillTool desc     │                │  Skill 列表          │
│                     │                │                     │
│  Agent 调用 skill:  │                │                     │
│  评估权限并执行     │───load(name)──→│  加载完整 Skill 内容 │
│  返回 tool result   │←───────────────│                     │
│                     │                │                     │
└─────────────────────┘                └─────────────────────┘
```

**Agent 权限配置示例**：
```typescript
// Agent.permission 配置
permission: {
  skill: {
    '*': 'allow',           // 默认允许所有 Skill
    'dangerous-*': 'deny',  // 拒绝特定模式
    'external-*': 'ask',    // 询问用户
  }
}
```

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义：Skill 模块提供双路径触发的技能扩展系统，用户通过 `/<name>` 显式触发，Agent 通过 SkillTool 自动发现，两条路径正交
- [x] 可以清楚回答"这个模块不该做什么"：不执行任务、不创建编辑、不注册斜杠命令、不做市场分享、不做版本管理、不做文件监听、不修改系统提示
- [x] 不存在职责与其他模块明显重叠的风险（Commands 负责斜杠命令，ToolScheduler 负责工具注册和调度，Skill 负责数据提供和 SkillTool 实现）
- [x] 与 claude-code/opencode 文件格式与触发模型完全对齐
- [x] 配置目录遵循 XDG 标准（用户级 + 项目级）
- [x] Skill 作为目录的概念已明确（含辅助文件支持）
- [x] 二维属性（user-invocable × disable-model-invocation）的正交语义已说明
- [x] SkillTool 始终注册的原因已说明（避免工具集合随配置变化）
- [x] 新增字段（userInvocable, disableModelInvocation, scope）职责已定义
- [x] 与 Commands 模块（用户路径）和 ToolScheduler 模块（Agent 路径）的交互流程已明确
