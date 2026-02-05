# storage 模块 test.md

本文档说明如何验证 `storage` 模块在真实协作环境中的可信性。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试覆盖以下职责：

| 职责 | 验证目标 |
|------|----------|
| Key 到路径映射 | Key 数组正确转换为文件路径 |
| 读取操作 | 正确读取并解析 JSON 数据 |
| 写入操作 | 正确序列化并写入数据，自动创建目录 |
| 原子更新 | 读-改-写操作在锁保护下完成 |
| 删除操作 | 正确删除文件，不存在时静默成功 |
| 列表操作 | 正确列举指定前缀下的所有 Key |
| 存在性检查 | 正确判断文件是否存在 |
| 读写锁 | 多读单写，写者优先 |
| 错误处理 | NotFoundError 正确抛出 |

### 不在测试范围

以下内容不在本模块测试范围内：

- Session/Message 的数据结构验证（上层模块职责）
- 事件发布（Storage 不发布事件）
- 数据迁移（MVP 阶段不实现）
- 云存储适配器（MVP 阶段不实现）
- 多进程并发（不在支持范围内）

---

## 二、Critical Scenarios（关键场景）

### 2.1 基础 CRUD 操作

**场景 1：写入后读取**
- 前置条件：目标文件不存在
- 操作：调用 write(["test", "item1"], { name: "test" })，然后调用 read(["test", "item1"])
- 预期结果：读取返回 { name: "test" }

**场景 2：读取不存在的文件**
- 前置条件：目标文件不存在
- 操作：调用 read(["nonexistent", "item"])
- 预期结果：抛出 NotFoundError，error.key 为 ["nonexistent", "item"]

**场景 3：写入自动创建目录**
- 前置条件：目标目录不存在
- 操作：调用 write(["new", "nested", "path"], data)
- 预期结果：目录自动创建，文件写入成功

**场景 4：写入覆盖已有文件**
- 前置条件：文件已存在，内容为 { v: 1 }
- 操作：调用 write(key, { v: 2 })
- 预期结果：文件内容更新为 { v: 2 }

**场景 5：删除存在的文件**
- 前置条件：文件存在
- 操作：调用 remove(key)
- 预期结果：文件被删除，再次 read 抛出 NotFoundError

**场景 6：删除不存在的文件**
- 前置条件：文件不存在
- 操作：调用 remove(key)
- 预期结果：静默成功，不抛出错误（幂等）

### 2.2 原子更新

**场景 7：update 正常更新**
- 前置条件：文件存在，内容为 { count: 1 }
- 操作：调用 update(key, (draft) => { draft.count++ })
- 预期结果：文件内容更新为 { count: 2 }，返回更新后的数据

**场景 8：update 文件不存在**
- 前置条件：文件不存在
- 操作：调用 update(["nonexistent"], fn)
- 预期结果：抛出 NotFoundError

**场景 9：update 修改函数抛出异常**
- 前置条件：文件存在
- 操作：调用 update(key, () => { throw new Error("test") })
- 预期结果：文件内容不变，异常向上传递

### 2.3 列表操作

**场景 10：列出目录下的所有文件**
- 前置条件：存在文件 ["prefix", "a"], ["prefix", "b"], ["prefix", "c"]
- 操作：调用 list(["prefix"])
- 预期结果：返回 [["prefix", "a"], ["prefix", "b"], ["prefix", "c"]]

**场景 11：列出嵌套目录**
- 前置条件：存在文件 ["prefix", "sub1", "a"], ["prefix", "sub2", "b"]
- 操作：调用 list(["prefix"])
- 预期结果：返回所有嵌套的 Key

**场景 12：列出空目录**
- 前置条件：目录存在但为空
- 操作：调用 list(["empty"])
- 预期结果：返回空数组 []

**场景 13：列出不存在的目录**
- 前置条件：目录不存在
- 操作：调用 list(["nonexistent"])
- 预期结果：返回空数组 []（不抛出错误）

### 2.4 存在性检查

**场景 14：检查存在的文件**
- 前置条件：文件存在
- 操作：调用 exists(key)
- 预期结果：返回 true

**场景 15：检查不存在的文件**
- 前置条件：文件不存在
- 操作：调用 exists(key)
- 预期结果：返回 false

### 2.5 并发控制

**场景 16：多个读操作并行**
- 前置条件：文件存在
- 操作：同时发起 5 个 read(key) 调用
- 预期结果：5 个读操作可以并行完成，都返回正确数据

**场景 17：写操作阻塞读操作**
- 前置条件：文件存在
- 操作：
  1. 发起一个长时间运行的 update 操作
  2. 在 update 执行期间发起 read 操作
- 预期结果：read 操作等待 update 完成后才返回

**场景 18：写操作阻塞写操作**
- 前置条件：文件存在
- 操作：同时发起 2 个 write 操作
- 预期结果：两个写操作串行执行，不会交叉

**场景 19：读操作阻塞写操作**
- 前置条件：文件存在
- 操作：
  1. 发起一个长时间的读操作（模拟慢读取）
  2. 在读操作执行期间发起 write 操作
- 预期结果：write 操作等待读操作完成

**场景 20：写者优先策略**
- 前置条件：文件存在
- 操作：
  1. 发起一个写操作（持有写锁）
  2. 发起多个读操作（进入等待队列）
  3. 发起另一个写操作（进入等待队列）
  4. 第一个写操作完成
- 预期结果：第二个写操作优先于读操作执行

### 2.6 路径解析

**场景 21：Key 正确映射到路径**
- 操作：resolve(["session", "proj1", "sess1"])
- 预期结果：返回 `{baseDir}/storage/session/proj1/sess1.json`

**场景 22：跨平台路径分隔符**
- 操作：在 Windows 和 Linux 上运行相同的 resolve
- 预期结果：使用正确的路径分隔符（Windows: `\`, Linux: `/`）

### 2.7 错误处理

**场景 23：JSON 解析失败**
- 前置条件：文件存在但内容不是有效 JSON
- 操作：调用 read(key)
- 预期结果：抛出 JSON 解析错误

**场景 24：权限不足**
- 前置条件：目录没有写权限
- 操作：调用 write(key, data)
- 预期结果：抛出权限错误

**场景 25：磁盘空间不足**
- 前置条件：磁盘已满
- 操作：调用 write(key, data)
- 预期结果：抛出 I/O 错误

---

## 三、Integration Points（集成点测试）

### 3.1 与 Session 模块集成

**验证重点**：
- Session 模块可以通过 Storage 正确存取会话数据
- 会话的 CRUD 操作在并发场景下安全

**测试场景**：
- SessionStore.save() 调用 Storage.write()
- SessionStore.get() 调用 Storage.read()
- SessionStore.update() 调用 Storage.update()
- SessionStore.listByProject() 调用 Storage.list()
- SessionStore.remove() 调用 Storage.remove()

**失败处理预期**：
- Storage 返回 NotFoundError 时，Session 模块能正确处理

### 3.2 与 Message 模块集成

**验证重点**：
- Message 模块可以通过 Storage 存取消息和 Part
- 流式追加场景下 update() 保证原子性

**测试场景**：
- MessageStore.saveMessage() 调用 Storage.write()
- MessageStore.savePart() 调用 Storage.write()
- MessageStore.appendText() 调用 Storage.update()
- MessageStore.getMessages() 调用 Storage.list() + Storage.read()
- MessageStore.removeBySession() 调用 Storage.list() + Storage.remove()

**失败处理预期**：
- Storage 操作失败时，错误正确传递给上层模块

### 3.3 与文件系统集成

**验证重点**：
- 文件系统操作的正确性
- 跨平台兼容性

**测试场景**：
- 在 Windows/macOS/Linux 上运行完整测试套件
- 验证 XDG 路径在各平台的正确性

**失败处理预期**：
- 文件系统错误（权限、空间等）正确传递

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**适用场景**：
- PathResolver 的路径映射逻辑
- LockManager 的锁状态管理
- JSON 序列化/反序列化

**策略**：
- 纯函数测试，无外部依赖
- 覆盖边界条件和异常输入

### 4.2 集成测试（真实文件系统）

**适用场景**：
- CRUD 操作的完整流程
- 目录自动创建
- 文件权限处理

**策略**：
- 使用临时目录进行测试
- 测试后清理测试文件
- 验证文件内容正确性

### 4.3 并发测试

**适用场景**：
- 多读操作并行
- 读写互斥
- 写者优先策略

**策略**：
- 使用 Promise.all 模拟并发
- 添加延迟以验证锁的等待行为
- 验证操作顺序符合预期

### 4.4 压力测试

**适用场景**：
- 大量文件读写
- 长时间运行稳定性

**策略**：
- 连续执行大量 CRUD 操作
- 监控内存使用（锁对象是否正确释放）
- 验证无死锁发生

### 4.5 跨平台测试

**适用场景**：
- XDG 路径解析
- 路径分隔符处理

**策略**：
- CI 中在 Windows/macOS/Linux 运行测试
- 验证文件路径格式正确

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 并发控制场景完整覆盖
- [x] 集成点测试明确
- [x] 场景来源于 goals-duty.md 和 dfd-interface.md
- [x] 验证策略与场景匹配
- [x] 错误处理场景覆盖
