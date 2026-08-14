# 5. improve-1 实施验收

> 日期：2026-08-14
> 状态：已完成；代码、自动化测试、构建、真实进程 E2E 与两轮独立审查均通过

## 5.1 实际落地

1. `UiPromptCompletion.prompt` 现在只能是四种 `UiCompletedPromptSubmission` 终态；四种终态都有 `endedAt`，只有 `failed`、`interrupted` 带结构化错误。
2. `submitPromptAccepted`、`waitForPrompt` 成为基础能力；`submitPromptAndWait` 只调用前两者。旧 `submitPrompt` 仅作为 improve-1 迁移桥保留并标记弃用。
3. client 合同拆为 Query、Prompt Command、Prompt Queue Command 与完整 backend；生产 backend 的队列能力为必选。
4. scheduler 在 close、fault、等待中止和终态持久化竞态下都会确定 settle waiter，不再悬空。
5. interaction 建立 owner、claim、consume 与条件回滚边界，未知、越权、重复响应在 backend 调用前被拒绝。
6. SDK 定义 `UiCommandRecord`、`UiCommandRecorder`、脱敏 builder 与 fail-open helper；Agent/Server 提供有界、保序的结构化 recorder。
7. Agent host、Server REST、Server RPC 是三个入口各自的唯一记录 gateway；raw backend、`waitForPrompt`、`submitPromptAndWait` 和 skill 内部接单不重复记录。
8. `CoreAPI`、`SDKAPI` 改为从 SDK 权威能力派生，减少手抄接口漂移。

## 5.2 自动化验收证据

| 闸门 | 结果 | 证据 |
|------|------|------|
| 全仓测试 | 通过 | 275 个测试文件通过、3 个跳过；2369 个测试通过、13 个真实外部依赖测试跳过 |
| 构建 | 通过 | SDK、Agent、Server、CLI、Web 全部构建成功 |
| Prompt 数据与生命周期（T1-T10） | 通过 | SDK contract 和 mapper 覆盖四终态、字段不变量、非终态拒绝与 answer 分流；in-process、persistent 和 remote 按共享管线与各自关键路径分层覆盖 |
| 等待、关闭与恢复（T11-T15f） | 通过 | scheduler close/fault/abort、终态持久化失败和 finish/close/abort 竞态均确定 settle；durable accept 成功后即使 close/fault 抢先仍返回 receipt；真实 daemon 恢复后同一 `promptId` 得到 `interrupted` |
| 接口与兼容（T16-T20a） | 通过 | Query、Command、Queue 与完整 backend 类型边界通过 typecheck/contract；CoreAPI/SDKAPI 派生；旧 submit 兼容行为和可信 queue identity 有回归测试 |
| ID、脱敏与 fail-open（T21-T30b） | 通过 | operationId/领域 ID 分离、branded details builder、固定错误白名单、纯字母数字 secret、慢/失败 sink 和 observation 依赖异常均有对抗测试 |
| 记录所有权与 interaction（T31-T40） | 通过 | 三 gateway、组合方法与真实 skill 路径去重；REST/RPC/in-process fail-open；interaction owner/claim/条件回滚、终态/client removal/shutdown 清理和短暂重连均有行为测试 |

全仓测试在非 `CI` 的真实终端语义下运行，并通过临时 Corepack shim 固定嵌套打包测试使用仓库声明的 pnpm 9。`CI=true` 时只有两个既有 Ink flicker 用例因 Ink 的 CI 渲染模式超时；相同用例在正常终端和全量回归中通过，未通过放宽断言规避。

补充的关键真实路径证据不是 mock 自证：

1. fake-RPC 的等待中止测试经正式 `CoreAPI` factory 转发，证明 `AbortSignal` 不会在本地 RPC seam 丢失；
2. skill 去重测试创建真实临时 skill 文件，经 in-process backend 执行真实 `executeCommand -> skill -> prompt` 链，只记录外层原子命令；
3. server REST/RPC fail-open 测试使用会抛错的 recorder，业务写操作仍成功；
4. daemon 恢复测试杀死执行进程，重启后由正式 remote client 使用原 `promptId` 得到带结构化错误的 `interrupted`。

## 5.3 真实进程 E2E

验收脚本实际启动随机端口 daemon，使用临时 SQLite、临时 workspace 和内存 fake LLM，再由正式 remote client 通过 HTTP JSON-RPC 完成：

1. `/api/health` 鉴权探测成功；
2. `submitPromptAccepted` 返回 `clientRequestId`、`promptId`、`sessionId`、`userMessageId`；
3. `waitForPrompt(promptId)` 返回 `succeeded`，`endedAt` 必有且无 `error`；
4. 完整回答在 snapshot 数据流中可见，不进入 completion；
5. server-rpc 只输出同一 `operationId` 的 started/completed 各一条，completed 补充 `promptId`，details 仅有长度和布尔元数据；两次记录分别 fail-open，不承诺 sink 故障时强行成对；
6. client、daemon 和临时目录均在结束时关闭或清理。

## 5.4 仍保留到 improve-2 的工作

- 删除旧 `submitPrompt` 及旧 RPC method，迁移 CLI/TUI/Web 所有调用点。
- 删除 `UiPromptQueueClient` 旧聚合名和 `supportsPromptQueue` 等兼容探测。
- 落地 BrowserDaemonClient + browser façade，补齐 Web wait/interaction REST，并统一单一逻辑 SSE 数据流。
- 消除 Web `StoreSnapshot` 与 SDK `UiSnapshot` 的 `getSnapshot` 同名冲突。
- 清理 TUI 重复事件知识和逐方法 forwarding wrapper。

这些项目没有被 improve-1 的兼容桥伪装成“已经完成”，必须在 improve-2 重新执行全量测试、构建、真实进程 E2E 和独立审查。

## 5.5 独立审查

首轮代码审查与文档一致性检查均未发现 Critical，但提出了以下 Important/文档准确性问题，已在继续 improve-2 前处理：

1. executor 的 `interrupted` 曾被压成 `failed`：改为严格判别联合，并保持旧 `submitPrompt` 兼容桥的历史 reject 行为；
2. scheduler 在异步 accept/list/claim 与 close 竞争时仍可能接纳或遗留工作：增加阶段后关闭检查，并在 claim 被 close 抢先时 requeue；
3. fake-RPC signal 用例未经过正式 `CoreAPI` seam：补上 factory 级测试；
4. 记录中的错误名/错误码和公开 details helper 仍有绕过脱敏的空间：改成固定白名单和 branded details，只允许 SDK 方法级 builder 构造；
5. fail-open、interaction 记录边界和 daemon 恢复的验收证据不够直接：补上真实路径测试；
6. 文档把 recorder helper 全称为纯函数、写错 `slash-command/` 目录，并把 started/completed 描述为无条件成对：均按实际实现修正。
7. 第二轮复审发现 durable accept 已提交后仍可能因 close/fault 向调用方 reject：把持久化成功明确为 admission 线性化点，并补 close/fault 两个竞态测试。
8. 第二轮文档审查发现 interaction 清理与终态竞态证据未完整落证：补 cancelled 终态、client removal、shutdown、条件回滚败给终态，以及 retention 窗内重连的行为测试。
9. 最终复核发现同 clientId 新旧 SSE 重叠时，旧连接后断可能误启动 owner 清理：断连和 timer 到期都检查是否仍有同 clientId 活连接，并补“新连接先连、旧连接后断、跨过 retention 仍可响应”的集成测试。

审查中另有“skill 去重仅由 mock 覆盖”的意见，经核对不成立：仓库已有真实 in-process skill 文件与 fake LLM 的完整链路测试，并明确断言只有 `executeCommand` 的两条记录。因此未为同一行为再造重复测试。

第二轮只读复审没有 Critical；提出的 durable accept Important 和 interaction 验收证据缺口均已修复。修复后重新执行全仓回归、全量构建与真实 daemon E2E，均通过，因此 improve-1 可以进入 improve-2。
