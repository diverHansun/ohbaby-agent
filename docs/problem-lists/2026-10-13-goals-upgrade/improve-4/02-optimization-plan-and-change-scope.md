# 2. 优化方案与改动面

> 本文是 improve-4 的执行契约（预期实现，尚未实施）。行为基线是 [plan/02](../plan/02-optimization-plan-and-change-scope.md) §2.5 与批 2 的共享门禁契约；本批只补自动分流、顺序判定、结果分型与未消费恢复，不重建门禁。
> 批 2 / 批 3 是实施前置：现行代码无门禁时普通输入会继续打断 goal，不存在"未接线降级为只排队"的形态；本批不承诺先于前置批次发布。接口细节已按批 2 修稿对齐（挂点 `{ runId, goalId }` 不带 generation；会话恢复列表刷新复用 `SessionView.rebuild(sessionId)` 与既有会话事件、不新增 notice）。

## 2.1 方案总览

```text
用户 accept（已进入 session owner 提交回调，一次进入；批 2 门禁不动）
  1. 容量与幂等：getByClientRequestId（先于容量检查）/ assertCapacity（已有）
  2. 持久接受：store.accept(status=queued)（已有）
  3. 分流判定（本批新增，仍是同一个回调内的一段短写；只用接受记录自身的 session/scope 身份）：
       有更早同 session queued 项 → 不尝试（earlier-queued）
       只读挂点解析目标为空 → 不尝试（no-goal-run）
       否则调 CurrentRunInputStore.steerQueued（已有机制，事务复核 active + 未封口）
            ├─ 成功：prompt queued→steered、写 receipt 与输入消息、唤醒 run
            ├─ 预期竞争：保持 queued（target-unavailable / target-sealed）
            └─ 真错：保持已接受事实，结果 error（不吞、不伪装 steered）
  4. 成功后完成 scheduler 的 prompt.updated / onSteered / completion waiter；回调返回并释放 → requestDrain（已有；steered 项不再是 queued 候选）

未消费投影：
  current_run_input（closedAt / firstAttempt / processed）+ 重发子项
    → 会话级列表 UiSession.unconsumedSteers（含原文与状态）
    → CLI/Web：横幅 + 转录标记（按 messageId 关联）+ Resend（新 prompt，resendOfPromptId 关联）
```

## 2.2 设计决策表

| # | 决策 | 选择 | 理由 | 拒绝的选项 | 代价 |
| --- | --- | --- | --- | --- | --- |
| D1 | 自动 steer 位置 | `WorkspacePromptScheduler.accept` 已进入的 owner 回调内、`store.accept` 之后、释放前 | 与 claim 同处一个 session 串行区，分流与 claim / 其他 accept 天然互斥；区内一次进入 | 公共 accept 返回后再分流；区内调公共 steer（重入串行区死锁）；新锁 | accept 返回值扩一个 `steer` 字段（唯一生产调用点是 ui-inprocess） |
| D2 | 目标解析 | 批 2 同步挂点 `getActiveGoalRunForSteer(sessionId) => { runId, goalId } \| undefined`：在 accept 同一 owner 边界内核对 active、当前 goalId、有效 executionEpoch 和未封口 run；随后 `steerQueued` 事务复核 run 接收状态 | 停止或替换后仍在收尾的旧 run 不再接收自动 steer；steer 共享原票据 | 新建 session→run 表、新锁或异步目标解析 | 依赖批 2 的生命周期资格检查 |
| D3 | 顺序判定 | 同 scope 同 session 存在更早 queued 项则不尝试；比较键 `(accepted_at, admission_order)` | 两个 store 已保证按 scope 单调，`listQueued` 已按此排序 | 新增 sequence 列 / 通用队列；用 prompt_id 或 UUID 排序 | 分流前一次 `listQueued` 查询（区内，成本低） |
| D4 | steer 结果分型 | `steered` / `not-steered{reason}`（原项保留排队）/ `existing`（同 id 复用记录真实状态）/ `error`（真错）；预期竞争不抛错，真错不吞 | 调用方要区分"保留等待"与"失败"（S2/S3） | 全部抛 `CurrentRunInputConflictError` | 手动 steer 的 SDK 返回值同批改类型并沿传输链更新 |
| D5 | 幂等键 | 自动 steer 用接受请求自身的 `clientRequestId`；重试复用旧 receipt / 决定 | 同一 id 一个决定；accept 重试在 `inserted=false` 短路，不二次 steer | 每次尝试生成新 UUID | receipt 与 prompt 共用同一 id，需注释说明 |
| D6 | 未消费载体 | 会话级列表 `UiSession.unconsumedSteers`（inputId、promptId、messageId、text、state）；转录标记按 messageId 关联派生；删除 `UiRun.unsentSteer` 与 `hasUnsentSteerAfterLatestStop` | 不能从当前可见消息推断全量（分页 / 压缩 / 重连会吞老记录）；一个事实一个载体 | 只用 `UiMessage` 字段当恢复索引；在 `UiRun` 上堆并行数组 | 协议删除项，三端同批 |
| D7 | 重发 | 新 prompt（新 promptId / 新 userMessageId）；`clientRequestId = "resend:" + operationId`；子记录 `resendOfPromptId`（下一可用迁移，非唯一）。允许显式多次重发，每次一个新 operationId；同 operationId 重试返回同一 receipt | 复用 accept 幂等与受保护 accept 路径（重发项还能被自动 steer）；不重放旧身份；不做未批准的单次限制 | 复用 `resubmitRetainedPrompt`（会重放同一 userMessageId）；"每输入至多一个子项"硬限制 | 迁移加一条可空列 |
| D8 | 提示规则 | 条目被本地标记确认处理（`processedRequestId` = 本地请求成功落盘，**不代表模型已理解**），或存在"仍在执行路径（queued / starting / running，或 steered 且接收 run 尚未关闭）或已有本地成功处理标记"的重发子项时不计入提示；子项 cancelled / failed 且未被消费时原项提示恢复；历史原文保留 | 现状"后继 Stop 覆盖"会丢事实；不做"已读"账本；恢复路径不闭合不许退回"用户手输" | dismiss 标记、完成历史界面 | 不重发、也没有有效子项时会一直看到历史标记（按 plan 接受） |
| D9 | 容量 | 沿用 `maxQueuedPrompts` / `assertCapacity`，先于分流；steer 成功把项转出队列，不占容量 | 保留现有队列容量限制 | 为 steer 单独扩容 / 绕过容量 | 无 |
| D10 | 大 protected input | 不新增字段：失败后 run 进入 failed / interrupted，输入按既有 closure 投影为未消费 / 未确认，UI 显示失败事实 + 提供重发 | 用已有事实表达"未处理"；失败可恢复 | 自动分片 / 转存文件 / 压缩吞输入 | 只保证可见与可恢复，不保证自动成功 |

## 2.3 核心接口契约

### (a) current-run-inputs（store 层）

```ts
// 结果分型：预期竞争不再抛错（真错仍抛 CurrentRunInputConflictError 或底层错误）
export type SteerQueuedPromptOutcome =
  | { status: "steered"; receipt: SteerQueuedPromptReceipt;
      prompt: PromptSubmissionRecord; message: MessageWithParts }
  | { status: "not-steered";
      reason: "target-unavailable" | "target-sealed" | "prompt-not-queued";
      prompt: PromptSubmissionRecord };

steerQueued(input: SteerQueuedPromptInput): Promise<SteerQueuedPromptOutcome>;

// 未确认输入候选查询（替代布尔版 hasUnsentSteer，删除旧方法）
listUnconsumedSteers(sessionId: string): Promise<readonly CurrentRunInputRecord[]>;
// 候选 = source "user-steer" 且 processedRequestId 缺省；包含 pending，供投影层过滤。
// 从该会话持久输入记录读取，不依赖已加载的聊天页；store 不依赖 runtime。
// adapter 组合 closedAt 与所属 run 的 terminal 事实，只有已关闭项进入恢复列表。
// state：firstAttemptRequestId 缺省 → "unconsumed"，否则 → "unconfirmed"。
```

### (b) prompt-scheduler（scheduler 层）

```ts
export interface WorkspacePromptSchedulerOptions {
  // …既有字段不变
  /**
   * 目标解析：由适配器投影自批 2 的 getActiveGoalRunForSteer（返回 { runId, goalId }，
   * 同步内存读，不带 generation）；scheduler 只取 runId，goalId 不进入本层。
   * 返回 undefined = 不尝试 steer。
   */
  readonly resolveSteerTarget?: (sessionId: string) => { runId: string } | undefined;
}

/** scheduler 层本地定义，不反向依赖 SDK 的 UiPromptError；adapter 负责映射。 */
export interface AcceptedSteerError {
  readonly code: string; readonly message: string; readonly retryable: boolean;
}
export type AcceptedSteerOutcome =
  | { status: "steered"; receipt: SteerQueuedPromptReceipt }
  | { status: "not-steered"; reason: SteerSkipReason } // 记录保持 queued，原项等待执行权
  | { status: "existing"; promptId: string }           // 同 clientRequestId 已有记录：不重做决定
  | { status: "error"; error: AcceptedSteerError };
export type SteerSkipReason =
  | "no-goal-run"         // 目标解析为空
  | "earlier-queued"      // 同 session 有更早 queued 项，不越队
  | "target-unavailable"  // 目标在 steer 前已关闭 / 不再 running
  | "target-sealed";      // 目标已进入末步封口

async accept(input): Promise<{ record: PromptSubmissionRecord; steer: AcceptedSteerOutcome }>;
```

行为约束（写进实现）：

- 幂等先于容量：`getByClientRequestId` 命中即复用，重复去重发生在容量检查之前；队列满时用原 id 重试仍可查到原记录。
- `existing` 分支不重做决定、不伪报 queued：以记录真实 `status` 与 `steerReceipt` 为准（可能是 queued / steered / starting / running / retained / terminal）。`status === "steered"` 且有 receipt → `steered` + 原 receipt；其余 → `existing`。
- 崩溃恢复：accept 落盘后、steer 前崩溃，恢复与重试保持原记录 queued、不追溯自动 steer；status = queued 即保守决定，不要求复刻当时的 skip reason，但对外事实必须清楚（记录真实状态 + 本次 `existing`）。
- 真错不静默重试：`error` 分支保留已接受事实（可查询）；重试同 id 返回记录真实状态，不自动再试 steer。
- 身份一致：steer 用接受记录自身的 sessionId / contextScopeId 作为目标 scope，与自动 claim 链一致。
- 批内顺序：同一请求内的多次 accept 依次经串行区持久化，`accepted_at` / `admission_order` 单调保证批内与跨请求顺序；不得并行 accept 后依赖排序。
- 只在 `store.accept` 返回 `inserted === true` 时尝试分流；steer 成功后 `record` 取 steered 后的记录。
- 区内只调 `this.options.currentRunInputs.steerQueued(...)` 这类 store 级方法；禁止调 `this.steerQueued(...)` 等会重入 `commit(sessionId)` 的公共方法。
- 自动与手动成功 steer 共用一段不再次进入 owner 的 scheduler 后续处理：拿到已提交的 steered record 后，发布最终 `prompt.updated`（`notify/onUpdated`）、沿用 `onSteered`、调用 `resolveCompletion` 结算已注册的等待者。裸 store 只提交 receipt / 消息并唤醒 run，不能代替这些步骤。queued 的 submitted 可先发，但最终必须发 steered 更新，CLI/Web 不能永久保留 queued 投影；投影回调错误不回滚 receipt、不伪报分流失败，也不阻断 waiter 结算。
- 同 id 的并发重试可能在 accept 已落盘、steer 尚未提交时读到 queued，并注册 completion waiter；允许它读取当时真实状态，但必须随后由成功 steer 结算，不能永远等待，更不能再次分流。完成后的重试只读原 receipt。
- `requestDrain()` 保持现状，在退出 owner 后触发；steered 记录不是 queued 候选，不会顺带启动新 run；成功 steer 的唤醒沿用 store 现有机制，会话恢复列表刷新复用 `SessionView.rebuild(sessionId)` 与既有会话事件，不为 steer 新增 notice；不占批 2 门禁租约、不新建 run、不增轮。

### (c) SDK / 协议层

```ts
// 会话级未消费列表（最小会话视图字段；完整返回待恢复项，不静默截断）
export interface UiUnconsumedSteer {
  readonly inputId: string; readonly promptId: string; readonly messageId: string;
  readonly text: string;                        // 取自原消息（durable，历史原文不删除）
  readonly state: "unconsumed" | "unconfirmed";
}
// UiSession 增加：unconsumedSteers?: readonly UiUnconsumedSteer[]
// UiRun：删除 unsentSteer；sdk/run-inputs.ts：删除 hasUnsentSteerAfterLatestStop，
// 改为基于会话列表的 helper（不再从当前可见 messages 推断全量）。

// 手动 steer：结果分型（原 UiSteerQueuedPromptReceipt 保留为 steered 分支的 receipt）
export type UiSteerQueuedPromptResult =
  | { status: "steered"; receipt: UiSteerQueuedPromptReceipt }
  | { status: "not-steered"; reason: "target-unavailable" | "target-sealed" | "prompt-not-queued" };

// 重发（新命令）；允许显式多次重发，每次一个新 operationId；同 operationId 重试返回同一 receipt
export interface UiResendSteerInput { readonly inputId: string; readonly operationId: string }
resendSteerInput(input: UiResendSteerInput): Promise<UiPromptReceipt>;

// UiPromptReceipt 增加 steer?: AcceptedSteerOutcome（adapter 把本地 error 映射为 UiPromptError）
// 适配器投影按 D8 规则压制 / 恢复条目；transcript 标记由 messageId 关联派生，不新增第二载体。
```

同批更新手动 steer 与重发命令的整条链路：host `host/ui-command-gateway.ts`、SDK `client.ts` / `command-record.ts`、server JSON-RPC（`protocols/jsonrpc/protocol.ts`、`rpc-route.ts`、`coordination/prompt-backend.ts`）、Web daemon `api/daemon/http.ts` / `client.ts`、CLI `tui/components/prompt/index.tsx`。SDK 定义自己的结果类型，由 adapter 映射，不导入 scheduler 内部类型。

恢复列表由 adapter 组合输入候选、run 关闭事实和重发关系。普通重发项依据既有请求成功事实判断是否处理；steered 重发项依据 `processedRequestId`。子项仍待执行时暂时隐藏原项提示；子项关闭且未确认处理时恢复原项或提供该子项的恢复入口，不因父子关联失去操作入口。原文按持久 messageId 查询，不依赖聊天分页；本批不加无分页出口的隐藏上限。关闭 / 失败 / 中断、`confirmRequestSuccess`、重发接受及子项状态变化后，在原 owner 条目退出后触发 `SessionView.rebuild(sessionId)`，走既有会话发布路径，禁止在区内等待重新入队的 rebuild。snapshot 与重连使用同一投影。客户端沿既有 session reducer 保存该字段；若现有变更检测只比较旧字段，需把恢复列表纳入比较，避免后端已更新但事件未发。

重启先复用既有恢复：`ui-persistent.ts` 的 `startupReady`、`createSessionExecutionRecovery`（`runtime/execution-recovery/session.ts`）及 scheduler 的 `recoverSession`。恢复会对 stale 输入调用 `inputs.close`；adapter 在区外等待相应恢复成功后再发布列表。恢复失败应展示失败并保留可重试入口，不能把失败当成空列表。store 只提供持久输入事实，不导入 runtime，也不凭“当前进程没有该 run”判定关闭。

## 2.4 数据所有权与不变量

| 事实 | 拥有者 | 写入方 | 读方 |
| --- | --- | --- | --- |
| 接受顺序与分流决定 | `prompt_submission`（status / steer_receipt） | accept 串行区 | drain、CLI/Web 列表 |
| 输入投递事实 | `current_run_input` | steerQueued / admitRequestAttempt / confirmRequestSuccess / close | 消息投影、未消费查询 |
| 封口与关闭 | `run_ledger`（steer_closed_at / inputs_closed_at） | sealSteer / close | steer 事务复核、投影 |
| 原文与展示 | `message` | accept / steer 写入、run 注入 | 转录、重发读取 |
| 重发关联 | `prompt_submission.resend_of_prompt_id`（可空、非唯一） | 重发 accept | 消息投影的清除规则 |
| 会话级未消费列表 | 无独立存储：由 `current_run_input` + `prompt_submission` 读侧派生 | —（投影） | CLI/Web 会话视图 |

不变量：① 同 session 至多一个执行者（批 2，本批不改）；② 一次成功 steer 不新建 run、不增 goal 轮、不加 blocked 审计轮；③ 同一 `clientRequestId` 只对应一个分流决定与 receipt；④ steered 记录与其消息不被重放或复用身份，重发始终新建 prompt / 消息；⑤ 未确认处理的输入不因后续 run 或重启从投影消失；⑥ 会话列表可从持久事实重建，不依赖"当前已加载的消息"（分页 / 压缩 / 重连不影响）。

## 2.5 分阶段实施

| Stage | 内容 | DoD |
| --- | --- | --- |
| 1. store 与判定 | `current-run-inputs.ts` 结果分型 + `listUnconsumedSteers`（删布尔版）；`scheduler.ts` accept 加 `resolveSteerTarget` 与分流判定 | 覆盖顺序、分型及手动/自动共用成功通知与 waiter 结算；`resolveSteerTarget` 缺省时不尝试分流 |
| 2. 接线与传输 | `ui-inprocess.ts` 接批 2 挂点、accept 结果映射进 `UiPromptReceipt`、手动 steer 结果适配；host / SDK / server JSON-RPC / Web daemon 传输同批 | 集成测试：steered / 预期竞争 / 真错三条路径 |
| 3. 未消费投影与重发 | 迁移（下一可用编号，当前建议 024：`resend_of_prompt_id` 可空列）+ accept 透传；SDK 会话列表类型 / 重发命令 / helper；适配器投影与 `resendSteerInput` | contract：投影字段、命令幂等、结果类型 |
| 4. CLI/Web 与回归 | 消息标记、横幅、Resend 入口；删除旧 helper 用法 | CLI contract + Web unit 测试；手工冒烟 |

## 2.6 改动面

| 包/目录 | 新增 | 修改 | 删除 |
| --- | --- | --- | --- |
| `packages/ohbaby-agent/src/runtime/prompt-scheduler/` | 结果 / reason 类型、`listUnconsumedSteers` | `current-run-inputs.ts`、`scheduler.ts`、`in-memory-store.ts`、`database-store.ts` | `hasUnsentSteer` |
| `packages/ohbaby-agent/src/adapters/` | `resendSteerInput`、投影字段 | `ui-inprocess.ts`、`ui-persistent.ts`、`ui-state/persistent-store.ts`（消息投影 + 未消费列表） | `projectRunRecord` 的 user-stop 分支、`UiRun.unsentSteer` 投影 |
| `packages/ohbaby-agent/src/host/` | — | `ui-command-gateway.ts`（结果类型透传） | — |
| `packages/ohbaby-agent/src/services/database/` | 迁移（建议 024） | `schema.ts`、`migrations.ts` | — |
| `packages/ohbaby-sdk/src/` | 结果 / 命令类型、会话列表 helper | `prompt.ts`、`snapshot.ts`、`client.ts`、`command-record.ts`、`index.ts` | `UiRun.unsentSteer`、`hasUnsentSteerAfterLatestStop` |
| `packages/ohbaby-server/src/` | — | `protocols/jsonrpc/protocol.ts`、`rpc-route.ts`、`coordination/prompt-backend.ts`（结果类型透传） | — |
| `packages/ohbaby-cli/src/tui/`、`apps/ohbaby-web/src/` | 重发入口与标记 | `app.tsx`、`prompt/index.tsx`、`Composer.tsx`、`SessionScreen.tsx`、`api/daemon/http.ts`、`client.ts` | latest-stop 用法 |
| `docs/goals/`、`docs/tools/todo-list/` | — | `dfd-interface.md` 插话链路、`use-case.md` 的 steer / 普通 run 区分随实现同步 | — |

## 2.7 迁移、兼容与回滚

- 迁移编号取**下一可用**（当前建议 024，前批合并后可能顺移）；只加可空列：旧库读取忽略，新写入旧版本忽略该列（回滚安全）；无需历史回填，投影按需计算。验证口径 = 应用迁移后旧库数据可读（不是在未迁移库上裸查新列）。
- 协议删除（`unsentSteer` / helper）必须三端同批：monorepo 中 CLI/Web/server/SDK 同版本发布，不承诺旧客户端兼容。
- 读兼容：`closedAt` 缺失但所属 run 已 terminal 时，由 adapter 按已关闭投影，不为此另写修复记录。重启遗留的 running 记录先交给既有 execution recovery 归一，再重建列表；恢复未完成不冒称列表已完整。
- 回滚：整批 revert；迁移列可留。若只回滚 agent 侧、不回滚 SDK 删除项会丢提示，契约测试应拦住这种半回滚。

## 2.8 风险

| 风险 | 缓解 |
| --- | --- |
| accept 内死锁（误调公共方法重入串行区） | 区内只调 store 级方法；集成测试卡住 claim / steer 顺序验证 |
| 误 steer 越队 | 固定比较键 `(accepted_at, admission_order)`；同毫秒两连发用例 |
| 双重消费 | 重发每次都新建 prompt（新 promptId / 新 userMessageId），`operationId` 幂等去重；不重放旧身份 |
| 投影把 pending 当未消费 / 漏跨 run | pending 不标记；会话级列表按持久事实重建，跨 run、重启可读；非 user-stop 与重启用例 |
| 提示压制出错（子项取消 / 失败后原项提示不恢复，或有效子项在跑时原项仍提示） | D8 规则：仅"仍在执行路径或已处理"的子项压制；cancelled / failed 且原项未被消费时恢复；S4-12 覆盖 |
| 重启遗留 running 被误认为仍可执行 | adapter 等待既有 execution recovery 成功后重建列表；失败可见，不让 store 反向依赖 runtime |

## 2.9 不在本批

批 1 watchdog、批 2 门禁本体、批 3 blocked 审计与恢复、批 5 displayText 与数字 UI；通用消息确认平台、完成历史界面、dismiss 账本、多目标队列、fork。
