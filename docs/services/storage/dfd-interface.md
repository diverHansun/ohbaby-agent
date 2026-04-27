# storage 模块 dfd-interface.md

本文档描述 `storage` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

Storage 模块位于 ohbaby-code 架构的底层，是 Session 和 Message 模块的基础设施依赖。

### 交互模块

| 外部模块 | 交互方向 | 交互内容 |
|----------|----------|----------|
| **Session** | 输入 | 会话数据的 CRUD 请求 |
| **Message** | 输入 | 消息和 Part 数据的 CRUD 请求 |
| **File System** | 输出 | 文件读写操作 |

### 本文档范围

- 描述 Storage 模块如何接收和处理数据请求
- 定义 Storage 模块的对外接口
- 说明与上层模块的交互方式

---

## 二、Data Flow Description（数据流描述）

### 2.1 主流程：读取数据

```
Session/Message                   Storage                        File System
      │                              │                                │
      │  1. read(key)                │                                │
      │─────────────────────────────>│                                │
      │                              │                                │
      │                 2. resolve(key) → filePath                    │
      │                              │                                │
      │                 3. LockManager.read(filePath)                 │
      │                              │  获取读锁                       │
      │                              │                                │
      │                              │  4. fs.readFile(filePath)      │
      │                              │───────────────────────────────>│
      │                              │                                │
      │                              │  5. file content               │
      │                              │<───────────────────────────────│
      │                              │                                │
      │                 6. JSON.parse(content)                        │
      │                 7. 释放读锁 (Disposable)                       │
      │                              │                                │
      │  8. data / NotFoundError     │                                │
      │<─────────────────────────────│                                │
```

### 2.2 主流程：写入数据

```
Session/Message                   Storage                        File System
      │                              │                                │
      │  1. write(key, content)      │                                │
      │─────────────────────────────>│                                │
      │                              │                                │
      │                 2. resolve(key) → filePath                    │
      │                 3. ensureDir(filePath)                        │
      │                              │                                │
      │                              │  4. fs.mkdir (if needed)       │
      │                              │───────────────────────────────>│
      │                              │                                │
      │                 5. LockManager.write(filePath)                │
      │                              │  获取写锁                       │
      │                              │                                │
      │                 6. JSON.stringify(content)                    │
      │                              │                                │
      │                              │  7. fs.writeFile(filePath)     │
      │                              │───────────────────────────────>│
      │                              │                                │
      │                 8. 释放写锁 (Disposable)                       │
      │                              │                                │
      │  9. void                     │                                │
      │<─────────────────────────────│                                │
```

### 2.3 主流程：原子更新

```
Session/Message                   Storage                        File System
      │                              │                                │
      │  1. update(key, fn)          │                                │
      │─────────────────────────────>│                                │
      │                              │                                │
      │                 2. resolve(key) → filePath                    │
      │                              │                                │
      │                 3. LockManager.write(filePath)                │
      │                              │  获取写锁                       │
      │                              │                                │
      │                              │  4. fs.readFile(filePath)      │
      │                              │───────────────────────────────>│
      │                              │                                │
      │                              │  5. file content               │
      │                              │<───────────────────────────────│
      │                              │                                │
      │                 6. JSON.parse(content) → data                 │
      │                 7. fn(data) → 修改数据                         │
      │                 8. JSON.stringify(data)                       │
      │                              │                                │
      │                              │  9. fs.writeFile(filePath)     │
      │                              │───────────────────────────────>│
      │                              │                                │
      │                 10. 释放写锁 (Disposable)                      │
      │                              │                                │
      │  11. updated data            │                                │
      │<─────────────────────────────│                                │
```

### 2.4 主流程：列表查询

```
Session/Message                   Storage                        File System
      │                              │                                │
      │  1. list(prefix)             │                                │
      │─────────────────────────────>│                                │
      │                              │                                │
      │                 2. resolve(prefix) → dirPath                  │
      │                              │                                │
      │                              │  3. glob("**/*.json", dirPath) │
      │                              │───────────────────────────────>│
      │                              │                                │
      │                              │  4. file paths                 │
      │                              │<───────────────────────────────│
      │                              │                                │
      │                 5. 转换为 Key 数组                             │
      │                              │                                │
      │  6. StorageKey[]             │                                │
      │<─────────────────────────────│                                │
```

### 2.5 并发控制流程

```
Storage (内部)
     │
     │ 新的读/写请求
     ▼
┌─────────────────────────────────────────────────────────────┐
│                      LockManager                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  canAcquire(filePath, lockType)?                            │
│       │                                                      │
│       ├── YES ──→ 获取锁                                     │
│       │           更新 LockState                             │
│       │           返回 DisposableLock                        │
│       │                                                      │
│       └── NO ───→ 加入等待队列                               │
│                   返回 Promise (pending)                     │
│                   等待锁释放后被唤醒                          │
│                                                              │
│  释放锁时:                                                    │
│       │                                                      │
│       ├── 更新 LockState                                     │
│       │                                                      │
│       └── 唤醒等待队列                                        │
│           ├── 优先唤醒写者 (防止饥饿)                         │
│           └── 若无写者，唤醒所有读者                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

#### Storage.read()

**语义**：读取指定 Key 的数据

**输入**：
```typescript
key: StorageKey  // 例如 ["session", "proj1", "sess1"]
```

**输出**：`Promise<T>`

**异步特性**：异步，文件读取完成后 resolve

**错误处理**：
- 文件不存在：抛出 `NotFoundError`
- 其他 I/O 错误：向上抛出

---

#### Storage.write()

**语义**：写入数据到指定 Key

**输入**：
```typescript
key: StorageKey        // 存储键
content: T             // 要写入的数据（可 JSON 序列化）
```

**输出**：`Promise<void>`

**异步特性**：异步，文件写入完成后 resolve

**行为**：
- 自动创建必要的父目录
- 文件存在则覆盖
- 文件不存在则创建

---

#### Storage.update()

**语义**：原子性地读取-修改-写入数据

**输入**：
```typescript
key: StorageKey                    // 存储键
fn: (draft: T) => void             // 修改函数，直接修改 draft 对象
```

**输出**：`Promise<T>` - 返回修改后的数据

**异步特性**：异步，整个操作完成后 resolve

**原子性保证**：
- 在写锁保护下完成整个读-改-写流程
- 其他读写操作在此期间被阻塞

**错误处理**：
- 文件不存在：抛出 `NotFoundError`

---

#### Storage.remove()

**语义**：删除指定 Key 的数据

**输入**：
```typescript
key: StorageKey  // 存储键
```

**输出**：`Promise<void>`

**行为**：
- 文件存在则删除
- 文件不存在则静默成功（幂等操作）
- 不删除空目录

---

#### Storage.list()

**语义**：列举指定前缀下的所有 Key

**输入**：
```typescript
prefix: StorageKey  // 前缀，例如 ["session", "proj1"]
```

**输出**：`Promise<StorageKey[]>` - 所有匹配的完整 Key

**行为**：
- 递归查找所有 `.json` 文件
- 返回的 Key 按字典序排序
- 目录不存在返回空数组

---

#### Storage.exists()

**语义**：检查指定 Key 是否存在

**输入**：
```typescript
key: StorageKey  // 存储键
```

**输出**：`Promise<boolean>`

**用途**：避免调用方通过 try-catch 判断文件是否存在

---

### 3.2 错误类型

#### NotFoundError

**语义**：请求的资源不存在

**携带数据**：
```typescript
{
  key: StorageKey    // 未找到的 Key
  message: string    // 错误消息
}
```

**使用示例**：
```typescript
try {
  const data = await Storage.read(["session", "proj1", "sess1"]);
} catch (e) {
  if (e instanceof Storage.NotFoundError) {
    // 处理不存在的情况
  }
}
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| Session 文件 | Session 模块 | 通过 Storage.write() 创建 |
| Message 文件 | Message 模块 | 通过 Storage.write() 创建 |
| Part 文件 | Message 模块 | 通过 Storage.write() 创建 |
| 目录结构 | Storage 模块 | write() 时自动创建 |

### 4.2 数据更新责任

| 数据 | 更新者 | 更新时机 |
|------|--------|----------|
| Session 文件 | Session 模块 | 会话元数据变更时 |
| Message 文件 | Message 模块 | 消息内容变更时 |
| Part 文件 | Message 模块 | Part 内容更新时（如流式追加） |

### 4.3 数据删除责任

| 数据 | 删除者 | 删除时机 |
|------|--------|----------|
| Session 文件 | Session 模块 | 会话被删除时 |
| Message 文件 | Message 模块 | Session.remove() 时级联删除 |
| Part 文件 | Message 模块 | Message 删除时级联删除 |

### 4.4 责任边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| 文件 I/O | Storage | Session, Message |
| 并发控制 | Storage | Session, Message |
| 数据结构定义 | Session, Message | Storage |
| 数据验证 | Session, Message | Storage |
| 删除级联 | Session, Message | Storage |
| 事件发布 | Session, Message | Storage |

---

## 五、接口使用示例

### 5.1 Session 模块使用示例

```typescript
// session/store.ts
import { Storage } from '@/services/storage';

class SessionStore {
  // 保存会话
  async save(session: Session): Promise<void> {
    await Storage.write(
      ["session", session.projectId, session.id],
      session
    );
  }

  // 获取会话
  async get(projectId: string, sessionId: string): Promise<Session | undefined> {
    try {
      return await Storage.read<Session>(["session", projectId, sessionId]);
    } catch (e) {
      if (e instanceof Storage.NotFoundError) {
        return undefined;
      }
      throw e;
    }
  }

  // 更新会话
  async update(projectId: string, sessionId: string, updater: (s: Session) => void): Promise<Session> {
    return await Storage.update<Session>(
      ["session", projectId, sessionId],
      updater
    );
  }

  // 列出项目的所有会话
  async listByProject(projectId: string): Promise<Session[]> {
    const keys = await Storage.list(["session", projectId]);
    return Promise.all(keys.map(key => Storage.read<Session>(key)));
  }

  // 删除会话
  async remove(projectId: string, sessionId: string): Promise<void> {
    await Storage.remove(["session", projectId, sessionId]);
  }
}
```

### 5.2 Message 模块使用示例

```typescript
// message/store.ts
import { Storage } from '@/services/storage';

class MessageStore {
  // 保存消息
  async saveMessage(message: Message): Promise<void> {
    await Storage.write(
      ["message", message.sessionId, message.id],
      message
    );
  }

  // 保存 Part
  async savePart(part: Part): Promise<void> {
    await Storage.write(
      ["part", part.messageId, part.id],
      part
    );
  }

  // 流式追加文本（原子更新）
  async appendText(messageId: string, partId: string, delta: string): Promise<Part> {
    return await Storage.update<Part>(
      ["part", messageId, partId],
      (draft) => {
        if (draft.type === 'text') {
          draft.content += delta;
        }
      }
    );
  }

  // 获取会话的所有消息
  async getMessages(sessionId: string): Promise<Message[]> {
    const keys = await Storage.list(["message", sessionId]);
    const messages = await Promise.all(keys.map(key => Storage.read<Message>(key)));
    return messages.sort((a, b) => a.createdAt - b.createdAt);
  }

  // 删除会话的所有消息和 Part
  async removeBySession(sessionId: string): Promise<void> {
    const messageKeys = await Storage.list(["message", sessionId]);

    for (const msgKey of messageKeys) {
      const messageId = msgKey[2];
      // 删除消息的所有 Part
      const partKeys = await Storage.list(["part", messageId]);
      for (const partKey of partKeys) {
        await Storage.remove(partKey);
      }
      // 删除消息
      await Storage.remove(msgKey);
    }
  }
}
```

---

## 六、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰
- [x] 接口定义与 data-model.md 中的类型一致
- [x] 并发控制流程完整描述
- [x] 使用示例覆盖主要使用场景
