# interaction-broker 模块 data-model.md

本文档描述 `runtime/interaction-broker` 模块的核心数据模型。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话说明 |
|------|-----------|
| InteractionRequest | backend 请求 UI 进行选择、确认或输入 |
| InteractionResponse | UI 对 request 的响应 |
| PendingInteraction | broker 内部等待响应的实体 |
| InteractionEvent | broker 发布的内部事件 |

---

## 二、Key Data Fields（关键数据字段）

### 2.1 InteractionRequest

对 SDK 侧投影为 `UiInteractionRequest`：

| 字段 | 含义 |
|------|------|
| `interactionId` | broker 生成的唯一 ID |
| `commandRunId` | 关联 command run |
| `clientInvocationId` | 关联 UI invocation |
| `kind` | `select-one` / `select-many` / `confirm` / `text-input` |
| `subject` | 业务对象，如 `model`、`session`、`agents-mode` |
| `prompt` | 简短提示文本 |
| `options` | 选择项，select 类 interaction 使用 |
| `defaultValue` | 默认值，confirm/text-input 可使用 |

### 2.2 InteractionResponse

| 字段 | 含义 |
|------|------|
| `kind` | `accepted` / `cancelled` |
| `choiceId` | 单选结果 |
| `choiceIds` | 多选结果 |
| `value` | 文本输入或 confirm 结果 |
| `reason` | 取消原因，如 `user-cancelled`、`aborted`、`timeout` |

### 2.3 PendingInteraction

| 字段 | 含义 |
|------|------|
| `interactionId` | pending map key |
| `commandRunId` | owner，用于 abortByCommandRun |
| `clientInvocationId` | UI correlation |
| `sessionId` | 可选 session 关联 |
| `createdAt` | 创建时间 |
| `request` | 原始请求 |
| `resolve/reject` | promise 控制函数 |

---

## 三、Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建者 | 所有者 | 生命周期 |
|------|--------|--------|----------|
| `interactionId` | InteractionBroker | InteractionBroker | request 创建到 resolved/aborted |
| `PendingInteraction` | InteractionBroker | InteractionBroker | 仅内存存在 |
| `Interaction.Event.Requested` | InteractionBroker | Bus/事件消费者 | 创建 pending 后立即发布 |
| `Interaction.Event.Resolved` | InteractionBroker | Bus/事件消费者 | response 被接受后发布 |
| `UiInteractionRequest` | daemon/command-events.ts | SDK client | 内部事件投影结果 |

---

## 四、文档自检

- [x] 区分 request、response、pending entry。
- [x] interaction kind 与 UI dialog 名称解耦。
- [x] pending interaction 的所有权没有落到 commands 或 UI。
