# interaction-broker 模块 goals-duty.md

本文档定义 `runtime/interaction-broker` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`packages/ohbaby-agent/src/runtime/interaction-broker/`
- 文档：`docs/runtime/interaction-broker/`

---

## 一、模块定位

**一句话说明**：interaction-broker 是 backend runtime 的用户交互暂停/恢复基础设施，负责为 command handler 创建 pending interaction、等待 UI response、处理取消/abort，并发布内部 interaction 事件。

**如果没有这个模块**：
- command handler 需要自己维护 pending promise，暂停/恢复逻辑会散落在各命令里。
- `/model`、`/session` 这类天然选择器无法和 remote/headless surface 共享同一交互协议。
- command abort 时，等待中的用户交互无法被统一清理。

---

## 二、Design Goals（设计目标）

### G1: Runtime Pending Request Registry

集中维护等待 UI 响应的 interaction 请求，保证 `interactionId` 唯一、可查询、可取消。

### G2: Handler-Friendly Async API

对 command handler 暴露 `await requestInteraction(req)` 风格的同步书写体验，避免 handler 显式管理 promise map。

### G3: Surface Agnostic

broker 只处理语义请求：`kind + subject + options`。它不知道 TUI dialog、stdout 文本、Web modal 或 IM channel 的具体渲染方式。

### G4: Abort 与清理可控

command 被 abort、session 关闭、client 断开或 daemon stop 时，broker 必须能拒绝 pending request，防止悬挂 promise。

---

## 三、Duties（职责）

### D1: 创建 interaction request

负责：
- 生成 `interactionId`。
- 记录 `commandRunId`、`clientInvocationId`、`sessionId` 和 abort signal。
- 发布 `Interaction.Event.Requested`。
- 返回等待 `UiInteractionResponse` 的 Promise。

### D2: 响应 interaction

负责：
- 接收 `respondInteraction(interactionId, response)`。
- 校验 interaction 是否仍 pending。
- resolve 对应 Promise。
- 发布 `Interaction.Event.Resolved`。

### D3: 取消和 abort

负责：
- 单个 command abort 时取消该 commandRunId 下的 pending interactions。
- daemon stop 或 client disconnect 时取消相关 pending interactions。
- 对 handler 返回 `cancelled` response 或 reject，具体语义由调用方选择并文档化。

### D4: 统一 interaction 语义

支持 V1 interaction kind：

| kind | 用途 |
|------|------|
| `select-one` | 单选，如 model/session/mode |
| `select-many` | 多选，V2 预留 |
| `confirm` | 确认/取消 |
| `text-input` | 输入文本，V2 预留 |

`subject` 表达业务对象，如 `model`、`session`、`agents-mode`。

---

## 四、Non-Duties（非职责）

### N1: 不负责 UI 渲染

broker 不知道 `ModelDialog`、`SessionDialog` 或 Ink 组件。UI 根据 SDK 事件自行渲染。

### N2: 不负责 permission

permission 也是暂停/恢复模型，但语义是授权、策略、记忆和审计。interaction 是用户主动选择/输入。两者可以共享内部工具，但模块边界保持独立。

### N3: 不负责 command 参数校验

broker 不判断 `/model switch` 的参数是否有效，也不决定非交互 surface 是否可弹选择器。命令 handler 和 surface policy 负责这些语义。

### N4: 不负责持久化

pending interaction 是进程内运行时状态，daemon 重启后全部失效。需要持久化的业务状态由对应服务负责。

---

## 五、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `commands` | 被调用 | CommandRunContext 调用 broker 创建 interaction |
| `runtime/daemon/command-events.ts` | 事件消费者 | 订阅 `Interaction.Event.*` 并投递到 stream-bridge app scope |
| `runtime/stream-bridge` | 间接输出 | broker 不直接调用 bridge |
| `permission` | 平行模块 | 可共享 pending registry 工具，但语义不合并 |
| `cli` / backend adapter | 被调用 | `respondInteraction()` 从 SDK client 回到 broker |

---

## 六、文档自检

- [x] 明确 interaction-broker 是 runtime 基础设施，而不是 commands 子功能。
- [x] 明确 broker 不渲染 UI，也不合并 permission。
- [x] 明确 command abort 时 pending interaction 必须清理。
