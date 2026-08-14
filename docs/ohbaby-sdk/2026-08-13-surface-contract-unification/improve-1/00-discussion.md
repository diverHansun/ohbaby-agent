# 讨论记录与已确认要点

> 2026-08-13 与用户逐项讨论确认。本文只冻结有效结论；早期假设和完整对话保留在 [`raw.md`](./raw.md)。

## 1. 背景与动机

用户的原始目标没有变化：让数据结构更整齐、写操作可审计、TUI 与 Web 共享权威契约，同时借鉴 code-cli 下优秀项目的做法，但不做货物崇拜。

代码调研确认：ohbaby 已经具备 `UiEvent` 联合、TUI subscribe+submit、SDK fake-RPC 和 Server JSON-RPC 等基础。真正承重的问题是 Prompt 方法的等待语义、客户端知识重复、写操作记录缺口、ID 语义混淆和读写接口边界，而不是是否拥有一个叫 `Op` 的类型。

## 2. 已确认：两轮边界

| 决策项 | 结论 |
|--------|------|
| improve 含义 | `improve-N` 是一轮完整优化，轮次内可包含多个问题，不按单个问题无限拆分 |
| 总轮次 | 只分 improve-1 与 improve-2 |
| improve-1 | 底层数据语义、Prompt 生命周期、接口能力、ID/命令记录和记录所有权 |
| improve-2 | CLI/TUI/Web/Server 采用、Web façade 与事件数据流、删除旧契约和兼容分支 |
| 实施顺序 | improve-1 通过单元/契约/集成验收后才能进入 improve-2 |
| 开发提交 | 每轮可拆多个职责单一的 commit；每轮结束执行完整相关测试 |

## 3. 已确认：Prompt 生命周期

### 3.1 三种能力

```ts
submitPromptAccepted(...): Promise<UiPromptReceipt>;
waitForPrompt(promptId, options?): Promise<UiPromptCompletion>;
submitPromptAndWait(...): Promise<UiPromptCompletion>;
```

通俗语义：

- `submitPromptAccepted`：下单并取得订单号；
- `waitForPrompt`：拿订单号等待出餐；
- `submitPromptAndWait`：下单后等待出餐，是前两者的组合能力。

旧 `submitPrompt(...): Promise<void>` 语义含糊。improve-1 提供迁移桥并标记弃用；improve-2 完成全仓迁移后删除，不长期双轨。

### 3.2 Completion 终态合同

已确认以下八项：

1. 保留 `UiPromptCompletion`。
2. 新增 `UiCompletedPromptSubmission`，只允许 `succeeded | failed | cancelled | interrupted`。
3. Completion 中 `endedAt` 必须存在。
4. `failed` / `interrupted` 必须带结构化 `UiPromptError`；`succeeded` / `cancelled` 不带 error。
5. 四种业务终态全部 resolve；只有查询、权限、传输、存储、未知 prompt、等待中止等技术失败才 reject。
6. scheduler 关闭时必须处理现有等待者，禁止悬空 Promise。
7. `submitPromptAndWait` 只组合两个基础方法，不建设第三条执行逻辑。
8. Completion 不承载完整回答内容；消息真相继续来自 `UiEvent` / `UiSnapshot`。

停止等待与取消 Prompt 是两件事。`waitForPrompt` 的 `AbortSignal` 只停止本地等待；排队取消继续使用 `cancelQueuedPrompt`，运行取消继续使用 `abortRun`。

## 4. 已确认：接口与队列能力

### 4.1 主边界

- `UiQueryClient`：读取和订阅；`waitForPrompt` 属于查询。
- `UiCommandClient`：会改变后端状态的具名方法。
- `UiBackendClient`：Query + Command 的组合，供完整生产客户端使用。
- Prompt 命令和队列命令可作为子能力类型复用，但不把三个 Prompt 方法强塞进一个接口。

### 4.2 Prompt 与队列拆分

当前 `UiPromptQueueClient` 同时混有基本接单/等待和高级队列编辑/租约。确认拆为：

- `UiPromptCommandClient`：`submitPromptAccepted`、`submitPromptAndWait`；
- `UiPromptQueueCommandClient`：编辑、取消、获取/续期/释放编辑租约；
- `waitForPrompt` 位于 `UiQueryClient`。

队列管理是生产 `UiBackendClient` 的必选能力。迁移完成后不再通过 `supportsPromptQueue()` 把基本提交能力与高级队列管理一起做运行时 feature detection。

## 5. 已确认：双层与具名方法

“双层”固定解释为：

```text
上层：具名方法，给人和业务代码使用
submitPromptAccepted / compactSession / abortRun / ...

下层：统一命令记录，给审计、日志和关联使用
UiCommandRecord → UiCommandRecorder
```

具名方法就是“每件事有一个清楚名字的普通函数”，不是让页面调用 `submit({ type: ... })`。下层记录也不是新的运输协议，不允许业务层手工拼记录来执行命令。

## 6. 已确认：关联 ID

统一的是关联规则，不是把不同语义强行改成一个名字。

| ID | 语义 |
|----|------|
| `operationId` | 一次后端 primitive gateway 写操作单元；新增。这里“原子”是记录边界，不等于数据库事务 |
| transport request `id` | 一次 JSON-RPC/HTTP 往返；文档中称 `transportRequestId` |
| `clientRequestId` | Prompt 客户端意图与幂等键，跨重试稳定 |
| `promptId` | 被接收的 Prompt 实体 |
| `runId` | 一次 Agent 执行 |
| `clientInvocationId` | 客户端发起的斜杠命令意图 |
| `commandRunId` | 斜杠命令实际执行 |
| permission `requestId` | 权限请求实体 |
| `interactionId` | 交互请求实体 |

现有领域 ID 全部保留，各司其职。审计记录通过 `correlation` 汇总相关 ID。不给全部 `UiEvent` 无差别增加 `operationId`。

## 7. 已确认：命令记录合同

### 7.1 名称与形状

用 `UiCommandRecord` 取代早期的 `UiCommandEnvelope`。`Envelope` 容易被误解为新的运输协议；`Record` 明确表示记录事实。

每个原子写操作使用一个 `operationId`，追加两条记录：

```text
phase=started
phase=completed, outcome=returned | threw
```

`returned` 表示方法正常返回。若 `submitPromptAndWait` 返回 `{ prompt: { status: "failed", ... } }`，Prompt 业务失败但方法仍是 `returned`，不能误记为传输异常。

### 7.2 安全与故障策略

- `details` 按方法白名单生成并脱敏，禁止默认保存原始 params。
- Prompt 正文、API key、密钥值、权限敏感输入不得进入默认记录。
- SDK 定义 `UiCommandRecord`、同步接收语义的 `UiCommandRecorder` 和无 I/O 的 best-effort 包装能力；异步落盘由 recorder 内部有界、保序 sink 负责，业务路径不等待 I/O。
- Agent/Server 提供真实 recorder。
- recorder 采用 fail-open：记录失败不改变业务结果；同时必须有有界、非递归的诊断通道。正常 Agent/Server 装配使用真实 recorder，no-op 只用于测试或显式关闭模式。
- 不引入无界内存队列，不在请求路径无限重试。

### 7.3 唯一记录所有权

“谁第一次接收外部写意图，谁记录；下游 raw backend 不重复记录。”

| 路径 | 权威记录点 |
|------|------------|
| Web REST → Server → backend | Server REST command gateway |
| JSON-RPC → Server → backend | Server RPC command gateway |
| TUI/CLI in-process → Agent host → backend | Agent host command gateway |

浏览器 client、scheduler、底层 persistent/in-process backend 不自记。组合方法只记录内部的原子写，例如 `submitPromptAndWait` 只记录 `submitPromptAccepted`；`waitForPrompt` 是查询，不进入命令记录。

## 8. 已确认：边界与不做事项

| 项 | 结论 |
|----|------|
| 通用 `UiOp` 取代具名方法 | 不做 |
| TUI 改 HTTP/SSE | 不做 |
| 工作区、目录选择器、浏览器导航进 SDK | 不做 |
| 审计数据库、回放产品、合规账本 | 不做 |
| 默认记录完整参数 | 禁止 |
| 为“整齐”给所有事件加 `operationId` | 不做 |
| 在 backend 与 gateway 双重记录 | 禁止 |
| 在本规划会话修改应用代码 | 不做，实施另开会话 |

## 9. 与 improve-2 的关系

improve-1 提供新合同和迁移桥；improve-2 负责：

- CLI/TUI/Web 选择正确的 Prompt 能力；
- Web 的 `BrowserDaemonClient` 实现 SDK 权威合同；
- Browser runtime 保留为应用 façade，不形成第二个业务 client；
- 单一 SSE 逻辑订阅和统一 `UiEvent` 分发；
- 删除旧 `submitPrompt`、旧 RPC method、`supportsPromptQueue` 和手抄契约。

## 10. 未决项

本轮没有会改变架构或数据语义的未决项。字段的最终 TypeScript 排列、文件拆分和错误类名称属于可逆实现细节，但必须符合 02 的语义与 04 的验收标准。
