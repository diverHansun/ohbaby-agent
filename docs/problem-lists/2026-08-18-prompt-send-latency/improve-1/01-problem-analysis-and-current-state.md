# 1. 问题基线与当前实施状态

> 时间口径：2026-08-18，`main@474f147`。下文描述当前代码实际行为；目标态只在 §1.2 用于划定诊断边界，实施方案见 02。

## 1.1 问题陈述

1. **用户语言**：首条消息发出后，输入框空了，页面仍像没有收到操作；数秒后自己的话和 Thinking card 才突然一起出现。
2. **后端事实**：`packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 的 `submitPromptInternal` 先等待 runtime 创建、MCP/tool 刷新和 `runtime.startSession(...)`，成功后才发布 UI 用户 `message.appended`。
3. **Web 放大**：`apps/ohbaby-web/src/ui/App.tsx` 的 Composer 成功后才清 draft；首 session 还等待 `selectSession`。`showMain` 只看正式消息，pending 又在看到 `queued` 时被清除，形成“输入框已空、主区无反馈”的真空。
4. **身份分裂**：prompt admission 已预分配 `userMessageId`，UI 正式消息使用它；core runner 的 `writeInitialUserMessage` 却调用 message factory 生成另一个 ID，乐观层也只有 `pending:${clientRequestId}`。
5. **隐藏竞态**：scheduler 将 prompt claim 为 `starting` 后才执行，但最终跨进程 session 排他由更深处的 DB run ledger claim 决定。把 adapter 正式消息简单前移到 execute 开头会在 busy requeue 时产生错误的 conversation 投影和补偿；它本身不直接写 core 上下文。真正的存量并发可见性来自 runner 在 ledger claim 前短暂写入 core message。
6. **现有事实足够**：`UiPromptSubmission` 已提供 `queued/starting/running/terminal` 状态、文本关联和 `userMessageId`；无需新 SSE 事件即可填补启动窗口。

## 1.2 已确认的产品/技术分界

- 三阶段是展示接管链，不是新的业务状态机：`local optimistic → prompt starting projection → formal UiMessage`。
- queued 仍在 Queue，不是正式 conversation message；busy 可从 starting 回退 queued。
- 正式消息不前移到 scheduler execute 开头；只补齐稳定 ID。
- Web 立即 commit 输入；TUI 本批不增加 provisional 展示。
- HTTP admission spinner 与 Thinking 生命周期分开。

```text
当前（空闲首条）

Enter
  → POST /v1/prompts
  → prompt.submitted(queued)
  → prompt.updated(starting)
  → HTTP 202 + selectSession
  → Composer 清空
  → createRuntime / refreshMcpTools / runtime.startSession     ← 可数秒
  → formal message.appended + run updates
  → 用户气泡与 Thinking 一起出现

已确认的展示接管目标

Enter 同帧
  → local optimistic user + startup Thinking + admission spinner
  → receipt：获得 userMessageId，spinner 停止
  → prompt.updated(starting)：server projection 接管，Thinking 继续
  → formal message.appended：权威消息接管
  → run running：真实 run Thinking 接管
```

---

## 1.3 后端：prompt scheduler、UI adapter 与 core runner

### 1.3.1 goals-duty

`packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.ts` 的 `accept` 负责 admission、幂等和入队；drain/claim 负责将可执行 prompt 置为 `starting` 并调用 execute。`packages/ohbaby-agent/src/runtime/run-manager/manager.ts` 则负责真正的 run ownership、生命周期和执行。

当前 UI adapter 把正式用户消息的可见性放在 `runtime.startSession` 成功之后。这让 UI 等待 runtime 内部细节，但不意味着应该把正式消息反向塞到 scheduler ownership 之前；两个 claim 的语义不同，必须显式区分。

### 1.3.2 architecture

`packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 的当前控制流：

1. scheduler `execute` 把 `reservedUserMessageId` 传入 `submitPromptInternal`；
2. `getRuntimeForPrompt()` 可能首次创建 UI runtime composition；
3. composition 初始化会等待 MCP/tool 刷新；
4. adapter 在内存构造 UI user message，但尚未发布；
5. `await runtime.startSession(...)`；
6. 成功后 `upsertSession` 并发布用户 `message.appended`。

`packages/ohbaby-agent/src/core/agents/runner.ts` 的 `runAgent` 又执行：

1. `toolScheduler.getAvailableTools(...)`；
2. `writeInitialUserMessage(...)` 创建 core 用户消息；
3. `runCoordinator.create(...)`；
4. 若 create 抛错，删除刚创建的 core 用户消息并向上抛出。

`packages/ohbaby-agent/src/runtime/run-manager/manager.ts` 的 `create` 内部调用 `runLedger.claimPendingRun(...)`。数据库 ledger 才是多进程下最终的 session 排他边界。scheduler claim 与 run-ledger claim 之间仍可能遇到 `SessionRunBusyError`。

这里还存在一个本批不扩大的存量窗口：runner 会先把 core user message 插入 message store，再调用 `RunManager.create()` 获取 ledger ownership；busy 时随后删除。`packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` 的 snapshot 会通过 `messageManager.listBySession()` 读取 core message，因此并发 snapshot 或上下文读取理论上可能短暂观察到这条消息。adapter 的正式 `message.appended` 仍在 ownership 成功后发布，但这不等于 core message 在此前绝不可见。

因此存在两种不同问题：

- **可安全解决的感知延迟**：用已经发布的 `prompt.updated(starting)` 做 provisional UI；
- **不应顺手扩大范围的核心生命周期问题**：要彻底消除 core claim 前短暂可见窗口，需要重排 core message 写入与 run 启动，或拆分 run claim/start；这会影响 parent message/context 构造，复杂度远高于本议题收益。本批只保证不额外提前 adapter 正式投影，并在 busy 完成后无 core 残留。

### 1.3.3 data-model

| 实体 | 创建/可见时机 | 当前身份与问题 |
|------|---------------|----------------|
| `UiPromptSubmission` | admission 创建；claim 时更新为 `starting` | 已有 `clientRequestId`、`userMessageId`、prompt 文本/状态，可作为服务端 provisional 来源 |
| `UiPromptReceipt` | HTTP 202 | 已有全部关联 ID，但没有完整 `UiMessage`；协议形状不是瓶颈 |
| UI `UiMessage` | `runtime.startSession` 成功后发布 | id 使用 prompt 预分配 `userMessageId`，但到达较晚 |
| core `Message` | `runAgent.writeInitialUserMessage` | `core/message/factory.ts` 总是生成新 ID，未复用 prompt 的 `userMessageId` |
| Web `PendingPrompt` | POST 发起附近 | 只有 `clientRequestId/text/createdAt/sessionId`；展示 key 为 `pending:${clientRequestId}`，receipt 后未稳定切换 |

ID 分裂不会立即造成两条 UI 气泡，但会削弱重放、错误关联和跨层诊断：同一用户动作在 prompt、UI message、core message 中不是同一个实体标识。

### 1.3.4 dfd-interface

```text
Web
  POST /v1/prompts
       ↓
server → scheduler.accept
       ↓
prompt.submitted(queued) → HTTP 202
       ↓ async drain
scheduler claim → prompt.updated(starting)
       ↓
execute → getRuntime / MCP / runtime.startSession
                         ↓
                 runAgent writes core user message (new id)
                         ↓
                 RunManager.create → DB run-ledger claim
                         ↓ success
UI adapter publishes formal message.appended (reserved userMessageId)
```

已存在的 `prompt.updated(starting)` 比正式消息早，且带足够关联信息。`packages/ohbaby-sdk/src/events.ts` 无需增加事件；问题在 Web 没有把该事实投影为启动中的对话反馈。

### 1.3.5 use-case

| 场景 | 当前行为 | 风险/缺口 |
|------|----------|-----------|
| 空项目第一条 | queued/starting 已发生，页面仍等正式 message | 欢迎页真空最明显 |
| idle 旧 session 再发 | pending 短暂出现后可能被 queued 清掉 | 用户气泡闪烁或消失 |
| active run 再发 | prompt 保持 queued，Queue 可显示 | 这是正确产品语义，不应把该条乐观插入 conversation |
| cross-runtime busy | scheduler 已 starting，RunManager ledger claim 失败，scheduler requeue | 若提前 adapter 正式投影，将需要删除/撤回并造成跨客户端闪烁；core 临时消息则是存量的极短可见窗口 |
| runtime/startSession 前失败 | 没有正式 UI message | 已受理的用户文本和失败原因缺少稳定的对话内呈现 |

### 1.3.6 non-functional

- **感知延迟**：首次 MCP/runtime 成本被暴露为“发送没有反应”，而不是“系统启动中”。
- **一致性**：一个用户动作有多套 ID，难以可靠去重和追踪。
- **可靠性**：busy 是正常调度分支，不能再增加一层 adapter 正式 conversation message 的补偿。core 现有 create-before-ledger/delete-on-busy 只作为残余风险记录。
- **复杂度**：为提前正式落消息而拆 run claim/start，会把 UI 体验问题升级成核心生命周期改造，违反 KISS/YAGNI。
- **可观测性**：现有 prompt status 已表达 admission/starting/terminal，优先用它，不再新增平行状态。

### 1.3.7 test

- scheduler 测试覆盖 `starting → queued` 的 busy requeue，但没有 Web 投影验收。
- `packages/ohbaby-agent/src/core/agents/runner.unit.test.ts` 已覆盖 run create 失败会删除 core 用户消息；没有断言预分配 ID 被复用。
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` 固化了正式 UI 消息在 `startSession` 成功后的现状。本批不再要求把它前移，但要增加“busy requeue 前不得正式 append”与 UI/core 同 ID 的相关断言。

---

## 1.4 Web：`apps/ohbaby-web`

### 1.4.1 goals-duty

[`docs/ohbaby-web/goals-duty.md`](../../../ohbaby-web/goals-duty.md) G1 要求 UI 是 snapshot/SSE 的投影，不是事实源。短期 optimistic overlay 并不违反该职责，前提是：

- 它只填补服务端事实尚未到达的窗口；
- 服务端 submission/message 有确定的覆盖优先级；
- 不凭文本猜测身份；
- reload 后不需要重建同一份本地状态。

当前 pending 已是本地展示态，但缺少稳定 ID 接管和正确寿命，所以既没形成即时体验，也没形成可靠对账。

### 1.4.2 architecture

`apps/ohbaby-web/src/ui/App.tsx`：

- `showMain = !view.isEmpty || commandNotices.length > 0`；
- `selectors.ts` 的 `isEmpty` 只看正式 `messages.length`；
- pending 在 EmptyState 和 ConversationStream 中有不同位置，不能驱动页面可靠切壳；
- `Composer.send` 等 `onSubmit` resolve 后才 `setDraft("")`；
- `submitText` 在首 session 上还等待 `runtime.selectSession(receipt.sessionId)`；
- receipt submission 与 `selectSession` 位于同一异步失败边界，当前尚未区分“HTTP 未受理”与“已 202、只是导航失败”；立即 clear 改造若不拆开，会产生错误恢复与重复发送风险；
- Send button 无 admission loading 图标。

OpenCode 的关键区别不是“框架更多”，而是 `setBusy + optimistic.add + clear input` 在同一批本地更新中完成；协议消息随后按 ID 覆盖 overlay。

### 1.4.3 data-model

当前 `PendingPrompt` 只适合表示单次本地尝试，却被当作 message、submission 和 loading 的混合生命周期使用。导致：

- receipt 到达后仍以临时 key 展示；
- queued/starting/message 的到达顺序影响是否被过早清除；
- pending 清除时会连带移除本地 Thinking；
- 第二次提交可能覆盖尚未完成对账的第一次 pending。

本批不需要通用 optimistic store，但需要让最小 local attempt 保留 `clientRequestId`、文本、创建时间，以及 receipt 返回的 `userMessageId/sessionId`，并把最终显示改为纯派生优先级。

### 1.4.4 dfd-interface

当前对账 effect 大意为：找到同 `clientRequestId` 的 prompt 后，若 queued、message visible 或不再 starting/running，则清 pending。真实事件通常是 `queued` 先于 receipt 和 formal message，因此 idle 首条会被过早清理。

另外，用户气泡与 Thinking 共用 pending 的存在性：一旦 message 到达并清 pending，而 run 状态稍后才到，Thinking 可能产生第二个短暂空窗。

### 1.4.5 use-case

| 场景 | 当前行为 |
|------|----------|
| receipt Promise 未完成 | draft 尚未清；pending 不一定切主布局；按钮只是 disabled |
| queued 事件先到 | pending 被清，首条反馈消失 |
| starting 事件先到 | Web 不把 submission 画成用户行/启动反馈 |
| formal message 到达 | pending 清除；是否无缝取决于 run update 时序 |
| HTTP 失败 | 因 draft 原本没清，大体不丢；改为立即清后必须安全恢复 |
| receipt 已 202，但 `selectSession` 失败 | 当前共享 submit Promise/错误边界；目标改成立即 clear 后若仍按 submit failure 回滚，会把已受理 prompt 当成未发送 |
| 用户失败前已输入新草稿 | 当前没有恢复覆盖问题；新方案必须保持这一性质 |
| running 时再发 | 应只进 Queue，不能统一套 optimistic conversation row |

### 1.4.6 non-functional

- **响应性**：第一帧反馈受网络 Promise 和 session selection 控制。
- **可访问性**：缺少 `aria-busy` 与 reduced-motion 下的 admission 状态。
- **可维护性**：命令式“看到某状态就 setPending(null)”容易遗漏乱序组合；纯展示优先级更容易单测。
- **多提交**：不应为当前问题预建通用多实体框架；Composer 的 HTTP in-flight 禁用和 Queue 语义足以控制本批范围，但测试必须防 pending 被后续 queue 项误清。

### 1.4.7 test

- `App.unit.test.tsx` 已覆盖 receipt 前 pending，但有测试假定 queued snapshot 已含 user message，从而固化了生产中不成立的时序。
- 缺少 Enter 同帧切主布局、draft 立即清、button spinner、starting projection、ID 接管、busy requeue、Thinking 独立寿命与乱序事件测试。
- `streamScroll.ts` 已有跟滚策略；本批先做回归，不因 optimistic 引入新滚动架构。

---

## 1.5 TUI：`packages/ohbaby-cli/src/tui`

`packages/ohbaby-cli/src/tui/components/prompt/index.tsx` 的 `submitInput` 已先 `replaceInput("")` 再 fire-and-forget submit。`packages/ohbaby-cli/src/tui/store/events.ts` 只在正式 `message.appended` 时加入用户消息。

因此 TUI 也会等正式消息，但没有 Web 欢迎页/布局切换这一放大器。精简方案不再通过提前正式消息顺带改变 TUI；若 TUI 也需要即时启动投影，应在后续批次基于 `prompt.updated(starting)` 单独评估，而不是污染核心 run ownership。

## 1.6 SDK / HTTP

`packages/ohbaby-sdk/src/prompt.ts` 的 `UiPromptReceipt` 已含对账所需 ID。`packages/ohbaby-server/src/app/create-app.ts` 的 `POST /v1/prompts` 在 admission 后返回 202，不等待 execute。协议形状不是瓶颈，本批无需 breaking change。

## 1.7 跨模块一致性

| 主题 | 后端现状 | Web 现状 | 本批诊断 |
|------|----------|----------|----------|
| admission | prompt queued + receipt | 等 Promise | 可立即本地反馈 |
| startup | prompt starting 已发布 | 未投影 | 应成为 server provisional 层 |
| authoritative message | startSession 成功后发布 | 唯一可靠用户行 | 保持权威并统一 ID |
| busy | starting 可回 queued | 无显式回退视图规则 | 应由派生优先级自然回 Queue |
| queued | 不写正式 message | Queue + pending 误清 | 产品语义保留，修本地寿命 |
| Thinking | run 更新驱动 | pending/run 生命周期耦合 | 需独立连续接管 |

## 1.8 改动影响面（现状视角）

| 包 | 预计涉及文件 |
|----|--------------|
| `packages/ohbaby-agent` | `core/message/types.ts`、`core/message/factory.ts`、`core/agents/types.ts`、`core/agents/runner.ts`、必要的 service/instance 参数透传与测试 |
| `apps/ohbaby-web` | `ui/App.tsx`、可选的局部 selector/helper、`ui/styles.css`、`ui/App.unit.test.tsx` |
| `packages/ohbaby-agent` scheduler/adapter | 主要补测试和确认既有 `starting/busy` 契约；不前移正式 publish |
| `packages/ohbaby-sdk` / `ohbaby-server` | 不改公开 schema 与 HTTP 202 语义 |
| `packages/ohbaby-cli` | 不改功能，只回归 |

## 1.9 SWE 原则审视摘要

- **管理偶然复杂度**：复用现有 prompt/message 事实，避免为三个时间窗口新建状态机。
- **KISS/YAGNI**：不拆 `RunManager` claim/start，不新增 SSE/receipt 字段；体验收益不需要这些高代价改造。
- **信息隐藏**：core message factory 负责“使用给定 ID 或生成 ID”；Web 不应了解 core/run-ledger 内部细节。
- **单一权威来源**：正式 `UiMessage` 最高优先级；starting/local 只是缺位时的展示投影。
- **显式胜过隐式**：busy 是合法状态迁移，文档和测试必须直接写出 `starting → queued`，不能把它当异常角落。
- **合理权衡**：receipt 前暂时使用 clientRequestId key，是 ohbaby 服务端分配 message ID 下不可避免的短窗口；receipt 后不再保留平行身份。

## 1.10 与既有文档关系

| 文档怎么说 | 实现事实 | 本批对齐方式 |
|------------|----------|--------------|
| 2026-07-12：queued 不是 conversation message | 当前符合 | 保持；active run 再发只进 Queue |
| 2026-07-12：claim 后以预分配 ID 提升 | 实现有 scheduler claim 与最终 ledger claim 两层 | 将 starting 用作 provisional；正式提升仍等最终 ownership，避免误读“claim” |
| 2026-07-12：客户端不能另造实体 message ID | Web 只有临时 `pending:` key | 明确它不是实体；receipt 后统一服务端 ID |
| ohbaby-web G1：UI 不是事实源 | pending 是短期 UI state | 用固定优先级自动让服务端事实接管 |
| UI F2：正式 message 后 TUI 离开 EmptyState | 当前成立但较晚 | 本批不改 TUI；后续若需提速消费 starting projection |

## 1.11 承重问题清单（须在 02 逐条回应）

| ID | 问题 |
|----|------|
| P1 | Web 首帧反馈等待 HTTP/selectSession/正式 message，用户感知为空白 |
| P2 | prompt/UI/core 用户消息 ID 未端到端统一 |
| P3 | pending 在 queued 时被过早清理，idle 首条反馈消失 |
| P4 | `isEmpty/showMain` 不把 eligible local attempt 当对话内容 |
| P5 | Send 无 admission spinner，且草稿清理时机过晚 |
| P6 | `prompt.updated(starting)` 已存在但未承担 server provisional projection |
| P7 | `starting → queued` busy 回退若配合提前 adapter 正式投影，会产生补偿与跨客户端闪烁；core 另有 claim 前短暂可见的存量窗口 |
| P8 | 用户气泡对账与 Thinking 共用寿命，存在二次空窗 |
| P9 | 已受理但正式 message 前失败，缺少对话内保留文本与错误呈现 |
| P10 | 现有测试固化 queued/message 的理想化顺序，缺少乱序与真实 serve 验收 |
