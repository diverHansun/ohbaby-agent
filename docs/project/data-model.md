# project 模块 data-model.md

本文档定义 `project` 模块的核心概念与数据模型。重点是统一"认知模型"，而非冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1: Project（项目）

**定义**：Project 是一个代码仓库或工作目录的抽象表示，用于唯一识别和关联工作空间。

**边界**：
- 开始：调用 `Project.fromDirectory()` 时动态识别
- 结束：无持久化生命周期，每次调用独立

**与其他概念的关系**：
```
一个 Project（项目）
├── id: 'abc123...'                （Git root commit hash）
├── rootPath: '/path/to/project'   （项目根目录）
├── vcs: 'git'                     （版本控制系统）
│
├── 关联多个 Session（由 Session 模块管理）
│   ├── Session 1
│   ├── Session 2
│   └── ...
│
└── 关联一个 OHBABY.md（由 Memory 模块管理）
    └── {rootPath}/.ohbaby-agent/OHBABY.md
```

### 概念 2: Global Project（全局项目）

**定义**：对于非 Git 目录，统一归类为"全局项目"，使用固定 ID `"global"`。

**特点**：
- ID 固定为 `"global"`
- rootPath 为调用时传入的目录
- 多个非 Git 目录共享同一个 projectId

**使用场景**：
- 用户主目录
- 临时目录
- 没有版本控制的项目

### 概念 3: ProjectInfo（项目信息）

**定义**：`fromDirectory()` 返回的数据结构，包含识别到的项目信息。

**特点**：
- 不持久化，每次调用动态生成
- 结构简单，仅包含必要字段
- 供调用方（Session、Memory、Config）使用

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|------|------|------|
| ProjectInfo | Value Object（值对象） | 无独立生命周期，不持久化，仅作为数据传递 |
| Global Project | 特殊常量 | 固定 ID，代表所有非 Git 目录 |

**说明**：Project 模块不包含 Entity（实体），因为不持久化任何数据。

---

## 三、Key Data Fields（关键数据字段）

### ProjectInfo 完整数据结构

```typescript
// src/project/types.ts

/**
 * 项目信息
 */
interface ProjectInfo {
  // ======== 标识 ========
  id: string                    // 项目唯一标识符
                                // Git 项目: root commit hash（40位十六进制）
                                // 非 Git:   固定值 'global'
  
  // ======== 路径 ========
  rootPath: string              // 项目根目录绝对路径
                                // Git 项目: .git 所在目录
                                // 非 Git:   传入的目录路径
  
  // ======== 版本控制 ========
  vcs?: 'git'                   // 版本控制系统类型
                                // Git 项目: 'git'
                                // 非 Git:   undefined
}
```

### 字段说明

| 字段 | 含义 | 可能的值 | 备注 |
|------|------|----------|------|
| id | 项目唯一标识 | Git hash 或 `'global'` | 同一仓库在任意位置产生相同 ID |
| rootPath | 项目根目录 | 绝对路径 | Git 项目返回 `.git` 所在目录 |
| vcs | 版本控制类型 | `'git'` 或 `undefined` | 用于判断项目类型 |

### 常量定义

```typescript
// src/project/types.ts

/**
 * 全局项目 ID
 * 用于非 Git 目录
 */
export const GLOBAL_PROJECT_ID = 'global'
```

---

## 四、Lifecycle & Ownership（生命周期与归属）

### ProjectInfo 生命周期

```
调用 Project.fromDirectory(directory)
    │
    ├── 规范化路径
    ├── 查找 .git 目录
    │
    ├── [找到 Git] ──────────────────────┐
    │   ├── 执行 git rev-list            │
    │   ├── 解析 root commit             │
    │   └── 构建 ProjectInfo             │
    │       {                            │
    │         id: 'abc123...',           │
    │         rootPath: '/path/to/repo', │
    │         vcs: 'git'                 │
    │       }                            │
    │                                    │
    └── [未找到 Git] ─────────────────────┤
        └── 构建 ProjectInfo             │
            {                            │
              id: 'global',              │
              rootPath: directory,       │
              vcs: undefined             │
            }                            │
                                         │
    ◄────────────────────────────────────┘
    │
    ▼
返回 ProjectInfo（Value Object）
    │
    ▼
调用方使用后丢弃（无需清理）
```

### 数据归属

| 数据 | 创建者 | 使用者 | 说明 |
|------|--------|--------|------|
| ProjectInfo.id | Project 模块 | Session、Memory、Config | 用于关联和分类 |
| ProjectInfo.rootPath | Project 模块 | Memory、Config | 用于定位项目级文件 |
| ProjectInfo.vcs | Project 模块 | 调用方（可选） | 用于判断项目类型 |

---

## 五、ID 生成规则

### Git 项目 ID

```typescript
/**
 * 获取 Git 项目 ID
 * 
 * 策略：使用仓库的第一个 commit hash（root commit）
 * 原因：
 * - root commit 在仓库创建时确定，永不变化
 * - 同一仓库克隆到不同位置，ID 保持一致
 * - 多个 root commit 时，取排序后的第一个保证确定性
 */
async function getGitProjectId(worktree: string): Promise<string | null> {
  // 执行命令
  const output = await exec('git rev-list --max-parents=0 --all', { cwd: worktree })
  
  // 解析结果
  const commits = output.stdout
    .split('\n')
    .filter(Boolean)
    .map(s => s.trim())
    .sort()  // 排序确保确定性
  
  // 返回第一个 commit hash
  return commits[0] || null
}

// 示例输出：
// 单 root commit:  'a1b2c3d4e5f6789012345678901234567890abcd'
// 多 root commits: 取排序后的第一个
```

### Global 项目 ID

```typescript
/**
 * 全局项目 ID
 * 
 * 策略：固定字符串 'global'
 * 原因：
 * - 简单，无需计算
 * - 所有非 Git 目录共享，符合"全局"语义
 * - 与 OpenCode 设计保持一致
 */
const GLOBAL_PROJECT_ID = 'global'
```

### ID 特性对比

| 特性 | Git 项目 ID | Global ID |
|------|------------|-----------|
| 格式 | 40位十六进制 | 固定字符串 'global' |
| 唯一性 | 每个仓库唯一 | 所有非 Git 目录共享 |
| 稳定性 | 目录移动不变 | 始终不变 |
| 可读性 | 较差（hash） | 良好 |

---

## 六、数据不变性约束

由于 ProjectInfo 是 Value Object，每次调用都重新生成，不存在"修改"的概念。

| 字段 | 不变性 | 说明 |
|------|--------|------|
| id | 每次调用独立计算 | 同一目录多次调用应返回相同值 |
| rootPath | 每次调用独立计算 | Git 项目返回 .git 所在目录 |
| vcs | 每次调用独立计算 | 基于 .git 存在性判断 |

**一致性保证**：
- 同一进程内，同一目录多次调用返回相同的 ProjectInfo
- 不同进程/不同时间调用，只要目录结构不变，结果也相同

---

## 七、与其他模块数据的关系

### 与 Session 模块

```typescript
// Session 使用 Project 返回的 id
interface Session {
  projectId: string  // 来自 ProjectInfo.id
  // ...
}

// 创建 Session 时获取 projectId
const project = await Project.fromDirectory(directory)
const session = await SessionManager.create({
  projectId: project.id,
  projectDirectory: project.rootPath,
  // ...
})
```

### 与 Memory 模块

```typescript
// Memory 使用 Project 返回的 rootPath
async function loadProjectMemory(directory: string): Promise<string | null> {
  const project = await Project.fromDirectory(directory)
  
  // 构建 OHBABY.md 路径
  const memoryPath = path.join(project.rootPath, '.ohbaby-agent', 'OHBABY.md')
  
  // 读取文件
  return await fs.readFile(memoryPath, 'utf-8').catch(() => null)
}
```

### 与 Config 模块

```typescript
// Config 使用 Project 返回的 rootPath
async function loadProjectConfig(directory: string): Promise<Config | null> {
  const project = await Project.fromDirectory(directory)
  
  // 构建配置文件路径
  const configPath = path.join(project.rootPath, '.ohbaby-agent', 'settings.json')
  
  // 读取配置
  return await fs.readFile(configPath, 'utf-8')
    .then(JSON.parse)
    .catch(() => null)
}
```

---

## 八、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在后续接口和数据流中都有使用场景
- [x] ID 生成规则清晰且稳定
- [x] 数据生命周期和归属明确
- [x] Value Object 设计符合模块无持久化的特点
