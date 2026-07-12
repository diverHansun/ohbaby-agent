# 4. 测试与验收标准

> 本文定义发布门，不是实施进度表。开发前所有条目默认未完成；只有测试或可复现的真实进程证据通过后才能勾选。

## 4.1 测试原则

1. 必须穿透真实 `UiBackendClient → scheduler → PromptExecutor → RunLedger/Lifecycle`，不能只给 fake submit 加延迟后声称“支持 10 并发”。
2. 时间不是主要断言。使用 deferred fake LLM、barrier 和可观察调用计数，避免 `sleep(100)` 型脆弱测试。
3. 并发不变量在 store/scheduler 层断言；Web 只验证投影和交互，不复制调度逻辑。
4. queued persistence 必须杀死并重启真实 daemon 进程验证，不能只重建一个 JS 对象。
5. provider error 使用可控 fake provider；测试结构化字段和脱敏，不依赖真实厂商限额。
6. 保留现有 colocated Vitest unit/contract/integration 习惯；真实 Web 验收使用隔离 HOME、临时数据库、随机端口和 Playwright。

## 4.2 单元测试

### 4.2.1 Store 与 migration

建议落点：`packages/ohbaby-agent/src/runtime/prompt-scheduler/*.unit.test.ts` 与 database migration tests。

- 新库依次应用 014 基础表与 Phase E0 additive migration；真实 014 fixture 升级后 backfill `clientRequestId=legacy:<promptId>`，旧 session/message/run/submission 保留，lease 列为空且唯一索引可创建。不得回改 014。
- accept 生成稳定 `promptId/userMessageId`，相同 ID 不可重复插入。
- `queued → starting → running → terminal` 合法；所有禁止状态转移被拒绝。
- `claim` 是条件更新：两个并发 caller 只有一个成功。
- `finish(expectedRunId)` 拒绝错误 runId；late completion 不覆盖 cancelled/interrupted。
- 100 个 queued 可接受；第 101 个原子拒绝，记录数仍为 100。
- 相同 `(scopeKey, clientRequestId)` + 相同语义输入重试只保留一条 record 并返回同一 `promptId/userMessageId`；同 ID 不同 text/session/options 返回 `IDEMPOTENCY_CONFLICT`；幂等命中不受当前 queue-full 影响。
- edit lease acquire 只允许 queued 且现有 lease 为空/过期；返回 owner/token/expiresAt。第二 client 不能抢占；lease token 不进入 snapshot/event。
- renew/commit/release 都要求正确 `promptId + leaseId` 且未过期；token 是 authority，刷新后有效 token 可在续租时重绑当前 client，只有 ownerClientId 而无 token 仍失败；commit 修改 text、清 lease、不改 `createdAt`；release 清 lease、不改 text；错误 token/过期返回 `PROMPT_EDIT_LEASE_LOST`。
- queued cancel 写 terminal cancelled、清 lease并立即释放 waiting cap；无 lease 时不能取消他人未过期 lease，owner 可携 token 在 queued-edit 模式取消。不存在 `restoreCancelled` 或 terminal→queued 转移。
- terminal records 不计入 waiting cap；starting/running 占 active，不计 waiting。
- terminal records 重启后仍可查询，且 prompt text 不出现在 daemon state、registry 或错误日志中。
- `error_data` 坏 JSON/旧 string error 安全回退 `UNKNOWN`。
- `scopeKey`、session FK、时间与排序键在重启读取后保持一致。

### 4.2.2 Scheduler

- 同 workspace 前 10 个不同 session 同时进入 executor；第 11 个保持 queued。
- 任一 active 终态 settle 后，第 11 个才 claim；观测到的最大 active 始终 `<= 10`。
- 同 session A/B/C 严格 FIFO，任意时刻只执行一个。
- A1、A2、B1 的到达顺序下，A1 active 时 B1 可以获得空槽，A2 不会阻塞 B lane。
- permission/question wait 与 provider retry/backoff 期间不释放 slot。
- provider/auth/API error 直接失败，不进入 `SESSION_BUSY` 重试。
- 来自另一 runtime 的 `SessionRunBusyError` 只退避该 lane；其他 session 继续 drain。
- double-Esc cancel 当前 A 后，必须等待 RunLedger、stream、sandbox settle，随后 B 才开始。
- scheduler 先为每个 session 选唯一 lane head，再检查 edit lease；B 是 leased head 时同 session C 不得 claim，其他 session D 可正常运行。
- lease 不占 active slot；release/commit 后立即 drain。若仅剩 leased heads，scheduler 为最早 expiresAt 安排 wake-up；60 秒不活动超时后原 head 可 claim。
- 最近有编辑活动时 renew 会重排 expiry wake-up；客户端 60 秒无输入后停止 heartbeat，daemon 重启后仍按持久化绝对 expiresAt 判断，不永久卡 lane。
- drain 多次触发幂等；异常和同步 throw 都会正确 release slot/lane。
- shutdown 不丢 durable queued；in-memory adapter 按其明确策略结束等待项。

### 4.2.3 Runtime 与错误

- active state 以 sessionId/runId 索引，两个 session 的 abort/permission/status 不串。
- selected session 的兼容 `UiSnapshot.status` 不被其他 session run 覆盖。
- `normalizeRunError` / `normalizeLifecycleRunError` 覆盖认证、provider API、retry exhausted、stream interrupted、context overflow、output length、abort 与 unknown；queue full/workspace unavailable 由 scheduler/recovery 产生结构化 detail；`SESSION_BUSY` 只作 scheduler 内部退避，不成为面向客户端的 terminal error。
- provider response/body/header/API key/cause 不进入 wire DTO；只保留 allowlist 字段。
- RunLedger 同时保存兼容 message 与结构化 error detail。

### 4.2.4 SDK、reducer 与 CLI

- `submitPromptAccepted` 返回 receipt，类型导出完整；兼容 `submitPrompt` 仍等待 terminal。
- receipt/submission 导出 `clientRequestId`；`acquirePromptEditLease/renewPromptEditLease/releasePromptEditLease` 与 lease DTO 类型完整；edit/cancel 的 lease 条件完整，无 restore 类型。
- receipt 先于 SSE、SSE 先于 receipt、重复 snapshot 三种顺序都只产生一个投影。
- request/receipt/event/snapshot 原样保留 `clientRequestId`；只有当前页面 submit Promise 收到的 matching receipt 可清空 live draft。即使 `clientRequestId` 匹配，`prompt.submitted` SSE、snapshot 初始化和 replay 也只能关联 attempt/更新投影，不得直接清空 composer。
- 只有 queued submission 进入 Queue selector；不再 queued 后以 `userMessageId` 进入/合并 conversation，正式 user message 到达时不重复显示。
- admission failure 保持 composer 文本；accepted 后 failure/interruption 只在目标 conversation message 显示结果，不留在 Queue 区。
- 非交互 CLI `submit → waitForPrompt`，成功/失败/取消映射正确退出码。
- interactive TUI queue 数与内联队列列表来自 snapshot/submission，不来自本地 Promise 数。

## 4.3 后端集成测试

使用真实 workspace backend、临时 SQLite 和 deferred fake LLM：

1. **10+1 多 session**：创建 11 个 session 并提交；确认前 10 个 provider 调用已进入 barrier，第 11 个 provider 尚未调用但 receipt/status 为 queued；释放一个后第 11 个开始。
2. **同 session context 隔离**：A 运行时提交 B；检查 A 的实际模型请求中没有 B 文本；A settle 后 B 的 context 才包含正式 A/B 历史。
3. **即时接受**：provider 在 barrier 前不返回 token，`submitPromptAccepted` 仍立即给 receipt，snapshot 已含 queued/starting submission。
4. **permission 占槽**：一个 session 等 permission 时，其他 session 可运行，但该 slot 不被第 11 个复用。
5. **provider retry**：retry/backoff 期间 slot 保持；最终错误绑定原 prompt，其他 session 不受污染。
6. **cancel 与续排**：A active、B/C queued；cancel A 后 B 再 C，且无 A/B 同时 claim。
7. **workspace 隔离**：workspace X 的 10 槽/100 cap 不占用 workspace Y；两个 scope 的 snapshot/event 不串。
8. **多 client 真相一致**：Web/JSON-RPC client 同时观察同一 workspace，receipt、队列位置与终态一致；客户端断开不删除 queued。
9. **TUI/serve 边界**：默认 TUI 仍不 import `ohbaby-server`；与 serve 同写同 session 时最终由 DB run claim 阻止双 active，不伪称跨 runtime FIFO。

## 4.4 真实 daemon 重启测试

建议新增 process integration，流程必须使用全新隔离 HOME：

1. 启动正式 foreground daemon 与可阻塞 fake provider。
2. 制造至少一个 running、两个 queued submission，并记录 promptId/userMessageId。
3. 强制终止 daemon，不能走只清内存的测试 helper。
4. 重新启动同 packageVersion daemon、读取原 SQLite。
5. 断言死 owner 的旧 running/starting 变为 interrupted，provider 没有自动再次收到它；存活 owner 记录不被误恢复。
6. 断言 queued 保持原顺序并自动继续，ID 不变。
7. queued 所属 workspace 无法 realpath/load 时标记 `WORKSPACE_UNAVAILABLE`，没有 cwd/query fallback。
8. 正常 `serve stop` 再启动同样不删除尚未开始的 durable queued。

## 4.5 HTTP、JSON-RPC 与错误集成

- `POST /v1/prompts` 要求 `clientRequestId`，返回 202 + 含同一 ID 的完整 receipt，不等待 run terminal；相同 request 重试不重复 publish/execute。
- JSON-RPC `submitPromptAccepted` 返回同构 receipt；remote client 可按 promptId 等待终态；旧 `submitPrompt` 仍 submit-and-wait。
- HTTP PATCH/DELETE 与 JSON-RPC edit/cancel 只作用 queued；edit 必须持有未过期 lease，cancel 不能绕过他人 lease。
- `/v1/prompts/:id/edit-lease` POST/PATCH/DELETE 分别 acquire/renew/release；owner、token、expiry 条件错误返回结构化 lease error。
- JSON-RPC 同构 `acquirePromptEditLease/renewPromptEditLease/releasePromptEditLease`；不存在 restore method。
- 第 101 个 waiting 返回结构化 scheduler `QUEUE_FULL`；HTTP 可用 429，但 `source=scheduler`，与 provider 429 明确区分。
- accepted 后 provider 429/retry exhausted 通过 `prompt.updated` 返回 `source=provider`，而不是全局 SSE error。
- 认证错误、context overflow、stream interrupted 均保持 code/retryable/status allowlist。
- 同 clientId 在不同 workspace/session 的 prompt、permission、replay seq 与 error 不串。
- 缺失或非法 `x-ohbaby-directory` 继续 400 fail-closed。
- 新旧 CLI/daemon packageVersion 不一致仍拒绝复用且不自动 kill。

## 4.6 Web/TUI 单元与组件测试（Phase E）

### 4.6.1 Web

- Enter/点击 Send 后，matching receipt 返回即清空该 live draft 并显示 user prompt，不等待 provider 首 token；SSE 本身不执行清空。
- 当前 session busy 时，后续文本出现在 composer 上方 Queue 区，且 UI 只标注 queued。
- queued → 非 queued → 正式 message 的转换无跳闪、无重复；starting/running/succeeded 不增加额外用户字段。
- queue full/admission failure 时输入文本不会静默丢失。
- 切 session/项目再切回，submission 状态来自 snapshot；刷新后仍可恢复。
- 其他 session 的运行不会把当前 session 标成 running，也不会禁用当前 composer。
- accepted 后失败/中断只显示在目标 conversation message；queued cancel 直接从 Queue 区消失；连接级错误才进入全局提示。
- receipt/SSE 重复和乱序 reducer 以 `promptId/userMessageId` 幂等；`clientRequestId` 只关联 attempt。仅当前页面 submit Promise 的 matching receipt 清 live draft；本 client 或其他 client 的 SSE、snapshot、replay 都不直接修改 composer。
- 现有项目 rail、展开会话栏、最后 session 恢复与 model label 不回归。
- Queue 区附着在 composer 上方，比 composer 更窄，视觉层级更轻。
- **Queue 区高度自适应**：1-5 条全部可见，每条单行高度；超过 5 条时折叠为前 5 条 + "Queued N · Show all" 展开按钮；展开后显示全部，conversation 区域相应缩小。不使用固定高度 + 隐藏滚动条。
- **编辑用"弹回 composer"模式**：点击 queued 卡片 → acquire lease 成功后保存旧 draft 并载入文本 → 有编辑活动时最多每 20 秒合并续租、60 秒无输入后停止续租 → Queue 卡片显示 editing → Enter commit 并释放 → Esc release 并恢复旧 draft。第二 client 只读；lease lost 保留编辑文本并可 send-as-new。同 tab 刷新从 sessionStorage 恢复 token/edit buffer 并 renew/rebind；过期时不丢 editText。
- **cancel 即时生效，无确认对话框**。取消控件 hover 显现，有可访问名称。
- cancel 后没有 Undo/restore；可有无操作的状态提示，但不得出现可恢复入口。
- selector `view.composer.canSend = connectionState === "live"`；组件本地再判断 non-empty/`!isSubmitting`。客户端不以 `queueCount < 100` 禁发；server `QUEUE_FULL` 保留草稿。running 时 Send 仍可用，Stop 与 Send 共存。
- 未发送草稿按 scope/session 本地持久化并刷新恢复；刷新后的 snapshot/replay 不自动清除。若持久化 pending attempt 已被接受，只显示 Clear/Keep 提示。

### 4.6.2 TUI

- 删除本地 Promise queued 计数后，snapshot/event 恢复相同队列内容。
- **composer 上方内联显示队列**：只在有 queued 时显示，自适应高度，每条一行带 `↳` 前缀，`dim().italic()` 样式。无 `/queue` slash 命令，无独立管理面板。
- 普通 `↑/↓` 始终保持 history 行为；`Alt+Up` 获取最后一条 queued prompt 的 lease 并进入 queued-edit 模式。
- queued-edit 模式内 `Ctrl+D` 取消当前 lease 对应 prompt；Enter 保存，Esc 释放 lease、保留服务端原文并恢复旧 draft。普通 composer 不拦截字符 `d` 或 `Ctrl+D`。
- `Alt+Up`、模式内 `Ctrl+D` 与 Shift+Tab、Tab、双击 Esc、Ctrl+C、slash completion、permission dialog 无冲突；至少覆盖 Ink 键盘 contract、macOS Terminal 与 tmux smoke。
- 默认 TUI 仍 in-process；remote TUI/CLI 消费同构 receipt/error；非交互命令等待 terminal 后再退出。

## 4.7 当前后端真实 daemon process E2E

- 使用隔离 HOME、临时 SQLite、随机端口和可控 fake LLM 启动正式 foreground daemon。
- 通过真实 HTTP/JSON-RPC 创建 11 个 session；前 10 个进入 provider barrier，第 11 个 receipt 为 queued，最大 provider 并发精确为 10。
- 对 queued 执行 edit/cancel，重启 daemon 验证修改后的正文、取消终态与剩余 FIFO 持久化。
- 杀死并重启 daemon：running 只变 interrupted，不 replay；queued 保持 ID/顺序并继续。
- 第 101 个 waiting 原子拒绝，provider 429 与 scheduler queue-full 的 source/code 不同。

## 4.8 下一批真实进程 + Playwright E2E

### 4.8.1 环境

- 使用临时 `HOME`、临时 workspace/SQLite、随机 daemon 端口。
- 启动 production build Web 与正式 foreground server，不用组件 mock 替代端到端路径。
- fake provider 提供 barrier、可释放 token、可注入 401/429/stream error，并记录并发调用数和请求内容。
- 每个 case 清理进程、pid/state、浏览器 context；不得读取开发者真实数据库。

### 4.8.2 核心场景

1. 打开 11 个 session，各发送一个阻塞 prompt；前 10 个为 starting/running，第 11 个立即显示 queued；fake provider 最大并发为 10。
2. 释放一个 provider barrier，第 11 个自动转 running；页面无需刷新。
3. 同 session 发送 A，再发送 B/C；B/C 立即显示在 composer 上方且顺序稳定。
4. 对 A 双击 Esc；A 的 conversation 显示简短中断/取消结果而不进入 Queue 区，settle 后 B 自动开始，C 仍 queued。
5. 在 queued 状态刷新页面、切项目再切回；文本、ID、状态与顺序不丢。
6. 注入 provider 错误；错误只落在目标 prompt，其他 session 继续流式输出。
7. 第 101 个 waiting 被明确拒绝且 composer 文本可恢复；页面不生成假的 queued 卡片。
8. **弹回 composer + lease**：点击 queued 卡片 → acquire 成功后文本进入 composer → Queue 区显示 editing → 第二 browser 不能抢占 → renew 后仍不可 claim → 同 tab 刷新可恢复 lease/edit buffer → 编辑提交后文本更新且保持原队列位置。
9. **严格 FIFO + lease expiry**：A running、B leased、C queued；A settle 后 C 不得越过 B，其他 session D 可运行；释放 B 后 B 再 C。另测 client 崩溃后 60 秒不活动 expiry 自动唤醒 B。
10. **即时 cancel**：取消 queued prompt 后卡片消失、状态 terminal cancelled；无确认、无 Undo/restore；误操作只能重新发送。
11. **提交幂等与草稿隔离**：同 `clientRequestId` 重试只出现一个 prompt；matching SSE 也不直接清当前草稿；刷新后草稿恢复，event/snapshot/replay 均不自动清除，可用原 ID Retry 或手动 Clear/Keep。
12. **自适应折叠**：排队 6 条 queued prompt → Queue 区显示前 5 条 + "Queued 6 · Show all" → 点击展开 → 全部 6 条可见。
13. 浏览器 console 无 uncaught error/warning；网络面板无无限轮询、续租风暴或重复提交。

视觉只验证 Queue 区层级、自适应高度、折叠/展开、弹回 composer、editing/lease-lost 提示、即时 cancel 的可发现性、可读性、状态转换和窄宽度不遮挡 composer；不得自动轮播，本批不借机重做三栏导航视觉。

## 4.9 回归测试

至少覆盖：

- 全局单 daemon 的用户级 pid/state、第二次 serve 复用、版本门禁、legacy 检测和 foreground 无 idle-exit。
- workspace fail-closed、InstanceStore 隔离、SSE generation/replay、connections/serve ps。
- OpenCode 风格项目导入/隐藏/恢复、项目 rail、会话栏收展、每项目最后 session。
- permission/question、slash command、goal、interrupt、session restore、model/provider 展示。
- 默认 TUI in-process contract、CLI noninteractive run、remote JSON-RPC client。
- database migration 从真实旧 fixture 升级，不能只测空库。

## 4.10 建议命令

实施时按实际新增文件补齐路径，至少执行：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/runtime/prompt-scheduler
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess
pnpm exec vitest run packages/ohbaby-server/src
pnpm exec vitest run packages/ohbaby-cli/src
pnpm exec vitest run apps/ohbaby-web/src
pnpm typecheck
pnpm lint
pnpm build
```

当前批次的真实 process integration 与下一批 Playwright 分别使用仓库脚本入口；若当前没有统一入口，对应实施批次必须把可重复命令记录在测试文件头注或 package script，不能只留下手工口述。

## 4.11 后端批次发布门

- [x] 只有一个 backend scheduler/store queue owner；旧 daemon queue 与 backend 全局 queue 不再双重排队。
- [x] 同一全局 serve `WorkspaceInstance` 最多 10 个 distinct active session，观测与实测一致。
- [x] 第 11 个立即 accepted + queued；waiting 达 100 后第 101 个原子拒绝。
- [x] 同 session FIFO，queued prompt 不进入当前 run 的模型 context。
- [x] queued daemon restart 恢复；starting/running interrupted 且不自动 replay。
- [x] double-Esc 只取消当前 run，settle 后后续 FIFO 自动继续。
- [x] provider/runtime/scheduler error 结构化、prompt-scoped、脱敏；HTTP/JSON-RPC 语义一致。
- [x] HTTP/JSON-RPC accepted receipt 一致；兼容 submit-and-wait 与非交互 CLI 不提前退出。
- [x] prompt receipt/event/snapshot 后端投影幂等，无重复 ID 或状态串 session。
- [x] 默认 TUI 仍 in-process，不加载 server；TUI+serve 同 session 仍有 DB claim 防线。
- [x] 全局单 daemon、项目导航、permission/goal/model 等既有回归全绿。
- [x] 真实 daemon process integration 核心场景有可重复证据。
- [x] queued edit/cancel 的 store、HTTP、JSON-RPC、race 与重启恢复均有自动化证据。
- [x] 已完成后端批次当时没有修改 Web UI；该历史边界在后续 Phase E 中已解除。
- [x] 后端批次文档、实现、测试路径与 `v0.1.8` 发布目标同步更新。

### 4.11.1 后端验收证据（2026-07-12）

- `global-single-serve.integration.test.ts`：7 个真实 OS 子进程场景，覆盖 10+1、crash recovery、edit/cancel + restart、100 queued 原子上限、provider 429 区分、workspace unavailable。
- scheduler 对抗性用例覆盖 completion lost-wakeup、unknown prompt、`SESSION_BUSY` 退避与无热循环。
- `ui-persistent.integration.test.ts` 新增三条直接证据：fake provider 捕获 queued B 不进入 A context；1 个 permission wait + 9 个 provider wait 占满 10 槽且第 11 queued；abort signal 已到但 provider 未 settle 前后续同 session prompt 仍 queued。
- lifecycle/error-detail 测试覆盖 provider `finishReason=length` 生成 `OUTPUT_LENGTH`；取消原因可稳定规范化为 `ABORTED`，但正常用户取消仍以 `cancelled` 状态呈现。
- server 已物理删除 `coordination/prompt-queue.ts` 及公共导出；legacy 注入 backend 的集成测试改为证明 server 不再建立第二 queue owner，正式 durable backend 仍由真实进程 10+1 场景验证 FIFO/admission。
- store/persistent backend 覆盖 live owner 不误恢复；全局单 daemon 阻止第二个真实 serve owner 同时启动，因此该项不重复构造不符合产品拓扑的“双 daemon live owner”进程场景。
- 独立子代理两轮复审：首轮 7 个 P1 全部修复；复审补出的同 session 历史 error 复活问题亦已修复，最终结论 `no blocking findings`。
- 全量 `pnpm test`：256 个测试文件通过、3 个 smoke 文件跳过；2117 tests 通过、11 tests 跳过（删除 legacy queue 测试文件，同时新增 context/permission/settle/output-length 对抗用例后的净结果）。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过；Web UI 工作区无修改。

## 4.12 Phase E Web/TUI 发布门

- [x] Enter/Send 后无需等待模型首 token 即可看到用户 prompt。
- [x] request/receipt/SSE/snapshot 的 `clientRequestId` 幂等贯穿；仅当前页面 matching receipt 清 live draft，SSE/snapshot/replay 不直接改 composer；无重复消息或状态串 session，刷新后草稿恢复。
- [x] running 时仍可输入和 Send；Stop 与 Send 分离；`canSend` 不依赖 `!isRunning`。
- [x] Queue 只显示 queued；自适应高度 + 5 条折叠/展开；弹回 composer + edit lease/renew/lost UX；cancel 即时、无确认、无 undo；可访问名称完成。
- [x] failed/interrupted 只落入目标 conversation，queued cancel 直接消失，无失败/中断历史队列。
- [x] TUI 内联队列 + `Alt+Up` queued-edit + 模式内 `Ctrl+D` 取消与服务端 truth 接线完成；普通 history/字符输入、无 `/queue`、非交互退出语义不回归。
- [x] edit lease owner/token/renew/60 秒不活动 expiry 完整；leased head 阻塞同 session 后续 prompt、其他 session 并行；不存在 restore API。
- [x] 真实 daemon 自动化与浏览器现场验收共同覆盖核心场景；浏览器测试不伪装成仓库内 Playwright CI。

### 4.12.1 Phase E 验收证据（2026-07-12）

- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 与 `git diff --check` 全部通过；真实 provider smoke 仍按既有策略显式跳过，未伪装为自动化通过。
- scheduler/store 自动化覆盖：同 request ID 重试不重复 publish、显式 session 冲突、空/`legacy:` ID 拒绝、lease held/wrong-token/expired、lane-head 不可跨越、其他 session 并行以及 expiry timer 自动唤醒。
- migration 从真实 014 fixture 升级：旧 submission backfill `legacy:<promptId>`，lease 列为空，partial unique index 建立；迁移后模拟旧二进制连续写两条空 client ID 仍可前滚恢复。
- HTTP 与 JSON-RPC 均覆盖 receipt、acquire/renew/release/commit/cancel；真实 OS 子进程 daemon 测试断言 request→receipt→snapshot 的 `clientRequestId` 原样贯穿，同一 ID 重试返回同一 prompt 且不重复入队。
- 真实 OS 子进程并发 admission：同一 active prompt 阻塞 lane 后，同时发出 101 个 HTTP accept，精确得到 100 个 `202` 与 1 个 scheduler `QUEUE_FULL`，并直接断言 DB 仍只有 100 条 queued。
- 真实 OS 子进程 graceful stop：active + queued 同 session 下发送 `SIGTERM`，进程退出后 DB 保留 queued；重启时 active 转为 interrupted，queued 自动继续并 succeeded。
- Web unit 覆盖 matching receipt、首 session receipt 选择、SSE reducer、5 条折叠、pending attempt 在 queued-edit 往返后保留、lease-lost edit buffer 二次刷新保留、第二 lease acquire 被阻止。
- TUI Ink contract 覆盖内联队列、真实 Alt+Up escape sequence、模式内 Ctrl+D、重复按键异步锁以及 Backspace 等非打印编辑活动的 lease renew；普通 history、slash、permission 与退出回归仍全绿。
- 现场从构建产物先启动 CLI/TUI，再启动 production Web daemon；浏览器可视 E2E 验证首 submit 自动选择 receipt session、running 中连续排入 6 条、默认显示 5 条并 Show all、Stop/Send 并存、弹回 composer 编辑保存、即时取消、刷新后 draft 保留、无 console warning/error，测试数据随后清理并停止进程。
- 三个独立只读审查分别覆盖 core scheduler/lease、Web/TUI 状态竞态、SDK/HTTP/JSON-RPC/migration/文档；首轮有效 findings 已修复并再次复核。

### 4.12.2 最终浏览器现场验收清单

仓库未引入 `@playwright/test` 与浏览器 CI。本轮最终 E2E 由已构建的 production Web daemon 提供现场入口，验收者按以下用户可见行为检查：

1. 在 session A 发送长任务；首 token 前用户 prompt 已可见，composer 只在 matching receipt 返回后清空。
2. A running 时连续发送 6 条；看到 `Queued 6`，默认 5 条，`Show all` 后 6 条均可见。
3. 将 queued prompt 弹回 composer 编辑并提交；原队列位置保持，编辑期间同 session 后续项不越过执行。
4. 即时取消一条 queued prompt；无确认、无 toast，被取消项从 queue 消失。
5. A running 时切到 session B；B 的 Send 可用且能独立运行，A 不被隐式停止。
6. composer 内输入未发送文字后刷新；文字仍保留，SSE/snapshot 不清草稿。
7. running 时 Send 与 Stop 同时可用；停止当前 run 后，同 session FIFO 仅在旧 run settle 后推进。
8. 检查浏览器 console：不得出现本功能引入的 warning/error。

## 4.13 对抗性验收

| 质疑 | 必须给出的证据 |
|------|----------------|
| "只是把外层 queue 改成 10，内部仍全局串行" | 真实 lifecycle 同时停在 10 个 deferred provider 调用，且 runtime active map 有 10 个不同 session |
| "用户消息立即显示只是 localStorage 乐观 UI" | 第二个浏览器/刷新后的 snapshot 在 provider 首 token 前看到同一 promptId |
| "持久化了，但重启会重复执行工具" | running 变 interrupted，fake provider/tool 调用计数不增加；仅 queued 自动继续 |
| "第 101 个竞态下仍可能插入" | 并发 accept 压测后 DB queued 精确为 100，所有拒绝均为 scheduler queue-full |
| "queued B 泄漏进 A 的 context" | fake provider 捕获 A 的完整 request，明确不含 B 文本 |
| "取消一按就启动下一条，旧 run 仍在收尾" | barrier 证明 B 的 provider 调用晚于 A 的 RunLedger/stream/sandbox settle |
| "provider 429 和本地 queue full 混在一起" | wire DTO 的 source/code 不同，UI 文案和 retryable 语义分别断言 |
| "切到别的 session 仍被全局 running 禁用" | Playwright 在 A streaming 时切 B，B 可发送并独立显示状态 |
| "Queue 超过 5 条后用户看不到后续内容" | Playwright 排队 6 条 → 看到 "Queued 6 · Show all" → 点击展开 → 全部 6 条可见且可操作；不依赖滚动条发现隐藏内容 |
| "编辑时 scheduler 抢走了 prompt" | acquire/renew/claim 使用同一 lease 条件；未过期 token 下 claim 失败；lease lost 时 client 保留文本并可 send-as-new |
| "锁定 B 后 C 越过执行，破坏 FIFO" | scheduler 先选 per-session head 再检查 lease；A/B/C+D 场景证明 B leased 时 C 不 claim、D 可运行 |
| "cancelled 被 restore 后同一 prompt 完成两次" | 本批无 Undo/restore，terminal 状态单向；误操作创建新 prompt ID |
| "edit lease 泄漏导致 prompt 永远不被执行" | 20 秒 renew + 60 秒不活动 expiry + earliest-expiry wake timer；测试 client 崩溃/daemon 重启后 prompt 正常执行 |
| "TUI 仍在猜 queued 数量" | 重建 TUI store 后队列内容与 promptId 来自 snapshot，代码与测试不依赖 pending Promise 计数 |
| "TUI 仍需要 /queue 命令才能操作队列" | composer 上方内联显示；`Alt+Up` 进入 queued-edit，模式内 `Ctrl+D` 取消；无 slash 命令或独立面板 |
| "submitted SSE 清掉 composer 草稿" | `clientRequestId` 只用于关联 attempt；无论本 client/其他 client，SSE/snapshot/replay 都只更新投影，不改 composer；仅当前页面 matching receipt 清 live draft |

只有上述发布门全部关闭，才能把"多 session 延迟"和"发送后长时间无视觉反馈"认定为解决，而不是仅改善了表面 loading。
