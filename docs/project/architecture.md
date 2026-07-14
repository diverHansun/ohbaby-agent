# project 模块 architecture.md

本文档描述 `project` 模块的内部架构设计。

---

## 一、Architecture Overview（架构概览）

### 1.1 架构风格

Project 模块采用**简单函数式架构**，无状态、无持久化：

```
                    调用方（Session、Memory、Config）
                                │
                                ▼
                    ┌───────────────────┐
                    │  Project 模块     │
                    │                   │
                    │  fromDirectory()  │
                    │  getProjectRoot() │
                    │  isGitProject()   │
                    └─────────┬─────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     ┌─────────────────┐             ┌─────────────────┐
     │ project-identifier │             │   file system   │
     │ (Git 命令调用)    │             │   (.git 检测)   │
     └─────────────────┘             └─────────────────┘
```

### 1.2 设计原则

- **无状态**：每次调用独立执行，不缓存结果
- **纯函数**：相同输入产生相同输出
- **最小依赖**：仅依赖 Node.js 内置模块和 Git CLI

---

## 二、File Structure（文件结构）

```
src/project/
├── index.ts              # 模块导出入口
├── types.ts              # 类型定义
├── project-manager.ts    # 核心逻辑：fromDirectory, getProjectRoot
└── project-identifier.ts # ID 生成逻辑：getGitProjectId, getGlobalId
```

### 2.1 文件职责

| 文件 | 职责 | 导出 |
|------|------|------|
| index.ts | 统一导出 | `Project` namespace |
| types.ts | 类型定义 | `ProjectInfo`, `VcsType` |
| project-manager.ts | 项目识别核心逻辑 | `fromDirectory`, `getProjectRoot`, `isGitProject` |
| project-identifier.ts | ID 生成 | `getGitProjectId` |

---

## 三、Core Types（核心类型）

### 3.1 ProjectInfo

```typescript
// src/project/types.ts

/**
 * 项目信息
 */
export interface ProjectInfo {
  /** 项目唯一标识符 */
  id: string
  
  /** 项目根目录绝对路径 */
  rootPath: string
  
  /** 版本控制系统类型 */
  vcs?: 'git'
}

/**
 * 全局项目 ID 常量
 */
export const GLOBAL_PROJECT_ID = 'global'
```

### 3.2 ProjectIdentifier 内部类型

```typescript
// src/project/project-identifier.ts（内部使用）

interface GitDetectionResult {
  isGit: true
  gitDir: string      // .git 目录路径
  worktree: string    // 工作目录路径
  rootCommit: string  // 首次 commit hash
}

interface NonGitResult {
  isGit: false
}

type DetectionResult = GitDetectionResult | NonGitResult
```

---

## 四、Core Functions（核心函数）

### 4.1 Project.fromDirectory

**签名**：
```typescript
async function fromDirectory(directory: string): Promise<ProjectInfo>
```

**功能**：从给定目录识别项目信息

**流程**：
```
1. 规范化输入路径（path.resolve）
2. 向上查找 .git 目录
3. 如果找到 .git：
   a. 获取 worktree 路径
   b. 执行 git rev-list 获取 root commit
   c. 返回 { id: rootCommit, rootPath: worktree, vcs: 'git' }
4. 如果未找到 .git：
   a. 返回 { id: 'global', rootPath: directory, vcs: undefined }
```

### 4.2 getProjectRoot

**签名**：
```typescript
async function getProjectRoot(directory: string): Promise<string | null>
```

**功能**：查找项目根目录（.git 所在目录）

**流程**：
```
1. 从 directory 开始向上遍历
2. 检查每个目录是否包含 .git
3. 找到则返回该目录路径
4. 到达文件系统根目录仍未找到则返回 null
```

### 4.3 getGitProjectId

**签名**：
```typescript
async function getGitProjectId(gitDir: string): Promise<string | null>
```

**功能**：从 Git 仓库获取稳定的项目 ID

**实现**：
```typescript
// 执行 Git 命令获取所有 root commits
const result = await execAsync(
  'git rev-list --max-parents=0 --all',
  { cwd: worktree }
)

// 解析结果，取排序后的第一个
const commits = result.stdout
  .split('\n')
  .filter(Boolean)
  .map(s => s.trim())
  .sort()

return commits[0] || null
```

**为什么取排序后的第一个**：
- 仓库可能有多个 root commit（如 merge unrelated histories）
- 排序确保结果确定性
- 第一个通常是最早的 commit

---

## 五、Algorithm Details（算法细节）

### 5.1 向上查找 .git 目录

```typescript
async function findGitRoot(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir)
  
  while (true) {
    const gitPath = path.join(currentDir, '.git')
    
    try {
      const stats = await fs.lstat(gitPath)
      if (stats.isDirectory()) {
        return currentDir
      }
    } catch {
      // .git 不存在，继续向上
    }
    
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      // 到达文件系统根目录
      return null
    }
    currentDir = parentDir
  }
}
```

### 5.2 Git 命令执行

```typescript
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

async function executeGitCommand(
  command: string,
  cwd: string
): Promise<string> {
  try {
    const { stdout } = await execAsync(command, {
      cwd,
      timeout: 5000,  // 5秒超时
      maxBuffer: 1024 * 1024,  // 1MB 缓冲
    })
    return stdout.trim()
  } catch (error) {
    // Git 命令失败或超时
    return ''
  }
}
```

---

## 六、Error Handling（错误处理）

### 6.1 错误策略

| 场景 | 处理方式 | 返回值 |
|------|----------|--------|
| 目录不存在 | 降级为 global | `{ id: 'global', ... }` |
| Git 命令超时 | 降级为 global | `{ id: 'global', ... }` |
| Git 命令失败 | 降级为 global | `{ id: 'global', ... }` |
| 无 root commit | 降级为 global | `{ id: 'global', ... }` |

**设计原则**：任何错误都不应阻止系统运行，统一降级为 global 项目。

### 6.2 日志

```typescript
// 使用 debug 日志记录识别过程
debugLog('project', `Detecting project from: ${directory}`)
debugLog('project', `Git root found: ${gitRoot}`)
debugLog('project', `Project ID: ${projectId}`)
```

---

## 七、Performance Considerations（性能考量）

### 7.1 Git 命令开销

| 操作 | 预期耗时 |
|------|----------|
| 向上查找 .git | < 1ms（文件系统操作）|
| git rev-list | 10-100ms（取决于仓库大小）|

### 7.2 优化策略

1. **超时保护**：Git 命令设置 5 秒超时
2. **无缓存**：每次调用独立执行，保证结果最新
3. **异步执行**：不阻塞主线程

**不做的优化**（YAGNI）：
- 不缓存结果（项目识别不是高频操作）
- 不并行执行多个 Git 命令（当前只需一个）

---

## 八、与配置系统的关系

### 8.1 目录层级

```
全局配置目录（用户可见单一根）：
├── Linux/macOS: ~/.ohbaby/
├── Windows: %USERPROFILE%\.ohbaby\
├── 可由绝对路径 OHBABY_HOME 完整覆盖
└── 用于存储：全局设置、认证信息、MCP、skills、agents 等

全局数据目录（平台约定）：
├── Linux: ${XDG_DATA_HOME:-~/.local/share}/ohbaby/
├── macOS: ~/Library/Application Support/ohbaby/
├── Windows: %LOCALAPPDATA%\ohbaby\
└── 用于存储：sessions、messages 等

项目级配置目录：
├── {projectRoot}/.ohbaby/
└── 用于存储：项目级设置

项目级记忆文件：
├── {projectRoot}/OHBABY.md
└── 用于存储：项目级 AI 记忆（放在项目根目录，便于发现和版本控制）
```

### 8.2 Project 模块的角色

Project 模块只负责返回 `projectRoot`，配置目录的具体路径由调用者（Config、Memory 模块）自行拼接：

```typescript
// Config 模块使用
const projectRoot = (await Project.fromDirectory(cwd)).rootPath
const projectConfigPath = path.join(projectRoot, '.ohbaby', 'settings.json')

// Memory 模块使用（OHBABY.md 在项目根目录，不在 .ohbaby/ 内）
const projectRoot = (await Project.fromDirectory(cwd)).rootPath
const memoryFilePath = path.join(projectRoot, 'OHBABY.md')
```

**说明**：
- 项目配置（settings.json、agents/*.json）存放在 `.ohbaby/` 目录
- 项目记忆（OHBABY.md）存放在项目根目录，与 `.gitignore` 同级
- 这样设计使 OHBABY.md 更易被用户发现和编辑，也便于加入版本控制与团队共享

---

## 九、文档自检

- 架构简单清晰，无过度设计
- 文件结构遵循单一职责原则
- 错误处理策略明确
- 不包含未确认的未来功能
