# permission 模块 dfd-interface.md

本文档描述 `permission` 模块的数据流与对外接口。所有内容基于 `goals-duty.md`、`architecture.md` 和 `data-model.md` 中的定义。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

permission 模块位于工具执行层与 UI 层之间，负责权限确认的执行流程。

### 交互模块

| 外部模块 | 交互方向 | 交互内容 |
|----------|----------|----------|
| **Tool 模块** | 输入 | 工具调用权限确认请求 |
| **Bus 模块** | 输出 | 权限事件发布 |
| **UI 层** | 双向 | 显示确认框 / 接收用户响应 |
| **Policy 模块** | 输出（间接） | 通过 Bus 通知模式切换请求 |
| **Session 模块** | 输入 | 会话清理触发 |

### 本文档范围

- 描述数据如何进入 permission 模块
- 描述数据如何从 permission 模块输出
- 定义模块的对外接口
- 明确数据归属与责任

---

## 二、Data Flow Description（数据流描述）

### 2.1 主流程：权限确认请求

```
工具模块                    permission 模块                     UI 层 / Policy 模块
   |                              |                                    |
   |  1. 调用 ask()               |                                    |
   |----------------------------->|                                    |
   |                              |                                    |
   |                 2. 生成 PermissionInfo                            |
   |                 3. 检查是否已批准                                  |
   |                              |                                    |
   |                    [已批准]  |                                    |
   |<-------- 4a. resolve --------|                                    |
   |                              |                                    |
   |                    [未批准]  |                                    |
   |                 4b. 加入队列                                       |
   |                 5. 发布 Event.Updated                              |
   |                              |------------------------------------>|
   |                              |                                    |
   |                              |   6. UI 显示确认框                  |
   |                              |                                    |
   |                              |   7. 用户响应                       |
   |                              |<------------------------------------|
   |                              |                                    |
   |                 8. 调用 respond()                                  |
   |                 9. 处理响应                                        |
   |                              |                                    |
   |              [once/always]   |                                    |
   |<-------- 10a. resolve -------|                                    |
   |                              |                                    |
   |              [always]        |                                    |
   |                 10b. 记录批准                                      |
   |                 10c. 发布 SwitchModeRequested                      |
   |                              |------------------------------------>|
   |                              |                                    |
   |              [reject]        |                                    |
   |<--- 10d. reject (Error) -----|                                    |
   |                              |                                    |
   |              [suggest]       |                                    |
   |<- 10e. reject (Suggestion) --|                                    |
   |                              |                                    |
   |                 11. 处理下一个队列项                               |
```

### 2.2 流程步骤说明

**输入阶段（步骤 1-3）**

1. **工具模块调用 ask()**：工具在执行敏感操作前调用 `Permission.ask()`
2. **生成 PermissionInfo**：permission 模块根据输入生成完整的权限信息，包括 permissionId、pattern 等
3. **检查已批准列表**：通过 PatternMatcher 检查是否已有匹配的批准记录

**快速路径（步骤 4a）**

4a. **已批准直接通过**：如果找到匹配的批准记录，直接 resolve Promise，工具继续执行

**等待用户确认路径（步骤 4b-11）**

4b. **加入请求队列**：将请求加入 RequestQueue
5. **发布更新事件**：通过 Bus 发布 `Permission.Event.Updated`，通知 UI 层
6. **UI 显示确认框**：UI 层接收事件后显示确认对话框
7. **用户响应**：用户在 UI 中选择 once/always/reject/suggest
8. **调用 respond()**：UI 层调用 `Permission.respond()` 传递用户选择
9. **处理响应**：根据响应类型执行不同逻辑
10. **完成处理**：
   - `once`：resolve Promise，工具继续执行
   - `always`：resolve Promise + 记录批准 + 发布 SwitchModeRequested
   - `reject`：reject Promise，抛出 PermissionRejectedError
   - `suggest`：reject Promise，抛出 PermissionRejectedWithSuggestionError
11. **处理下一项**：从队列中移除当前请求，处理下一个待处理请求

### 2.3 辅助流程：会话清理

```
Session 模块                 permission 模块
     |                              |
     |  1. 调用 clearSession()      |
     |----------------------------->|
     |                              |
     |           2. 清除该会话的批准记录
     |           3. 清除该会话的待处理请求
     |                              |
     |  4. 返回                     |
     |<-----------------------------|
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

#### Permission.ask()

**语义**：请求权限确认，等待用户批准后继续

**输入**：
- sessionId：所属会话标识
- messageId：关联的消息标识
- type：权限类型（tool/bash/external_directory）
- name：工具名或命令名
- title：确认框显示标题
- metadata：额外信息（如命令内容、文件路径）
- callId（可选）：工具调用标识

**输出**：
- Promise<void>：批准时 resolve，拒绝时 reject

**异步特性**：异步，返回 Promise

**数据流对应**：主流程步骤 1-10

---

#### Permission.respond()

**语义**：处理用户对权限请求的响应

**输入**：
- sessionId：会话标识
- permissionId：权限请求标识
- response：用户响应（once/always/reject/suggest）

**输出**：无直接返回值

**异步特性**：同步执行，但会触发 Promise resolve/reject

**数据流对应**：主流程步骤 8-11

---

#### Permission.clearSession()

**语义**：清理指定会话的所有权限相关数据

**输入**：
- sessionId：要清理的会话标识

**输出**：无

**异步特性**：同步

**数据流对应**：辅助流程

---

### 3.2 发布的事件（通过 Bus）

#### Permission.Event.Updated

**语义**：通知有新的权限请求或请求状态变化

**携带数据**：PermissionInfo

**订阅者**：UI 层

**触发时机**：主流程步骤 5

---

#### Permission.Event.Replied

**语义**：通知权限请求已收到响应

**携带数据**：
- sessionId：会话标识
- permissionId：权限请求标识
- response：用户响应

**订阅者**：需要跟踪权限状态的模块

**触发时机**：主流程步骤 9

---

#### Permission.Event.SwitchModeRequested

**语义**：请求切换到自动编辑模式

**携带数据**：
- sessionId：会话标识
- targetMode：目标模式（edit-automatically）
- trigger：触发信息（permissionId, pattern）

**订阅者**：Policy 模块

**触发时机**：主流程步骤 10c（用户选择 always 时）

---

### 3.3 依赖的外部接口

#### Bus.publish()

**语义**：发布事件

**使用场景**：
- 发布 Event.Updated
- 发布 Event.Replied
- 发布 Event.SwitchModeRequested

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| AskInput（请求输入） | 工具模块 | 调用 ask() 时传入 |
| PermissionInfo | permission 模块 | 由 ask() 内部创建 |
| permissionId | permission 模块 | 由 ID 生成器创建 |
| Pattern | permission 模块 | 由 PatternMatcher 生成 |
| PendingRequest | permission 模块 | 由 RequestQueue 创建 |
| PermissionResponse | UI 层 | 用户响应后传入 |

### 4.2 数据更新责任

| 数据 | 更新者 | 更新时机 |
|------|--------|----------|
| 批准记录（ApprovalStore） | permission 模块 | 用户选择 always 时添加 |
| 请求队列 | permission 模块 | 添加/移除请求时 |

### 4.3 数据销毁责任

| 数据 | 销毁者 | 销毁时机 |
|------|--------|----------|
| PendingRequest | permission 模块 | respond() 处理后移除 |
| 批准记录 | permission 模块 | clearSession() 调用时 |
| PermissionInfo | permission 模块 | 请求完成后不再保留引用 |

### 4.4 责任边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| 创建权限请求内容 | 工具模块 | permission 模块 |
| 管理请求生命周期 | permission 模块 | UI 层 |
| 显示确认 UI | UI 层 | permission 模块 |
| 收集用户输入 | UI 层 | permission 模块 |
| 决定是否需要确认 | Policy 模块（调用方） | permission 模块 |
| 模式切换执行 | Policy 模块 | permission 模块 |

---

## 五、接口使用示例

### 5.1 工具调用权限确认

```typescript
// 工具模块中
async function executeEdit(file: string, content: string) {
  // 请求权限确认
  await Permission.ask({
    sessionId: currentSession.id,
    messageId: currentMessage.id,
    type: 'tool',
    name: 'edit',
    title: 'Edit file',
    metadata: {
      file_path: file,
      preview: content.slice(0, 100)
    }
  })

  // 权限通过后执行实际编辑
  await fs.writeFile(file, content)
}
```

### 5.2 UI 层响应处理

```typescript
// UI 层中
Bus.subscribe(Permission.Event.Updated, (event) => {
  const { info } = event
  showConfirmDialog({
    title: info.title,
    metadata: info.metadata,
    onOnce: () => Permission.respond(info.sessionId, info.id, { type: 'once' }),
    onAlways: () => Permission.respond(info.sessionId, info.id, { type: 'always' }),
    onReject: () => Permission.respond(info.sessionId, info.id, { type: 'reject' }),
    onSuggest: (text) => Permission.respond(info.sessionId, info.id, {
      type: 'suggest',
      suggestion: text
    })
  })
})
```

### 5.3 会话清理

```typescript
// Session 模块中
async function endSession(sessionId: string) {
  // 清理权限相关数据
  Permission.clearSession(sessionId)

  // 其他清理逻辑...
}
```

---

## 六、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 接口定义与 data-model.md 中的类型一致
- [x] 事件定义与 architecture.md 中的设计一致
