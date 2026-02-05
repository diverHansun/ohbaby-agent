# project 模块 dfd-interface.md

本文档描述 `project` 模块与外部模块的数据流和接口定义。

**模块位置**：
- 代码：`src/project/`
- 文档：`docs/project/`

---

## 一、Context and Scope（上下文与范围）

Project 模块是底层基础设施模块，被多个业务模块依赖：

```
┌─────────────────────────────────────────────────────────────────┐
│                        调用层                                    │
│    ┌──────────┐    ┌──────────┐    ┌──────────┐                │
│    │ Session  │    │  Memory  │    │  Config  │                │
│    └────┬─────┘    └────┬─────┘    └────┬─────┘                │
│         │               │               │                       │
│         └───────────────┴───────────────┘                       │
│                         │                                        │
│                         ▼                                        │
│              ┌─────────────────────┐                            │
│              │   Project 模块       │                            │
│              │   代码: src/project/ │                            │
│              └─────────┬───────────┘                            │
│                        │                                         │
│         ┌──────────────┴──────────────┐                         │
│         ▼                              ▼                         │
│    ┌──────────┐                  ┌──────────┐                   │
│    │ Git CLI  │                  │ 文件系统  │                   │
│    └──────────┘                  └──────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

**与本模块交互的外部模块**：

| 模块 | 代码位置 | 关系 | 调用接口 |
|------|----------|------|----------|
| Session | `src/services/session/` | 调用方 | `Project.fromDirectory()` |
| Memory | `src/core/memory/` | 调用方 | `Project.fromDirectory()` |
| Config | `src/config/` | 调用方 | `Project.fromDirectory()` |
| Git CLI | 外部依赖 | 被调用 | `git rev-list` 命令 |

---

## 二、Data Flow Diagram（数据流图）

### 2.1 项目识别流程

```
调用方（如 Session.create）
    │
    │ 1. fromDirectory(cwd)
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Project 模块                                                     │
│                                                                  │
│  ┌─────────────────┐                                            │
│  │ 2. 规范化路径    │                                            │
│  │ path.resolve()  │                                            │
│  └────────┬────────┘                                            │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐                                            │
│  │ 3. 向上查找.git │ ──────────────┐                            │
│  └────────┬────────┘               │                            │
│           │                        │                            │
│     找到 .git                  未找到 .git                       │
│           │                        │                            │
│           ▼                        ▼                            │
│  ┌─────────────────┐      ┌─────────────────┐                   │
│  │ 4a. 执行 git    │      │ 4b. 返回 global │                   │
│  │ rev-list        │      │ { id: 'global'} │                   │
│  └────────┬────────┘      └────────┬────────┘                   │
│           │                        │                            │
│           ▼                        │                            │
│  ┌─────────────────┐               │                            │
│  │ 5. 解析 commit  │               │                            │
│  │ 取排序后第一个   │               │                            │
│  └────────┬────────┘               │                            │
│           │                        │                            │
│           └────────────┬───────────┘                            │
│                        │                                         │
│                        ▼                                         │
│               ┌─────────────────┐                               │
│               │ 6. 返回结果     │                               │
│               │ ProjectInfo     │                               │
│               └─────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
    │
    │ ProjectInfo { id, rootPath, vcs }
    ▼
调用方
```

### 2.2 典型使用场景

#### 场景 1：Session 创建时获取 projectId

```
User.startSession(directory)
    │
    └─────► Session.create(directory)
                │
                ├──► Project.fromDirectory(directory)
                │        │
                │        └──► return { id: 'abc123...', rootPath: '/path/to/project', vcs: 'git' }
                │
                └──► SessionManager.create({
                       projectId: 'abc123...',
                       projectDirectory: directory,
                       ...
                     })
```

#### 场景 2：Memory 模块定位项目级 IRIS.md

```
Memory.load(directory)
    │
    ├──► Project.fromDirectory(directory)
    │        │
    │        └──► return { id: 'abc123...', rootPath: '/path/to/project', vcs: 'git' }
    │
    └──► 读取 '/path/to/project/.iris-code/IRIS.md'
```

---

## 三、Interface Definition（接口定义）

### 3.1 公开接口

#### Project.fromDirectory

**签名**：
```typescript
namespace Project {
  async function fromDirectory(directory: string): Promise<ProjectInfo>
}
```

**参数**：
- `directory`: string - 要识别的目录路径（绝对或相对路径均可）

**返回值**：
```typescript
interface ProjectInfo {
  id: string        // 项目 ID（Git root commit 或 'global'）
  rootPath: string  // 项目根目录绝对路径
  vcs?: 'git'       // 版本控制系统类型
}
```

**行为说明**：
1. 将输入路径规范化为绝对路径
2. 向上查找 `.git` 目录
3. 如果找到 `.git`：
   - 执行 `git rev-list --max-parents=0 --all` 获取 root commit
   - 返回 `{ id: <commit-hash>, rootPath: <git-worktree>, vcs: 'git' }`
4. 如果未找到 `.git`：
   - 返回 `{ id: 'global', rootPath: <input-directory>, vcs: undefined }`

**错误处理**：
- 不抛出异常，任何错误都降级为 global 项目

**示例**：
```typescript
// Git 项目
const project = await Project.fromDirectory('/path/to/my-repo/src')
// => { id: 'a1b2c3d4...', rootPath: '/path/to/my-repo', vcs: 'git' }

// 非 Git 目录
const project = await Project.fromDirectory('/tmp/random-dir')
// => { id: 'global', rootPath: '/tmp/random-dir', vcs: undefined }

// 用户主目录
const project = await Project.fromDirectory(os.homedir())
// => { id: 'global', rootPath: '/home/user', vcs: undefined }
```

---

#### Project.getProjectRoot

**签名**：
```typescript
namespace Project {
  async function getProjectRoot(directory: string): Promise<string | null>
}
```

**参数**：
- `directory`: string - 起始目录路径

**返回值**：
- `string`: 项目根目录路径（`.git` 所在目录）
- `null`: 未找到 `.git` 目录

**示例**：
```typescript
// Git 项目子目录
const root = await Project.getProjectRoot('/path/to/my-repo/src/components')
// => '/path/to/my-repo'

// 非 Git 目录
const root = await Project.getProjectRoot('/tmp/random-dir')
// => null
```

---

#### Project.isGitProject

**签名**：
```typescript
namespace Project {
  async function isGitProject(directory: string): Promise<boolean>
}
```

**参数**：
- `directory`: string - 要检查的目录路径

**返回值**：
- `true`: 目录位于 Git 仓库内
- `false`: 目录不在 Git 仓库内

**示例**：
```typescript
await Project.isGitProject('/path/to/my-repo/src')
// => true

await Project.isGitProject('/tmp/random-dir')
// => false
```

---

### 3.2 类型导出

```typescript
// src/project/index.ts

export namespace Project {
  export interface ProjectInfo {
    id: string
    rootPath: string
    vcs?: 'git'
  }
  
  export const GLOBAL_PROJECT_ID = 'global'
  
  export async function fromDirectory(directory: string): Promise<ProjectInfo>
  export async function getProjectRoot(directory: string): Promise<string | null>
  export async function isGitProject(directory: string): Promise<boolean>
}
```

---

## 四、Dependencies（依赖关系）

### 4.1 外部依赖

| 依赖 | 类型 | 用途 |
|------|------|------|
| Git CLI | 系统命令 | 执行 `git rev-list` 获取 root commit |
| Node.js fs | 内置模块 | 检测 `.git` 目录存在性 |
| Node.js path | 内置模块 | 路径操作 |
| Node.js child_process | 内置模块 | 执行 Git 命令 |

### 4.2 模块依赖

```
Project 模块
    └── 无业务模块依赖
```

Project 是底层模块，不依赖任何其他业务模块。

---

## 五、Data Ownership & Responsibility（数据归属与责任）

### 5.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| projectId | Project 模块 | 基于 Git 或目录动态生成 |
| rootPath | Project 模块 | 通过 `.git` 查找确定 |
| vcs | Project 模块 | 检测 `.git` 存在性确定 |

### 5.2 数据不持久化

Project 模块不存储任何数据。每次调用都是从文件系统和 Git 重新识别。

---

## 六、Error Cases（错误场景）

| 场景 | 原因 | 处理方式 | 返回值 |
|------|------|----------|--------|
| 目录不存在 | 路径错误 | 降级为 global | `{ id: 'global', ... }` |
| 无 Git 权限 | 权限限制 | 降级为 global | `{ id: 'global', ... }` |
| Git 未安装 | 系统环境 | 降级为 global | `{ id: 'global', ... }` |
| Git 命令超时 | 大仓库/网络 | 降级为 global | `{ id: 'global', ... }` |
| 空仓库 | 无 commit | 降级为 global | `{ id: 'global', ... }` |

**设计原则**：永不抛出异常，确保调用方总能获得有效的 ProjectInfo。

---

## 七、Usage Examples（使用示例）

### 7.1 Session 模块集成

```typescript
// src/services/session/session-manager.ts

import { Project } from '@/project'

async function createSession(
  directory: string,
  options?: CreateSessionOptions
): Promise<Session> {
  // 获取项目信息
  const project = await Project.fromDirectory(directory)
  
  // 创建会话，关联到项目
  // 6. [Memory 模块] 调用
  //    ├── Memory.load() 调用 fromDirectory()
  //    └── 此时需要 rootPath 定位 IRIS.md
  //
  // 7. [Session 模块] 调用
  //    ├── Session.create() 调用 fromDirectory()
  //    └── 此时需要 projectId 和 rootPath.id,
  const session: Session = {
    id: generateSessionId(),
    projectId: project.id,
    projectDirectory: project.rootPath,
    // ...
  }
  
  // 持久化
  await SessionStore.write(session)
  
  return session
}
```

### 7.2 Memory 模块集成

```typescript
// src/core/memory/memory-manager.ts

import { Project } from '@/project'

async function loadProjectMemory(directory: string): Promise<string | null> {
  const project = await Project.fromDirectory(directory)
  
  // 构建 IRIS.md 路径
  const memoryPath = path.join(project.rootPath, '.iris-code', 'IRIS.md')
  
  try {
    return await fs.readFile(memoryPath, 'utf-8')
  } catch {
    return null
  }
}
```

---

## 八、文档自检

- 数据流图清晰展示完整工作流程
- 公开接口文档完整（参数、返回值、示例）
- 错误处理策略明确
- 与其他模块的集成示例清晰
- 不包含未确认的未来功能
