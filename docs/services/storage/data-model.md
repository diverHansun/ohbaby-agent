# storage 模块 data-model.md

本文档定义 `storage` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 StorageKey（存储键）

表示数据在存储系统中的唯一标识，是一个字符串数组。

**语义说明**：
- 第一个元素通常表示数据类型（如 "session", "message", "part"）
- 后续元素表示层级标识（如 projectId, sessionId, messageId）
- Key 数组映射到文件系统的目录结构

**示例**：
```
["session", "proj1", "sess1"]     → session/proj1/sess1.json
["message", "sess1", "msg1"]      → message/sess1/msg1.json
["part", "msg1", "part1"]         → part/msg1/part1.json
```

### 1.2 Lock（锁）

表示对文件的访问控制，支持读锁和写锁两种类型。

**特性**：
- 读锁：允许多个持有者并发读取
- 写锁：独占，与其他读锁和写锁互斥
- Disposable：支持 `using` 语句自动释放

### 1.3 NotFoundError（未找到错误）

表示请求的资源不存在时抛出的错误。

**使用场景**：
- `read()` 操作时文件不存在
- `update()` 操作时文件不存在

---

## 二、Data Types（数据类型）

### 2.1 基础类型

```typescript
// 存储键类型
type StorageKey = string[];

// 锁类型
type LockType = 'read' | 'write';

// Disposable 锁对象
interface DisposableLock {
  [Symbol.dispose]: () => void;
}
```

### 2.2 锁状态类型

```typescript
// 单个文件的锁状态
interface LockState {
  readers: number;              // 当前读者数量
  writer: boolean;              // 是否有写者
  waitingReaders: Array<() => void>;  // 等待的读者回调
  waitingWriters: Array<() => void>;  // 等待的写者回调
}

// 锁管理器的内部状态
type LockStore = Map<string, LockState>;
```

### 2.3 错误类型

```typescript
// 资源未找到错误
class NotFoundError extends Error {
  readonly key: StorageKey;

  constructor(key: StorageKey) {
    super(`Resource not found: ${key.join('/')}`);
    this.name = 'NotFoundError';
    this.key = key;
  }
}
```

### 2.4 配置类型

```typescript
// 存储配置
interface StorageConfig {
  baseDir?: string;  // 自定义基础目录，覆盖 XDG 默认值
}

// 路径配置（内部使用）
interface PathConfig {
  data: string;      // 数据目录 (XDG_DATA_HOME)
  config: string;    // 配置目录 (XDG_CONFIG_HOME)
  cache: string;     // 缓存目录 (XDG_CACHE_HOME)
}
```

---

## 三、Key Mapping（Key 映射规则）

### 3.1 路径映射

```typescript
// Key 到文件路径的映射函数签名
function resolve(key: StorageKey): string;

// 映射规则：
// baseDir = ~/.local/share/iris-code (Linux)
// key = ["type", "id1", "id2"]
// result = baseDir/storage/type/id1/id2.json
```

### 3.2 预定义的 Key 前缀

以下 Key 前缀由上层模块使用，Storage 模块不强制约束，仅作为约定：

| Key 前缀 | 使用模块 | 说明 |
|----------|----------|------|
| `["session", projectId, sessionId]` | Session | 会话元数据 |
| `["message", sessionId, messageId]` | Message | 消息内容 |
| `["part", messageId, partId]` | Message | 消息部分（Part） |

---

## 四、Lifecycle & Ownership（生命周期与归属）

### 4.1 锁的生命周期

```
创建：LockManager.read(path) 或 LockManager.write(path)
  │
  ├── 立即获取（条件满足）
  │   └── 返回 DisposableLock
  │
  └── 排队等待（条件不满足）
      └── Promise 挂起，等待唤醒
          └── 获取锁后返回 DisposableLock

释放：[Symbol.dispose]() 被调用
  │
  ├── 更新 LockState
  │
  └── 唤醒等待队列
      ├── 优先唤醒写者
      └── 若无写者，唤醒所有读者
```

### 4.2 文件的生命周期

| 操作 | 创建时机 | 更新时机 | 删除时机 |
|------|----------|----------|----------|
| 文件 | write() 首次调用 | write() 或 update() | remove() |
| 目录 | write() 时自动创建 | - | 不自动删除 |

### 4.3 数据归属责任

| 数据 | 创建者 | 更新者 | 删除者 |
|------|--------|--------|--------|
| Session 数据 | Session 模块 | Session 模块 | Session 模块 |
| Message 数据 | Message 模块 | Message 模块 | Message 模块 |
| Part 数据 | Message 模块 | Message 模块 | Message 模块 |
| 锁状态 | Storage 模块 | Storage 模块 | Storage 模块 |

---

## 五、Constants（常量定义）

```typescript
// 文件扩展名
const FILE_EXTENSION = '.json';

// JSON 序列化缩进
const JSON_INDENT = 2;

// 存储子目录名
const STORAGE_SUBDIR = 'storage';

// 应用名称（用于 XDG 路径）
const APP_NAME = 'iris-code';
```

---

## 六、Validation Rules（验证规则）

### 6.1 Key 验证

- Key 数组不能为空
- Key 元素必须是非空字符串
- Key 元素不能包含路径分隔符（`/` 或 `\`）
- Key 元素不能是 `.` 或 `..`

### 6.2 Content 验证

- 内容必须可被 `JSON.stringify()` 序列化
- 序列化后的内容必须可被 `JSON.parse()` 还原

---

## 七、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 锁的生命周期定义完整
- [x] Key 映射规则明确
- [x] 类型定义符合 TypeScript 规范
- [x] 不存在"为了设计而设计"的抽象
