# skill 模块 test.md

本文档描述 `skill` 模块的测试策略与验证重点。

---

## 一、Test Scope（测试范围）

### 1.1 测试覆盖范围

| 职责 | 测试重点 |
|------|----------|
| D1: 发现 Skill 目录 | 验证 Glob 扫描正确发现 SKILL.md 文件和目录 |
| D2: 解析 Skill 元数据 | 验证 YAML frontmatter 正确解析，包含 baseDir 和新字段 |
| D3: 管理 Skill 缓存 | 验证懒加载和缓存失效机制 |
| D4: 提供查询接口 | 验证 all()、get()、load()、listUserInvocable()、listModelInvocable() |
| D5: 检测重复名称 | 验证同名 Skill 正确覆盖（项目级优先） |
| D6: SkillTool 实现 | 验证工具执行返回正确格式（含辅助文件列表）、description 动态构建、空列表退化行为 |
| D7: 处理无效文件 | 验证无效文件被跳过且不影响其他文件 |
| D8: 字段验证 | 验证 name 和 description 的基础验证规则 |
| 辅助文件扫描 | 验证 Skill 目录中的辅助文件被正确列出 |
| SkillTool 始终注册 | 验证 SkillTool 无条件注册为 module 工具，无 skill 时 description 提示 "No skills are currently available." |
| description 预算策略 | 验证全量 / 截断 / 仅列名字三档行为，1% 上下文预算计算正确 |

### 1.2 不在测试范围内

| 内容 | 原因 |
|------|------|
| 权限检查逻辑 | 由 ToolScheduler/Permission 模块负责 |
| 并发控制 | 由 ToolScheduler 模块负责 |
| 文件系统实际 I/O | 使用 mock 文件系统 |
| CLI 命令交互 | 由 Commands 模块负责 |

---

## 二、Critical Scenarios（关键场景）

### 2.1 Skill 发现场景

#### 场景 1: 发现单个 Skill

**前置条件**：
```
.ohbaby/skills/code-review/SKILL.md
---
name: code-review
description: Code review guidelines
---
# Content
```

**预期结果**：
- `Skill.all()` 返回包含该 Skill 的数组
- `Skill.get('code-review')` 返回对应的 SkillInfo

#### 场景 2: 发现多个 Skill

**前置条件**：
```
.ohbaby/skills/
├── code-review/SKILL.md
├── commit/SKILL.md
└── nested/deep/SKILL.md
```

**预期结果**：
- `Skill.all()` 返回所有三个 Skill
- 嵌套目录中的 Skill 正确被发现

#### 场景 3: 空目录

**前置条件**：配置目录存在但无 SKILL.md 文件

**预期结果**：
- `Skill.all()` 返回空数组
- 不抛出异常

#### 场景 4: 目录不存在

**前置条件**：配置目录不存在

**预期结果**：
- `Skill.all()` 返回空数组
- 不抛出异常

### 2.2 Skill 解析场景

#### 场景 5: 有效的 YAML frontmatter

**前置条件**：
```markdown
---
name: test-skill
description: Test description
---
# Content
```

**预期结果**：
- 正确提取 name 和 description
- content 不包含 frontmatter

#### 场景 6: 缺少 name 字段

**前置条件**：
```markdown
---
description: Missing name
---
# Content
```

**预期结果**：
- 该文件被跳过
- 记录警告日志
- 不影响其他 Skill 的加载

#### 场景 7: 缺少 description 字段

**前置条件**：
```markdown
---
name: missing-desc
---
# Content
```

**预期结果**：
- 该文件被跳过
- 记录警告日志

#### 场景 8: 无 frontmatter

**前置条件**：
```markdown
# Just content without frontmatter
```

**预期结果**：
- 该文件被跳过
- 记录警告日志

### 2.3 缓存管理场景

#### 场景 9: 懒加载

**操作序列**：
1. 启动后不调用任何 Skill 方法
2. 第一次调用 `Skill.all()`
3. 再次调用 `Skill.all()`

**预期结果**：
- 步骤 1 后，不触发目录扫描
- 步骤 2 触发目录扫描
- 步骤 3 使用缓存，不再扫描

#### 场景 10: 缓存失效

**操作序列**：
1. 调用 `Skill.all()` 加载缓存
2. 调用 `Skill.invalidate()`
3. 再次调用 `Skill.all()`

**预期结果**：
- 步骤 3 重新触发目录扫描

#### 场景 11: 强制重载

**操作序列**：
1. 调用 `Skill.all()` 加载缓存
2. 文件系统中添加新 Skill
3. 调用 `Skill.reload()`
4. 调用 `Skill.all()`

**预期结果**：
- 步骤 4 返回包含新 Skill 的列表

### 2.4 优先级覆盖场景

#### 场景 12: 项目级覆盖全局级

**前置条件**：
```
~/.ohbaby/skills/code-review/SKILL.md
  name: code-review
  description: Global version

.ohbaby/skills/code-review/SKILL.md
  name: code-review
  description: Project version
```

**预期结果**：
- `Skill.get('code-review')` 返回 Project version
- 记录警告日志（重复名称）

### 2.5 SkillTool 场景

#### 场景 13: 成功加载 Skill（无辅助文件）

**输入**：`{ name: 'code-review' }`

**前置条件**：
```
.ohbaby/skills/code-review/
└── SKILL.md
```

**预期结果**：
- 返回格式化的输出
- 包含 `## Skill: code-review`
- 包含 `**Base directory**`
- 包含 Markdown 正文
- 不包含 `**Available files**` 部分
- metadata.files 为空数组

#### 场景 14: 加载不存在的 Skill

**输入**：`{ name: 'non-existent' }`

**预期结果**：
- 抛出 `SkillNotFoundError`
- 错误消息包含可用 Skill 列表

#### 场景 15: 成功加载包含辅助文件的 Skill

**输入**：`{ name: 'xlsx' }`

**前置条件**：
```
.ohbaby/skills/xlsx/
├── SKILL.md
├── read-xlsx.ts
└── write-xlsx.ts
```

**预期结果**：
- 返回格式化的输出
- 包含 `## Skill: xlsx`
- 包含 `**Base directory**`
- 包含 `**Available files**` 部分
- Available files 列出 `read-xlsx.ts` 和 `write-xlsx.ts`
- metadata.files 包含 `['read-xlsx.ts', 'write-xlsx.ts']`

#### 场景 16: 加载包含嵌套目录的 Skill

**输入**：`{ name: 'project-generator' }`

**前置条件**：
```
.ohbaby/skills/project-generator/
├── SKILL.md
├── generate.ts
└── templates/
    ├── component.tsx
    └── style.css
```

**预期结果**：
- metadata.files 包含：
  - `generate.ts`
  - `templates/component.tsx`
  - `templates/style.css`
- 路径使用正斜杠（跨平台一致性）

### 2.6 辅助文件场景

#### 场景 17: Skill 目录包含隐藏文件

**前置条件**：
```
.ohbaby/skills/test-skill/
├── SKILL.md
├── script.ts
└── .hidden-file
```

**预期结果**：
- files 列表不包含隐藏文件（以 `.` 开头的文件）
- files 只包含 `['script.ts']`

#### 场景 18: Skill 目录包含空子目录

**前置条件**：
```
.ohbaby/skills/test-skill/
├── SKILL.md
├── script.ts
└── empty-dir/
```

**预期结果**：
- files 列表只包含文件，不包含目录
- files 包含 `['script.ts']`

### 2.7 新字段解析场景

#### 场景 19: 解析完整的 frontmatter（包含所有可选字段）

**前置条件**：
```markdown
---
name: full-featured
description: Full-featured skill
user-invocable: true
disable-model-invocation: false
license: MIT
compatibility: "ohbaby-agent >= 1.0.0"
---
# Content
```

**预期结果**：
- 正确提取所有字段
- `userInvocable: true`
- `disableModelInvocation: false`
- license 和 compatibility 正确解析

#### 场景 20: 默认值处理

**前置条件**：
```markdown
---
name: minimal-skill
description: Minimal skill without optional fields
---
# Content
```

**预期结果**：
- `userInvocable: true`（默认值）
- `disableModelInvocation: false`（默认值，对齐 claude-code）
- license 和 compatibility 为 undefined

#### 场景 21: scope 字段自动识别

**前置条件**：
```
~/.ohbaby/skills/global-skill/SKILL.md
.ohbaby/skills/project-skill/SKILL.md
```

**预期结果**：
- global-skill 的 `scope: 'user'`
- project-skill 的 `scope: 'project'`

### 2.8 字段验证场景

#### 场景 22: name 字段验证 - 超长名称

**前置条件**：
```markdown
---
name: this-is-a-very-long-skill-name-that-exceeds-the-maximum-allowed-length-of-64-characters
description: Test skill
---
```

**预期结果**：
- 该文件被跳过
- 记录验证错误日志

#### 场景 23: name 字段验证 - 非法字符

**前置条件**：
```markdown
---
name: Invalid_Name_With_Underscores
description: Test skill
---
```

**预期结果**：
- 该文件被跳过
- 记录验证错误（只允许 lowercase+numbers+hyphens）

#### 场景 24: description 字段验证 - 超长描述

**前置条件**：
```markdown
---
name: test-skill
description: [1025个字符的描述]
---
```

**预期结果**：
- 该文件被跳过
- 记录验证错误日志

#### 场景 25: name 字段验证 - 有效格式

**前置条件**：
```markdown
---
name: valid-skill-123
description: Test skill
---
```

**预期结果**：
- 成功解析
- name 正确识别为 'valid-skill-123'

### 2.9 查询接口场景

#### 场景 26: listUserInvocable() 过滤

**前置条件**：
```
Skill A: userInvocable: true, disableModelInvocation: true
Skill B: userInvocable: false, disableModelInvocation: true
Skill C: userInvocable: true, disableModelInvocation: false
```

**预期结果**：
- `listUserInvocable()` 返回 Skill A 和 Skill C
- 不返回 Skill B

#### 场景 27: listModelInvocable() 过滤

**前置条件**：
```
Skill A: userInvocable: true, disableModelInvocation: true
Skill B: userInvocable: false, disableModelInvocation: false
Skill C: userInvocable: true, disableModelInvocation: false
```

**预期结果**：
- `listModelInvocable()` 返回 Skill B 和 Skill C
- 不返回 Skill A

#### 场景 28: 无 user-invocable skills

**前置条件**：所有 Skills 都是 `userInvocable: false`

**预期结果**：
- `listUserInvocable()` 返回空数组

#### 场景 29: 无 model-invocable skills

**前置条件**：所有 Skills 都显式设置 `disableModelInvocation: true`

**预期结果**：
- `listModelInvocable()` 返回空数组
- SkillTool 仍正常注册（始终注册原则）
- SkillTool description 提示 "No skills are currently available."

### 2.10 错误处理场景

#### 场景 30: 文件读取失败

**前置条件**：SKILL.md 文件存在但无读取权限

**预期结果**：
- 抛出 `SkillLoadError`
- 错误消息包含文件路径

---

## 三、Integration Points（集成点测试）

### 3.1 与 Config 模块集成

| 测试点 | 验证内容 |
|--------|----------|
| 获取全局配置目录 | 正确获取 XDG 标准目录 |
| 获取项目配置目录 | 正确识别 .ohbaby 目录 |
| 目录不存在时 | 不抛出异常，返回空列表 |

### 3.2 与 Commands 模块集成（用户路径）

| 测试点 | 验证内容 |
|--------|----------|
| Skill 命令注册 | 所有 user-invocable skills 注册为斜杠命令 |
| 命令触发 | 用户输入 `/<skill-name>` 正确触发 Skill 加载 |
| 内容注入 | Skill 内容正确注入到对话上下文 |
| reload 命令 | `ohbaby-agent skill reload` 正确触发重载 |
| 动态更新 | reload 后，Commands 模块获取最新的 user-invocable skills |

#### 场景 31: Commands 模块注册 user-invocable skills

**前置条件**：
```
Skill A: name: "code-review", userInvocable: true
Skill B: name: "commit", userInvocable: true
Skill C: name: "internal", userInvocable: false
```

**预期结果**：
- Commands 调用 `Skill.listUserInvocable()` 获取列表
- 注册 `/code-review` 和 `/commit` 命令
- 不注册 `/internal` 命令

#### 场景 32: 用户触发 skill 命令

**操作序列**：
1. 用户输入 `/code-review "check this function"`
2. Commands 模块识别命令
3. Commands 调用 `Skill.load('code-review')`
4. Commands 将 Skill 内容注入到上下文

**预期结果**：
- Agent 接收包含 Skill 指令的上下文
- 用户的 prompt "check this function" 附加到上下文

### 3.3 与 ToolScheduler 集成（Agent 路径）

| 测试点 | 验证内容 |
|--------|----------|
| 始终注册 | SkillTool 在 ToolScheduler 启动时无条件注册为 module 工具 |
| 工具来源 | source 为 'module'，与 builtin/mcp 区分 |
| 工具描述生成 | 描述中仅包含 model-invocable Skill 列表 |
| 工具类别 | 并发类别为 'readonly'（与 web_search / web_fetch 同档） |
| 返回值结构 | metadata 包含 name、dir、files 字段 |
| 1% 上下文预算 | 总长度受 contextWindow × 4 × 0.01 约束，超出按剩余预算均摊截断 |
| 250 字符单条上限 | 任一 skill 的描述行不超过 250 字符 |
| 仅列名字降级 | 当剩余预算 / skill 数 < 20 字符时，退化为仅列名字 |

#### 场景 33: 无 model-invocable skills 时 SkillTool 仍注册

**前置条件**：
```
所有 Skills 都显式设置 disableModelInvocation: true
```

**预期结果**：
- `Skill.listModelInvocable()` 返回空数组
- SkillTool **仍注册**到 ToolScheduler（始终注册原则）
- SkillTool.description 为 "No skills are currently available."
- Agent 可以看到 skill 工具，但 description 提示后不会调用

#### 场景 34: 存在 model-invocable skills 时 description 列出

**前置条件**：
```
Skill A: disableModelInvocation: false, description: "Code review"
Skill B: disableModelInvocation: true,  description: "Internal helper"
Skill C: disableModelInvocation: false, description: "Commit message"
```

**预期结果**：
- `Skill.listModelInvocable()` 返回 [Skill A, Skill C]（按名排序）
- SkillTool.description 包含 `<available_skills>` 块
- 块中仅包含 Skill A、Skill C
- Agent 调用 `skill({name: "code-review"})` 可正常加载

#### 场景 35: description 超预算时按剩余预算均摊截断

**前置条件**：
- 100 个 skill，每个 description 200 字符
- 上下文窗口 200k tokens（预算 = 200000 × 4 × 0.01 = 8000 字符）

**预期结果**：
- 全量 ≈ 100 × 220 = 22000 字符 > 8000，触发截断
- 计算每条平均可用字符数 = (8000 - 名字开销) / 100
- 每条 description 截到该长度，末尾附 `…`
- bundled skill（如有）不参与截断，全量保留

#### 场景 36: description 极端预算下退化为仅列名字

**前置条件**：
- 1000 个 skill（极端情况）
- 上下文窗口 200k tokens（预算 8000 字符）

**预期结果**：
- 剩余预算 / 1000 < MIN_DESC_LENGTH(20)
- 退化为 `- name1\n- name2\n...` 仅列名字
- 记录 `tengu_skill_descriptions_truncated` 类似的指标日志

### 3.4 与 Permission 集成（仅 Agent 路径）

**注意**：权限检查仅适用于 Agent 路径（通过 SkillTool）。用户路径（`/<name>`）下用户已显式触发，不经过 Permission 评估。

| 测试点 | 验证内容 |
|--------|----------|
| 权限 pattern | 评估时使用 `skill:<name>` pattern |
| 权限模式 'allow' | 直接执行，不询问用户 |
| 权限模式 'ask' | 触发 Permission.ask() |
| 权限模式 'deny' | 拒绝执行，返回错误 |
| 通配符匹配 | `skill:*` / `skill:code-*` 等模式正确匹配 |

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**SkillLoader 测试**：
- 使用 mock 文件系统
- 准备各种格式的 SKILL.md 文件
- 验证解析结果

**SkillRegistry 测试**：
- 使用 mock SkillLoader
- 验证缓存行为
- 验证查询接口

**SkillTool 测试**：
- 使用 mock SkillRegistry
- 验证参数处理
- 验证输出格式

### 4.2 集成测试

**与文件系统集成**：
- 使用临时目录
- 创建真实的 SKILL.md 文件
- 验证完整的发现和加载流程

**与 ToolScheduler 集成**：
- 验证 SkillTool 正确注册
- 验证工具调用流程

### 4.3 Mock 策略

| 依赖 | Mock 方式 |
|------|-----------|
| 文件系统 | 内存文件系统或临时目录 |
| Config | 固定返回测试目录路径 |
| Log | 静默或捕获日志验证 |

### 4.4 测试数据

**有效 Skill 目录（无辅助文件，最小配置）**：
```
test-skill/
└── SKILL.md
```

SKILL.md 内容：
```markdown
---
name: test-skill
description: A test skill for verification
---

# Test Skill

This is test content.
```

**有效 Skill 目录（完整配置）**：
```
full-skill/
└── SKILL.md
```

SKILL.md 内容：
```markdown
---
name: full-skill
description: A skill with all optional fields
user-invocable: true
disable-model-invocation: false
license: MIT
compatibility: "ohbaby-agent >= 1.0.0"
---

# Full Skill

This skill demonstrates all fields.
```

**有效 Skill 目录（含辅助文件）**：
```
xlsx-skill/
├── SKILL.md
├── read-xlsx.ts
├── write-xlsx.ts
└── templates/
    └── sheet-template.json
```

**无效 Skill 文件**（各种边界情况）：
- 空文件
- 只有 frontmatter
- 缺少必填字段
- 格式错误的 YAML

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 测试场景可追溯到 goals-duty.md 中的职责
- [x] 集成点测试覆盖了 dfd-interface.md 中的关键数据流
- [x] Skill 目录结构和辅助文件场景已覆盖
- [x] files 列表的边界情况（隐藏文件、空目录、嵌套目录）已测试
- [x] 新字段（userInvocable, disableModelInvocation, scope）解析场景已覆盖
- [x] 字段验证（name, description 长度和格式）场景已覆盖
- [x] 新接口（listUserInvocable, listModelInvocable）测试场景已覆盖
- [x] Commands 模块集成场景已完整覆盖（用户路径）
- [x] ToolScheduler 集成场景已覆盖（Agent 路径，含 SkillTool 始终注册、description 预算策略三档行为）
- [x] 默认值处理测试已覆盖
- [x] scope 自动识别测试已覆盖
- [x] 项目级覆盖全局级的优先级测试已明确
