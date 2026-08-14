# improve-1 · 底层契约与命令记录基础

> 状态：已实施并关闭首次审查欠账；自动化、真实进程 E2E 与独立复审证据见 [05-implementation-acceptance.md](./05-implementation-acceptance.md)。
> 日期：2026-08-15
> 前置：无
> 后续：[`../improve-2/`](../improve-2/)

## 1. 本轮目标

先把多前端共同依赖的地基做正确：

- 明确 Prompt 的“接单、等待、接单并等待”三种语义；
- 用 `UiPromptCompletion` 表达四种结构化终态；
- 拆分查询、命令、Prompt 命令和队列管理能力；
- 队列管理成为生产 `UiBackendClient` 的必选能力；
- 用 `operationId` 和 `UiCommandRecord` 建立写操作记录合同；
- 保留各领域 ID 的原意，通过 `correlation` 汇总关联；
- 在 Server gateway 与 Agent host gateway 建立唯一记录点，底层 backend 不自记；
- 为 improve-2 提供可迁移、可测试的新合同。

本轮不以“数据形状看起来整齐”为理由引入通用 `submit(op)`，不改变 TUI 同进程和 Web HTTP+SSE 的拓扑。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策、术语和边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | Prompt、接口、ID、审计和现有测试的代码基线 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 本轮实施阶段、API 目标形状、迁移桥和文件改动面 |
| [03-reference-projects.md](./03-reference-projects.md) | Codex、OpenCode、Kimi、Kun、SpeedClaw 的选择性借鉴 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 类型、生命周期、记录去重、fail-open 与跨 transport 验收 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实际改动、测试、真实进程 E2E、独立审查与残余风险 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为执行契约；若与 `00` 冲突，先修文档，不得自行解释。

## 3. In scope

1. SDK Prompt 终态数据模型与三种方法语义。
2. `UiQueryClient`、`UiCommandClient` 及 Prompt/队列子能力。
3. 将现有 `UiPromptQueueClient` 的基本生命周期与队列编辑/租约管理拆开。
4. `operationId`、`UiCommandRecord`、`UiCommandRecorder`、脱敏 details 和关联 ID 规则。
5. Prompt scheduler 的终态保持、关闭等待者和重连后再次等待语义。
6. Server/Agent 记录所有权与 fail-open 包装器。
7. `CoreAPI` / `SDKAPI` 先由 SDK 权威类型派生，停止继续手抄。
8. 新旧 Prompt API 的短期迁移桥；旧入口的最终删除留给 improve-2。

## 4. Out of scope

| 项 | 原因 / 后续落点 |
|----|-----------------|
| CLI/TUI/Web 全量调用点迁移 | improve-2 |
| 删除旧 `submitPrompt` 与旧 JSON-RPC method | improve-2 在所有调用方迁移后执行 |
| 删除 `OhbabyWebClient`、Web façade 重构 | improve-2 |
| TUI `TuiEvent` 清理和 Web 单一事件分发点 | improve-2 |
| 审计数据库、回放 UI、合规账本 | 无当前需求，YAGNI |
| 将审计记录默认持久化完整 params | 有隐私和密钥泄露风险，明确禁止 |
| 给所有 `UiEvent` 增加 `operationId` | 事件可能由多个操作或内部过程产生，关联会失真 |
| TUI 改走 HTTP/SSE | 产品拓扑不变 |
| 通用 `UiOp` / `submit(op)` 取代具名方法 | 增加调用复杂度且不服务当前约束 |

## 5. 实施闸门

本轮完成必须同时满足：

- `UiPromptCompletion` 在类型和运行时都只包含终态；
- 四种业务终态 resolve，技术性等待失败 reject；
- 所有生产 backend 实现基本 Prompt 与队列管理能力；
- 正常 recorder sink 下，一次外部原子写各产生一条 `started/completed`，两阶段分别 best-effort 并复用同一 `operationId`；
- recorder 故障不改变业务结果，并能产生有界诊断；
- Prompt 文本、API key 等敏感值不进入默认记录；
- 单元、契约、集成测试和 typecheck 全部通过。

只有 improve-1 通过上述闸门后，才进入 improve-2。
