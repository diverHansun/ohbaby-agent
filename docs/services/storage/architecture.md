# storage 模块 architecture.md

本文档描述 `storage` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（总体架构）

### 模块定位

Storage 模块是 iris-code 的底层基础设施，为上层模块（Session、Message）提供统一的持久化能力。

### 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         Storage Module                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │   PathResolver   │  │    LockManager   │  │    Errors     │  │
│  │                  │  │                  │  │               │  │
│  │  - baseDir       │  │  - locks: Map    │  │ NotFoundError │  │
│  │  - resolve()     │  │  - read()        │  │               │  │
│  │  - ensureDir()   │  │  - write()       │  │               │  │
│  │  - getXDGPath()  │  │  - Disposable    │  │               │  │
│  └──────────────────┘  └──────────────────┘  └───────────────┘  │
│           │                     │                    │           │
│           └─────────────────────┼────────────────────┘           │
│                                 │                                │
│  ┌──────────────────────────────┴─────────────────────────────┐ │
│  │                    Storage (对外接口)                        │ │
│  │                                                              │ │
│  │  - read<T>(key): Promise<T>                                 │ │
│  │  - write<T>(key, content): Promise<void>                    │ │
│  │  - update<T>(key, fn): Promise<T>                           │ │
│  │  - remove(key): Promise<void>                               │ │
│  │  - list(prefix): Promise<string[][]>                        │ │
│  │  - exists(key): Promise<boolean>                            │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │   File System   │
                     │   (Node.js fs)  │
                     └─────────────────┘
```

### 组件职责划分

| 组件 | 职责 |
|------|------|
| PathResolver | Key 数组到文件路径的映射，XDG 路径管理，目录创建 |
| LockManager | 读写锁的创建、获取和释放，Disposable 模式支持 |
| Errors | 错误类型定义（NotFoundError） |
| Storage | 对外暴露的统一接口，协调各组件完成 CRUD 操作 |

---

## 二、Core Components（核心组件）

### 2.1 PathResolver

**职责**：管理存储路径的解析和创建

**核心能力**：
- 确定基础存储目录（遵循 XDG 规范）
- 将 Key 数组映射为文件路径
- 确保目录存在

**路径映射规则**：
```
Key: ["session", "projectId", "sessionId"]
     ↓
Path: {baseDir}/storage/session/projectId/sessionId.json
```

**XDG 路径逻辑**：
```
Platform    | Base Directory
------------|----------------------------------------
Linux       | $XDG_DATA_HOME/iris-code 或 ~/.local/share/iris-code
macOS       | ~/Library/Application Support/iris-code
Windows     | %APPDATA%/iris-code
```

### 2.2 LockManager

**职责**：提供文件级别的读写锁

**锁状态结构**：
```
{
  readers: number        // 当前读者数量
  writer: boolean        // 是否有写者
  waitingReaders: []     // 等待的读者队列
  waitingWriters: []     // 等待的写者队列
}
```

**并发策略**：
- 多读单写：允许多个读者同时访问，写者独占
- 写者优先：防止写者饥饿，优先唤醒等待的写者
- 自动释放：通过 Disposable 模式，离开作用域自动释放锁

**并发矩阵**：

| 当前状态 | 新读请求 | 新写请求 |
|----------|----------|----------|
| 空闲 | 立即获取 | 立即获取 |
| 有读者 | 立即获取 | 排队等待 |
| 有写者 | 排队等待 | 排队等待 |
| 有等待写者 | 排队等待 | 排队等待 |

### 2.3 Storage（对外接口）

**职责**：协调 PathResolver 和 LockManager，提供统一的 CRUD 操作

**操作流程**：

```
read(key):
  1. PathResolver.resolve(key) → filePath
  2. LockManager.read(filePath) → 获取读锁
  3. fs.readFile(filePath) → 读取文件
  4. JSON.parse() → 解析数据
  5. 自动释放读锁（Disposable）
  6. 返回数据或抛出 NotFoundError

write(key, content):
  1. PathResolver.resolve(key) → filePath
  2. PathResolver.ensureDir(filePath) → 确保目录存在
  3. LockManager.write(filePath) → 获取写锁
  4. JSON.stringify(content, null, 2) → 序列化
  5. fs.writeFile(filePath) → 写入文件
  6. 自动释放写锁（Disposable）

update(key, fn):
  1. PathResolver.resolve(key) → filePath
  2. LockManager.write(filePath) → 获取写锁
  3. fs.readFile(filePath) → 读取文件
  4. JSON.parse() → 解析数据
  5. fn(data) → 应用修改函数
  6. JSON.stringify(data, null, 2) → 序列化
  7. fs.writeFile(filePath) → 写入文件
  8. 自动释放写锁（Disposable）
  9. 返回修改后的数据
```

---

## 三、Design Pattern & Rationale（设计模式与理由）

### 3.1 Disposable 模式（锁管理）

**应用场景**：读写锁的自动释放

**实现方式**：
```typescript
// 获取锁时返回 Disposable 对象
const lock = await LockManager.read(filePath);
// 使用 using 语句，离开作用域自动释放
using _ = lock;
```

**选择理由**：
- 避免忘记释放锁导致死锁
- 异常情况下也能正确释放
- 代码更简洁，减少 try-finally 样板代码

### 3.2 读写锁模式（Reader-Writer Lock）

**应用场景**：并发访问控制

**选择理由**：
- Message 模块有流式更新场景，需要写入原子性
- 多个读操作（如 UI 刷新、列表查询）可以并行，提高性能
- 比简单的互斥锁有更好的并发度

### 3.3 Namespace 模式（API 组织）

**应用场景**：对外接口组织

**实现方式**：
```typescript
export namespace Storage {
  export async function read<T>(key: string[]): Promise<T> { ... }
  export async function write<T>(key: string[], content: T): Promise<void> { ... }
  // ...
}
```

**选择理由**：
- 清晰的模块边界
- 避免命名冲突
- 便于按需导入

### 3.4 未使用的模式

**未使用 Repository 模式**：
- Storage 是通用基础设施，不绑定特定领域对象
- 领域相关的仓储逻辑由上层模块（SessionStore、MessageStore）实现

**未使用 Strategy 模式（存储后端）**：
- MVP 阶段只支持本地文件系统
- 避免过度设计，保持简单
- 后续扩展云存储时可引入

---

## 四、Module Structure & File Layout（模块结构与文件组织）

```
packages/core/src/services/storage/
├── index.ts              # 模块入口，导出 Storage namespace
├── storage.ts            # Storage 核心实现（CRUD 操作）
├── path-resolver.ts      # 路径解析和管理
├── lock-manager.ts       # 读写锁实现
├── errors.ts             # 错误类型定义
└── types.ts              # 类型定义
```

### 文件职责说明

| 文件 | 职责 | 对外暴露 |
|------|------|----------|
| index.ts | 模块入口，统一导出 | Storage, NotFoundError |
| storage.ts | CRUD 操作的核心实现 | 内部 |
| path-resolver.ts | Key 到路径的映射逻辑 | 内部 |
| lock-manager.ts | 读写锁的实现 | 内部 |
| errors.ts | NotFoundError 定义 | NotFoundError |
| types.ts | StorageKey 等类型定义 | StorageKey |

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 5.1 选择 JSON 格式而非二进制格式

**取舍**：
- 放弃：存储空间效率、解析性能
- 获得：可调试性、人类可读性

**理由**：
- iris-code 的数据量不大（会话、消息），JSON 性能足够
- 便于开发调试和问题排查

### 5.2 选择文件级锁而非更细粒度锁

**取舍**：
- 放弃：更高的并发度（如字段级并发更新）
- 获得：实现简单、语义清晰

**理由**：
- JSON 文件作为整体读写，字段级锁无意义
- 降低实现复杂度

### 5.3 不实现内存缓存

**取舍**：
- 放弃：读取性能优化
- 获得：数据一致性保证、内存占用可控

**理由**：
- 避免缓存一致性问题
- iris-code 的读取频率不高，直接读取文件可接受
- 上层模块可根据需要自行缓存

### 5.4 写者优先的锁策略

**取舍**：
- 放弃：读者的响应时间稳定性
- 获得：写者不会饥饿

**理由**：
- 数据写入的重要性高于读取
- 防止大量读操作导致写操作无法完成

### 5.5 不支持多进程并发写入

**取舍**：
- 放弃：多进程部署能力
- 获得：实现简单，无需引入进程间锁

**理由**：
- iris-code 是单进程 CLI/VSCode 扩展
- 多进程场景可通过进程协调或数据库解决

---

## 六、Dependencies（依赖关系）

### 6.1 外部依赖

| 依赖 | 用途 |
|------|------|
| Node.js fs/promises | 文件系统操作 |
| Node.js path | 路径处理 |
| Node.js os | 获取用户目录 |
| glob (或 fast-glob) | list 操作的文件匹配 |

### 6.2 被依赖

| 依赖方 | 调用接口 | 用途 |
|--------|----------|------|
| Session | read, write, update, remove, list | 会话数据存取 |
| Message | read, write, update, remove, list | 消息和 Part 数据存取 |

---

## 七、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 组件职责单一，边界清晰
- [x] 设计模式选择有明确理由
- [x] 并发控制策略清晰（读写锁 + 写者优先）
- [x] 不存在为了"优雅"而增加的复杂性
- [x] 约束与权衡说明清楚
