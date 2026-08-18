# 2. 优化方案与改动面

> 本文是后续独立实施会话的执行契约。规划会话不写业务代码。

---

## 2.1 方案总览

采用 OpenCode 已验证的核心模式，但适配 ohbaby“服务端分配 `userMessageId`、prompt 有独立 Queue”的事实：只新增最小 local attempt overlay；服务端已有 submission 和 message 依次接管。不得实现新的通用状态机。

```text
展示权威性（高 → 低）

formal UiMessage(userMessageId)
        ↓ 缺位时
UiPromptSubmission(status=starting, userMessageId)
        ↓ 缺位时
LocalPromptAttempt(clientRequestId, temporary key)
```

```text
时间线（空闲首条）

Enter
  ├─ 同帧：clear draft + local user row + startup Thinking
  ├─ HTTP pending：Send admission spinner
  ├─ 202：记录 userMessageId；spinner 停，Thinking 不停
  ├─ prompt starting：server projection 接管 local row
  ├─ prompt running：run Thinking 可先接管，server user row 继续占位
  └─ formal message：UiMessage 接管 provisional row

busy 分支

prompt starting → SessionRunBusyError → prompt queued
  └─ provisional row / startup Thinking 退出；现有 Queue 显示该 prompt
```

`prompt running` 与 formal `message.appended` 的先后不能被 UI 假定；当前 adapter 会先调用 `onRunStarted`，再发布正式用户消息。展示规则必须同时支持 running-before-message 和 message-before-running。

实现原则：状态只存事实，展示阶段由纯规则派生。不要存 `phase: "local" | "starting" | "formal"`，不要用多个 effect 手工搬运同一条消息。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 三阶段 | 展示接管优先级，不是显式状态机 | 现有 local/submission/message 已是三种事实；少一套同步状态 | 新 reducer / 通用 optimistic framework | 需把派生规则集中并测全乱序 |
| server provisional | 复用 `UiPromptSubmission(status=starting)` | 在 runtime/MCP 前已到达，且含 text + ID | 新 SSE；提前正式 message | terminal/busy 需有明确投影规则 |
| 正式 message 时机 | 保持 `runtime.startSession` 成功后的现有 UI publish | 避免在最终 run-ledger claim 前制造错误的 authoritative UI 投影与 busy 补偿 | execute 开头 publish；拆 RunManager claim/start | TUI 本批不会提前看到气泡；core claim 前短暂写入仍是存量风险 |
| Receipt | 不改形状 | 已含关联所需 ID；admission 不应变成消息事实源 | receipt 带完整 `UiMessage` | receipt 前仍需临时 key |
| admission / navigation | receipt resolve 即 accepted；`selectSession` 独立执行和报错 | 避免已受理 prompt 被导航失败错误回滚、重复发送 | 两者共用一个 try/catch/Promise（现状） | 需要区分 submit error 与 selection error |
| ID | receipt 前 `pending:${clientRequestId}`；之后 UI/core 都用服务端 `userMessageId` | OpenCode 的稳定身份原则；避免文本猜测和双行 | 永久 pending id；UI/core 各自生成 | 需打通 agent 参数链和 message factory |
| local attempts | 仅维护按 `clientRequestId` 键控的最小集合；每项只存本地提交事实和 receipt 关联 | 当前产品支持 follow-up queue，单个 pending 可被第二次发送覆盖；OpenCode 也以 key 管理 overlay | 通用实体 store；继续单个 pending | 比单值多一个小集合，但有现实并发需求支撑 |
| conversation eligibility | 提交时若 session 无 active/starting 且没有更早的 eligible local attempt，才进入 optimistic conversation；其余等待 Queue | session 同时只能有一个当前 turn | 所有发送都插 conversation | 需记录本次 placement，不随稍后状态反复猜测 |
| queued | queued 本身不产生 conversation row；eligible local 首条可在短 queued 窗口继续占位 | 保持排队权威语义，同时不让首条闪退 | queued 全进 conversation；queued 一律清 local | local 占位必须在 busy requeue 时退出 |
| busy | `starting → queued` 纯派生回 Queue，不做消息删除补偿 | 此时尚无正式 UI message | 先正式写再 remove | provisional 会主动从 conversation 消失，这是正确反馈 |
| terminal-before-message | failed/interrupted submission 保留一条 submission-derived user row + inline error；cancelled 依产品现有语义退出或标记取消 | 已受理动作不能像没发生；无需伪造 core message | 强行补正式 message；只 toast | 该行是失败投影，不是模型上下文消息 |
| 清草稿 | Enter 同帧清；HTTP 未受理且当前 draft 仍空才恢复 | OpenCode/DeepSeek 的立即 commit 与安全 rollback | 等 Promise（现状）；无条件恢复 | 需用 attempt text 做条件恢复 |
| Send spinner | 仅 HTTP in-flight；约 1 秒一圈，reduced-motion 静态 | spinner 表示“受理中”，Thinking 表示“agent 启动/运行中” | 转到首 token；无 spinner | 两个 loading 信号需文案/样式区分 |
| Thinking | 独立派生：eligible local 或 starting 或 running | message 接管不应制造第二个空窗 | 跟 pending 一起销毁 | 需要防 local/server/run 三个 indicator 重叠 |
| Stop | 仅 live/running run | startup 阶段无可取消 run handle | local/startup 即显示 Stop | 启动中只能看状态，不能 Stop |
| TUI | 本批不改功能 | Web 是明确用户痛点；不为顺带收益扩大核心生命周期 | 在 TUI 复制 overlay | TUI 等正式 message 的存量体验保留 |

**可逆性**：Web overlay、CSS 和 core 可选 ID 都是内部、可逆改动；HTTP/SSE/DB schema 不变。唯一需要谨慎的是消息 ID 语义：同一用户 prompt 从 admission 到 core 持久化应保持同一 ID，因此必须用单元/契约测试锁定。

### 2.2.1 01 问题闭环

| 01 问题 | 02 回应 |
|---------|---------|
| P1 / P4 | Phase B 同帧 commit 与 local attempt 驱动主布局 |
| P2 | Phase A core ID 贯穿 + Phase B receipt 后 ID 接管 |
| P3 | Phase B 固定 placement、初次 queued 与 busy requeue 分流 |
| P5 | Phase B Composer 立即 clear、admission spinner、条件恢复 |
| P6 | Phase B 复用 starting/running submission projection |
| P7 | 不提前 formal message；Phase A 锁 busy 清理，Phase B 纯派生回 Queue |
| P8 | Phase B 独立 Thinking selector，支持 running/message 乱序 |
| P9 | Phase B terminal-before-formal projection + inline error |
| P10 | Phase A/B 自动化 + Phase C 独立 serve E2E |

## 2.3 分阶段实施

### Phase A — 稳定 `userMessageId` 贯穿 UI 与 core

**目标**：服务端 receipt、submission、formal UI message、core user message 指向同一个 `userMessageId`；不改变正式 UI publish 时机。

**预计改动文件**：

| 文件 | 动作 |
|------|------|
| `packages/ohbaby-agent/src/core/message/types.ts` | 为内部 `CreateMessageInput` 增加可选预分配 `id`，或提供等价的窄入口 |
| `packages/ohbaby-agent/src/core/message/factory.ts` | 有 `input.data.id` 时使用它，否则维持现有 generator；不改变 assistant/system 默认行为 |
| `packages/ohbaby-agent/src/core/agents/types.ts` | 在 `AgentTurnInput` / `AgentRunInput` 增加可选 `initialUserMessageId`（最终命名保持单一） |
| `packages/ohbaby-agent/src/core/agents/instance.ts` | 将 turn input 的 ID 传给 runner |
| `packages/ohbaby-agent/src/core/agents/runner.ts` | `writeInitialUserMessage` 创建 core user message 时传入预分配 ID |
| `packages/ohbaby-agent/src/agents/types.ts`、`agents/service.ts` | `StartSessionParams` 到 instance turn 透传该 ID |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | `runtime.startSession` 传入已有 `reservedUserMessageId`；保持成功后才发布正式 UI message |
| 相关 `*.unit.test.ts` / `*.contract.test.ts` | ID 统一、默认 ID 生成、busy remove/retry 与无提前 UI append |

**行为契约**：

1. 普通用户-owned prompt 有 `reservedUserMessageId` 时，core `Message.id` 必须等于它。
2. subagent、goal 或未提供预分配 ID 的路径继续由 message generator 生成，不强迫伪 ID。
3. `runCoordinator.create` busy 失败时，现有 runner 删除刚写入的 core user message；scheduler 将 prompt requeue。重试可再次使用同一预分配 ID。
4. 不在 `getRuntimeForPrompt` / `runtime.startSession` 前发布正式 UI `message.appended`。
5. 不因可选 ID 放宽 store 唯一性；重复 insert 仍应失败或由现有幂等边界阻止。

**DoD（Phase A）**：

- message factory：给定 ID 使用给定值；未给定时行为不变。
- runner/service/adapter 契约：同一 prompt 的 receipt/submission/UI/core ID 一致。
- busy：最终 requeue，core 临时消息已删除，UI 无正式 `message.appended`。
- 现有 subagent/goal/ordinary runner 测试不回归。

### Phase B — Web 最小 optimistic overlay 与展示接管

**目标**：Enter 后下一帧已有稳定反馈；local、starting、formal、running 之间无双行、无空窗；running follow-up 仍只进入 Queue。

**预计改动文件**：

| 文件 | 动作 |
|------|------|
| `apps/ohbaby-web/src/ui/App.tsx` | local attempts、提交/失败恢复、纯派生 projection、布局切换、Thinking 接管、button admission 状态 |
| `apps/ohbaby-web/src/ui/selectors.ts` 或 App 内局部 pure helper | 只在能明显降低 App 复杂度时提取展示优先级；不要建立通用 optimistic 模块 |
| `apps/ohbaby-web/src/ui/styles.css` | admission spinner、startup/failed projection 的必要样式与 reduced-motion |
| `apps/ohbaby-web/src/ui/App.unit.test.tsx` | 覆盖 §04 的阶段、乱序、busy、failure 与 queue 场景 |

**最小 local attempt 事实**：

```ts
interface LocalPromptAttempt {
  readonly clientRequestId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly placement: "conversation" | "queue";
  readonly submittedSessionId?: string;
  readonly userMessageId?: string;
}
```

字段可按现有类型风格微调，但不得加入 `phase`、复制 prompt status 或缓存整条 `UiMessage`。按 `clientRequestId` 更新/删除，不能用“最后一个 pending”猜测。

**展示派生契约**：

展示候选必须从服务端和本地两条独立来源收集，不能以 local attempt 为遍历入口，否则 reload 后无法重建 starting/failed projection。

1. **服务端候选**：遍历当前 session 的 submissions；若同 `userMessageId` 已有 formal message，则不再生成 provisional row。否则：
   - `starting` / `running`：独立生成 server provisional user row；不要求本浏览器有 local attempt；
   - `failed` / `interrupted`：独立生成 user row + inline error，并可在 reload 后由 snapshot 持续重建；
   - `queued`：只进入现有 Queue，不独立生成 conversation row；
   - `succeeded`：没有 formal message 时视为数据一致性异常，不凭空伪造成功 user row；
   - `cancelled`：按现有取消呈现清理或标记，不伪造成成功 message。
2. **本地候选**：仅处理 `placement="conversation"` 且尚无 matching formal/server provisional 的 attempts：
   - 尚无 matching submission 时显示 local optimistic row；
   - matching submission 仍是初次 `queued`、session 当前没有其它 active run 且 attempt 从未观察过 starting 时，可继续短暂占位；
   - 当前已有其它 active run，或该 attempt 由 starting 回退 queued，则退出 conversation，Queue 接管。
3. 合并后以 `userMessageId`（receipt 后）或 `clientRequestId`（receipt 前）去重，优先级始终是 `formal > server provisional > local`。
4. formal message 出现时，临时 row 在同一个 render 中不再渲染；不得先 append 再靠 effect 延迟删除造成双帧双行。
5. failed/interrupted server projection 是持久化 prompt 事实的 UI 呈现，不是 core/model conversation message。

为区分“初次 queued”与“busy requeue”，先看 session 是否已有其它 active run，再利用本地 attempt 是否观察过 `starting` 的窄事实。若需要记录，只记录 `sawStarting: boolean` 这一现实对账事实，不引入完整 phase machine；若 SSE 恰好漏过 starting，snapshot 中的 active run 仍优先把该 prompt 放回 Queue。

**Composer 契约**：

1. 完成 IME / 空文本等现有校验后，生成 `clientRequestId`。
2. 同一 React 批次：记录 local attempt、清 draft、设置 HTTP `isSubmitting`。
3. 后台调用 `submitPromptAccepted`；首 session 的 `selectSession` 不阻塞上述首帧。
4. **receipt 是 admission linearization point**：receipt resolve 后立即更新 matching attempt 的 `sessionId/userMessageId`、停止 Send spinner，并让 Composer 的 submit Promise resolve。
5. receipt 后的 `selectSession(receipt.sessionId)` 是独立导航动作，可 fire-and-report；它 pending 时不得延长 admission spinner，它失败时只报告导航/selection 错误，不得删除 accepted attempt、恢复旧草稿或诱导重复提交。
6. receipt 前 HTTP reject：移除该 attempt；只有当前 draft 仍空时恢复本次文本；已有新输入则保留新输入。

**local attempt retire 契约**：

| 事实 | local attempt 处理 | 后续展示来源 |
|------|--------------------|--------------|
| receipt 前 HTTP reject | 立即删除 | 无；按条件恢复 draft |
| queue placement 且 matching queued submission 可见 | 删除 | Queue |
| conversation placement，matching starting/running 可见 | 可删除 local payload | server provisional；若实现保留关联壳，必须有下面同等 terminal 清理 |
| formal 可见，且 matching submission 或 live run projection 已可见 | 删除 | formal user row + submission/run Thinking |
| failed/interrupted/cancelled | 删除 | terminal server projection 或取消呈现 |
| succeeded terminal | 删除 | formal message；全部 startup Thinking 停止 |
| busy requeue | 删除 conversation attempt 或将其退役为 queue-only | Queue |

formal 若极端乱序地先于任何 submission/run 事实到达，可短暂保留 attempt 只用于 Thinking 兜底；user row 仍由 formal 优先渲染。一旦 server activity 或 terminal 事实到达必须 retire，避免集合和 Thinking 常驻。

**Thinking 契约**：

```text
showRunThinking = 有 live run projection

showStartupThinking = 没有 showRunThinking
  且（有尚未被 matching terminal/busy 事实排除的 eligible local attempt
      或 matching submission.status 为 starting/running）

render one card = showRunThinking 或 showStartupThinking
```

- formal message 到达不直接关闭 Thinking。
- run running 后只保留现有 run Thinking，计时切换不得渲染两个 card；不要求 formal message 已先到。
- starting 回 queued、任一 terminal、receipt 前 HTTP reject 后若没有 live run，则关闭 startup Thinking。
- startup 阶段不显示 Stop。

**DoD（Phase B）**：

- receipt Promise 未 resolve 时，draft 已空、主对话布局已显示 user row + Thinking，Send 正在 admission spinner。
- receipt 后使用服务端 ID，Send 停转，Thinking 仍连续。
- receipt 后 `selectSession` pending/reject 均不延长 spinner、不回滚 accepted attempt。
- starting、run running、formal message 无论何种可接受顺序接管，始终一条用户行、一个 Thinking card。
- busy requeue 只回 Queue，无正式 message、无残留 startup Thinking。
- reload 无 local state 时，starting/running/failed/interrupted submission 仍可独立重建 projection。
- succeeded/failed/interrupted/cancelled 后 local attempt 均 retire，不残留 startup Thinking。
- active run 的 follow-up 不插 conversation optimistic row。
- HTTP failure 安全恢复，accepted terminal failure 有内联错误。

### Phase C — 验证、真实 serve E2E 与文档同步

**目标**：用自动化和真实浏览器证明感知延迟已消失，同时守住 queue/run ownership。

**动作**：

- 完成 04 的 unit / contract / integration 场景。
- 实施进程使用独立端口、独立测试 workspace 启动 `ohbaby serve`，浏览器完成首条发送、接管连续性和 follow-up Queue 检查；busy requeue 由可控 contract/integration 覆盖。完成后停止自己启动的进程。
- 运行 typecheck 与相关回归测试。
- 若实现改变 UI 用例文档语义，仅同步 [`docs/ohbaby-web/use-case.md`](../../../ohbaby-web/use-case.md) / test 文档中的对应条目；不要改写 2026-07-12 的 queued 权威语义。

**DoD（Phase C）**：04 发布门全部满足；E2E 有可复核的步骤/截图或测试记录；无悬挂 serve 进程。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `packages/ohbaby-agent/src/core/message/` | | ✓ | | 内部可选预分配 ID |
| `packages/ohbaby-agent/src/core/agents/` | | ✓ | | ID 透传到 initial user message |
| `packages/ohbaby-agent/src/agents/` | | ✓ | | StartSession/turn 窄参数透传 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | | ✓ | | 传 ID；**不前移**正式 UI publish |
| `packages/ohbaby-agent/src/runtime/prompt-scheduler/` | | 测试为主 | | 锁 busy requeue，不改状态模型 |
| `apps/ohbaby-web/src/ui/` | | ✓ | | local overlay、projection、Thinking、spinner |
| `packages/ohbaby-sdk` | | | 不改 | receipt/submission/event schema 足够 |
| `packages/ohbaby-server` | | | 不改 | 202 与 SSE transport 不变 |
| `packages/ohbaby-cli` | | 仅回归 | | 本批无功能变化 |

## 2.5 API / 协议 / 迁移与兼容

- **HTTP / JSON-RPC / SSE**：无字段、状态枚举或事件类型变化。
- **DB schema**：无 migration；prompt submission 已持久化 `user_message_id`。
- **内部 API**：agent start/turn/run 与 `CreateMessageInput` 增加可选 initial user ID。可选保证旧调用方兼容。
- **行为兼容**：旧 Web 仍按正式 message 显示，只是继续有现状延迟；新 Web 可消费旧后端已有 starting submission，但只有 ID 统一后的后端才能获得完整跨层身份保证。
- **重放**：reload 后不重建 local optimistic；snapshot 中 starting/running/failed/interrupted submission 或 formal message 独立决定展示。local overlay 只服务当前浏览器的 Enter→server fact 窗口。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| optimistic 与 formal 双行 | 同一 render pass 做权威优先级，不靠延迟 effect 清理；按 ID 测试 | 关闭 local/provisional projection，恢复晚显示 |
| receipt/SSE 乱序 | 关联同时支持 `clientRequestId` 与服务端 `userMessageId`，测试 message-before-receipt | 回退到 clientRequestId overlay，不改协议 |
| 第二次发送覆盖第一次 pending | keyed local attempts；placement 固定 | 临时限制未分类 attempt 时连发 |
| starting busy 回 queued 后残留气泡 | 记录是否观察过 starting；requeue 后只显示 Queue | 禁用 server provisional，保留 local 首帧 |
| core 预分配 ID 碰撞 | store 唯一性 + factory/runner 契约测；不 silent upsert | 移除 core optional ID，UI 体验仍可保留 |
| Thinking 双卡或闪断 | 单一派生 selector；独立测试 formal-before-running | 回退 startup 计时展示，保留 user row |
| accepted failure 误当正式 message | 明确标记 provisional/failed，不写 core context | 退化为全局错误 + 保留 local 文本 |
| CSS 动画不适 | 约 1 秒一圈、`prefers-reduced-motion` | 静态 Sending 图标/文字 |

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 三阶段是展示接管链 | §2.1、Phase B 派生契约 |
| 借鉴 OpenCode | local keyed overlay、同帧 commit、稳定 ID、失败 rollback |
| ID 统一 | Phase A + Phase B receipt 接管 |
| 不提前正式 message | §2.2、Phase A 契约 4 |
| busy 回退 | §2.1、Phase B 派生契约、§2.6 |
| Thinking 独立寿命 | Phase B Thinking 契约 |
| queued 不进对话 | §2.2 eligibility/queued |
| 不改 receipt / SSE | §2.5 |
| TUI 不改功能 | §2.2、§2.4 |
| 真实 serve E2E | Phase C、04 |

## 2.8 不在本批

- execute 开头正式 `message.appended`
- RunManager claim/start 拆分、预 claim token、补偿事务
- receipt 完整 `UiMessage`
- queued 正式进入 conversation 或模型上下文
- TUI optimistic / starting projection
- serve 启动预热 MCP
- 新事件、新状态枚举、通用 optimistic framework
- Jump to latest、虚拟列表、全屏 loading 或动效系统
