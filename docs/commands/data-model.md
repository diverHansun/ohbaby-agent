# commands 模块 data-model.md

本文档描述 `commands` 模块的核心抽象与数据模型。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话说明 |
|------|-----------|
| CommandCatalog | backend 组装的命令目录 |
| CommandSpec | 单个命令的 catalog 描述 |
| CommandInvocation | SDK resolver 后提交的命令调用 |
| CommandHandler | backend 内部执行函数 |
| CommandRunContext | handler 发布输出、动作、错误和 interaction request 的受控上下文 |
| CommandOutput | handler 产生的语义化输出 |
| CommandAction | handler 请求 surface/backend 执行的语义动作 |
| InteractionRequest | handler 通过 runtime/interaction-broker 发起的用户交互请求 |

---

## 二、Entity / Value Object 区分

| 概念 | 类型 | 说明 |
|------|------|------|
| CommandCatalog | Value Object | 每次构建产生新版本 |
| CommandSpec | Value Object | catalog item，不持有运行状态 |
| CommandInvocation | Value Object | 一次命令提交 |
| CommandHandler | Service Function | 调用 backend 服务完成业务 |
| CommandRunContext | Runtime Object | 每次命令执行创建，持有 commandRunId、signal 和事件 sink |
| InteractionRequest | Entity | 由 runtime/interaction-broker 持有 `interactionId` 并等待 response |

---

## 三、Key Data Fields（关键数据字段）

### 3.1 CommandSpec

对 SDK 下发时映射为 `UiCommandSpec`：

| 字段 | 含义 |
|------|------|
| `id` | 稳定 ID，如 `model.switch` |
| `path` | slash 路径，如 `["model", "switch"]` |
| `category` | 分类，如 `model`、`session` |
| `description` | UI 展示说明 |
| `argsHint` | 参数提示 |
| `argumentMode` | `raw` / `argv` / `structured` |
| `aliases` | alias path 列表 |
| `source` | 命令来源 |
| `surfaces` | 可见 surface |
| `parentBehavior` | 父命令 Enter 行为 |

### 3.2 CommandInvocation

| 字段 | 含义 |
|------|------|
| `clientInvocationId` | UI 提交关联 ID |
| `commandId` | canonical command id |
| `path` | canonical path |
| `rawArgs` | 原始参数文本 |
| `argv` | SDK 切分的参数 |
| `sessionId` | 当前会话 |
| `surface` | 发起 surface |
| `argumentMode` | catalog 声明的参数模式，便于 backend 选择校验逻辑 |

### 3.3 ModelSwitchArgs

`/model switch <provider> <model-id>` 的领域参数：

| 字段 | 规则 |
|------|------|
| `provider` | 输入大小写不敏感，canonical 输出小写，不支持 alias |
| `modelId` | 可接受 provider 内 alias，最终解析为 canonical model id |

示例：

```text
/model switch Anthropic claude-opus-4.7
```

可解析为：

```typescript
{
  provider: 'anthropic',
  modelId: 'claude-opus-4-7',
  usedModelAlias: 'claude-opus-4.7'
}
```

### 3.4 CommandHandler

CommandHandler 是 backend 内部执行函数，不进入 catalog 下发：

```typescript
interface CommandHandler {
  id: string
  execute(args: ResolvedArgs, ctx: CommandRunContext): Promise<void>
}
```

约束：
- `id` 必须与 `UiCommandSpec.id` 对应。
- `execute()` 不返回业务结果；`Promise<void>` 只表示 handler 已完成或抛错。
- handler 不直接 import TUI、stream-bridge 或 SDK client。

### 3.5 CommandRunContext

CommandRunContext 是一次 command run 的受控能力集合：

| 字段/方法 | 含义 |
|------|------|
| `commandRunId` | backend 分配的 command run ID |
| `clientInvocationId` | UI 提交时生成的关联 ID |
| `sessionId` | 当前 session，可为空 |
| `signal` | command abort 信号 |
| `emitOutput(output)` | 发布 `Commands.Event.ResultDelivered` 的输出部分 |
| `emitAction(action)` | 发布 `Commands.Event.ResultDelivered` 的动作部分 |
| `fail(error)` | 发布 `Commands.Event.Failed` |
| `requestInteraction(req)` | 交给 `runtime/interaction-broker`，等待 UI response |

CommandRunContext 必须保证：
- `command.started` 对每次 invocation 只发布一次。
- `command.failed` 或最终 result 的终态语义只发布一次。
- abort 时拒绝 pending interaction 并发布明确失败或取消事件。

### 3.6 CommandOutput / CommandAction

Handler 不返回 UI 组件名，而是产生语义化输出或动作：

| 类型 | 含义 |
|--------|------|
| `text` | 简短纯文本输出 |
| `markdown` | 可富文本渲染的输出 |
| `data` | 带 `subject` 的结构化数据 |
| `action` | 语义动作，如 exit、switch-session、refresh-catalog |

不建议使用裸 `payload: unknown` 作为唯一结果形态。结构化数据可以使用 `data.subject + data` 承载，但 command result 顶层仍应保持可判别。

---

## 四、Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建者 | 责任 |
|------|--------|------|
| CommandCatalog | CommandService | 版本化、过滤、alias 校验 |
| CommandSpec | loader | 描述命令，不执行 |
| CommandInvocation | UI/SDK | commands 消费 |
| CommandHandler | loader | 与 spec 成对注册，不下发 UI |
| CommandRunContext | CommandService | 限定 handler 能发布的事件和交互能力 |
| CommandOutput/Action | handler | 经由 `Commands.Event.*` 回流 |
| InteractionRequest | runtime/interaction-broker | 等待并恢复命令 |

---

## 五、与其他模块的概念边界

| 概念 | commands 视角 | SDK/UI 视角 |
|------|---------------|-------------|
| catalog | 真源 | 消费和补全 |
| args | 领域参数校验 | raw/argv 词法结果 |
| interaction | 通过 broker 暂停命令并等待 | 渲染选择器并回应 |
| result | 后端内部 command event | SDK event payload 和 UI 渲染材料 |

---

## 六、文档自检

- [x] 区分 catalog、invocation、effect。
- [x] 明确 model/provider 参数规则。
- [x] 没有 UI dialog 类型泄漏。
