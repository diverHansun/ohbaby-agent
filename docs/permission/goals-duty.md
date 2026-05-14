# permission 模块 goals-duty.md

本文档定义 `permission` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：permission 模块负责在运行时对敏感操作进行权限确认，是 Policy 模块决策的执行层，通过与用户交互获取操作授权。

**如果没有这个模块**：
- Policy 返回 "ask" 决策后无人处理，工具可能直接执行（不安全）
- 工具模块需要自行处理 UI 交互（违反职责分离）
- 无法支持 "always allow"（会话级批准）
- 无法统一管理待批准的权限请求队列
- 用户无法在拒绝操作时提供替代建议

---

## 二、Design Goals（设计目标）

### G1: 职责单一

模块只负责权限确认的执行，不负责决策逻辑。决策（allow/deny/ask）由 Policy 模块完成，permission 模块只处理 "ask" 场景下的用户交互。

### G2: 事件驱动

通过 Bus 模块发布权限事件，与 UI 层解耦。permission 模块不直接渲染 UI，而是发布事件通知 UI 层显示确认框。

### G3: 队列管理

同一会话中的多个权限请求串行处理，一次只显示一个确认框，避免用户混淆。

### G4: 支持批准记忆

支持会话级的 "always allow" 功能，用户批准后同类操作不再询问。批准记录以参数级粒度存储（如 tool:edit:src/**）。

### G5: 支持用户建议

当用户拒绝操作时，允许用户输入替代建议，该建议将返回给 LLM 重新规划。

### G6: Always 授权审计通知

当用户选择 "always allow" 时，通过 Bus 发布审计/协调事件，说明产生了会话级、Pattern 级的自动批准。permission 不直接切换 Policy 到 edit-automatically，后续匹配请求由 permission 自己按批准 Pattern 自动通过。

---

## 三、Duties（职责）

### D1: 执行权限确认

接收权限确认请求，通过 Bus 发布事件通知 UI 层显示确认框，等待用户响应。

### D2: 管理待批准队列

维护待批准的权限请求队列，确保串行处理。新请求加入队列末尾，当前请求处理完成后自动处理下一个。

### D3: 管理已批准列表

维护会话级的已批准权限列表，支持参数级粒度的模式匹配。在处理新请求前检查是否已被批准。

### D4: 处理用户响应

处理四种用户响应：
- once：本次允许，resolve Promise
- always：添加到批准列表，resolve Promise，发布审计/协调事件
- reject：拒绝操作，reject Promise
- suggest：拒绝操作并携带用户建议，reject Promise

### D5: 生成批准 Pattern

根据工具类型和参数自动生成批准 Pattern（如 tool:edit:src/**），用于后续匹配。

### D6: 发布权限事件

通过 Bus 发布以下事件：
- Permission.Event.Updated：新权限请求，通知 UI 显示确认框
- Permission.Event.Replied：用户响应，通知相关模块
- Permission.Event.SwitchModeRequested：通知上层一次 always 授权已产生，可用于审计或后续协调

### D7: 清理会话资源

会话结束时清理该会话的待批准队列和已批准列表，拒绝所有未处理的请求。

---

## 四、Non-Duties（非职责）

### N1: 不负责决策逻辑

权限决策（allow/deny/ask）由 Policy 模块完成。permission 模块只处理 Policy 返回 "ask" 的场景。

### N2: 不负责 UI 渲染

确认框的渲染由 CLI/UI 层负责。permission 模块只发布事件，不直接操作 UI。

### N3: 不负责模式管理

模式（ask/plan/ask-before-edit/edit-automatically）的管理由 Policy 模块负责。permission 模块不直接变更 Policy 状态，只发布 always 授权事件供上层记录或协调。

### N4: 不负责工具执行

工具的实际执行由各工具模块负责。permission 模块只返回确认结果（resolve/reject）。

### N5: 不负责超时控制

permission 模块不实现超时机制。如需超时控制，由 Agent 运行时层面处理。

### N6: 不负责关键操作定义

哪些操作是"关键操作"需要强制确认，由 Policy 模块定义。permission 模块只执行确认。

### N7: 不负责持久化

批准列表只存储在内存中（会话级），不持久化到文件系统。会话结束后批准记录自动清除。

### N8: 不处理 Ctrl+C 中断

当 Permission UI 显示等待用户决策时：
- Ctrl+C（包括双击）**不触发循环中断**
- 用户应使用 Permission UI 提供的 "Reject" 按钮拒绝操作
- CLI 层在 Permission UI 显示期间应忽略 SIGINT 信号

---

## 五、设计约束与假设

### 约束

1. **依赖 Bus 模块**：所有事件通过 Bus 发布，与 UI 层解耦
2. **会话级存储**：批准列表只在会话生命周期内有效，不跨会话
3. **串行处理**：同一会话的权限请求必须串行处理，避免并发确认
4. **不可恢复**：进程崩溃后待批准的请求丢失，需重新发起

### 假设

1. Bus 模块已正确实现事件发布订阅机制
2. UI 层会订阅 Permission.Event.Updated 事件并显示确认框
3. UI 层会调用 Permission.respond() 传递用户响应
4. 调用方保证传入有效的 sessionId 和 messageId

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| Policy | 被依赖 | 工具调用 Policy 获取决策；permission 不直接切换 Policy 状态 |
| Bus | 依赖 | 使用 Bus 发布权限事件 |
| CLI/UI | 被依赖 | UI 层订阅事件显示确认框，调用 respond() 传递响应 |
| 工具模块 | 被依赖 | 工具在执行前调用 Permission.ask() 获取确认 |
| Session | 被依赖 | Session 结束时调用 clearSession() 清理资源 |

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
