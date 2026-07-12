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

- 新库 migration 创建 `prompt_submission` 与索引；旧库升级保留既有 session/message/run 数据。
- accept 生成稳定 `promptId/userMessageId`，相同 ID 不可重复插入。
- `queued → starting → running → terminal` 合法；所有禁止状态转移被拒绝。
- `claim` 是条件更新：两个并发 caller 只有一个成功。
- `finish(expectedRunId)` 拒绝错误 runId；late completion 不覆盖 cancelled/interrupted。
- 100 个 queued 可接受；第 101 个原子拒绝，记录数仍为 100。
- queued edit 保持 FIFO 排序；queued cancel 写 cancelled 并立即释放 waiting cap。
- edit/cancel 与 claim 竞态只有一个条件更新成功，starting/running 永不被改回 queued。
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
- receipt 先于 SSE、SSE 先于 receipt、重复 snapshot 三种顺序都只产生一个投影。
- 只有 queued submission 进入 Queue selector；不再 queued 后以 `userMessageId` 进入/合并 conversation，正式 user message 到达时不重复显示。
- admission failure 保持 composer 文本；accepted 后 failure/interruption 只在目标 conversation message 显示结果，不留在 Queue 区。
- 非交互 CLI `submit → waitForPrompt`，成功/失败/取消映射正确退出码。
- interactive TUI queue 数与 `/queue` 列表来自 snapshot/submission，不来自本地 Promise 数。

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

- `POST /v1/prompts` 返回 202 + 完整 receipt，不等待 run terminal。
- JSON-RPC `submitPromptAccepted` 返回同构 receipt；remote client 可按 promptId 等待终态；旧 `submitPrompt` 仍 submit-and-wait。
- HTTP PATCH/DELETE 与 JSON-RPC edit/cancel 只作用 queued；version/claim race 返回结构化冲突。
- 第 101 个 waiting 返回结构化 scheduler `QUEUE_FULL`；HTTP 可用 429，但 `source=scheduler`，与 provider 429 明确区分。
- accepted 后 provider 429/retry exhausted 通过 `prompt.updated` 返回 `source=provider`，而不是全局 SSE error。
- 认证错误、context overflow、stream interrupted 均保持 code/retryable/status allowlist。
- 同 clientId 在不同 workspace/session 的 prompt、permission、replay seq 与 error 不串。
- 缺失或非法 `x-ohbaby-directory` 继续 400 fail-closed。
- 新旧 CLI/daemon packageVersion 不一致仍拒绝复用且不自动 kill。

## 4.6 Web/TUI 单元与组件测试（Phase E）

### 4.6.1 Web

- Enter/点击 Send 后，在 provider 首 token 前立即清空 composer并显示 user prompt。
- 当前 session busy 时，后续文本出现在 composer 上方 Queue 区，且 UI 只标注 queued。
- queued → 非 queued → 正式 message 的转换无跳闪、无重复；starting/running/succeeded 不增加额外用户字段。
- queue full/admission failure 时输入文本不会静默丢失。
- 切 session/项目再切回，submission 状态来自 snapshot；刷新后仍可恢复。
- 其他 session 的运行不会把当前 session 标成 running，也不会禁用当前 composer。
- accepted 后失败/中断只显示在目标 conversation message；queued cancel 直接从 Queue 区消失；连接级错误才进入全局提示。
- receipt/SSE 重复和乱序 reducer 幂等。
- 现有项目 rail、展开会话栏、最后 session 恢复与 model label 不回归。
- Queue 小框比 composer 更窄并附着在其上方；pencil inline edit、trash 取消，图标有可访问名称与 mutation 禁用态。
- Queue viewport 最多约两条卡片可见；第 3 条起可通过滚轮、触控板、键盘/拖动细滚动条到达，`Queued N` 正确，滚动条 hover/scroll 增强，不发生自动轮播或焦点跳动。

### 4.6.2 TUI

- 删除本地 Promise queued 计数后，snapshot/event 恢复相同 `queued N`。
- `/queue` 只列当前 session queued，方向键选择、`e` 编辑、`d` 取消、Esc 返回；操作携带 `expectedUpdatedAt`。
- edit/cancel 与 claim 冲突时刷新并显示结构化错误，不把 starting/running 改回 queued。
- Shift+Tab、Tab、双击 Esc、Ctrl+C、slash completion、permission dialog 等现有键位不回归。
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
8. 浏览器 console 无 uncaught error/warning；网络面板无无限轮询或重复提交。

视觉只验证 Queue 区层级、两条可见高度、手动滚动可发现性、可读性、状态转换和窄宽度不遮挡 composer；不得自动轮播，本批不借机重做三栏导航视觉。

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
- [x] 本批没有修改 Web UI；前端 Playwright 项保持下一批未关闭。
- [x] 文档、实现、测试路径与 `v0.1.8` 发布目标同步更新。

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

- [ ] Enter/Send 后无需等待模型首 token即可看到用户 prompt。
- [ ] Web receipt/SSE/snapshot 幂等，无重复消息、状态串 session 或刷新丢失。
- [ ] running 时仍可输入和 Send；Stop 与 Send 分离。
- [ ] Queue 只显示 queued；两条可见高度、手动纵向滚动、`Queued N`、pencil inline edit、trash cancel、冲突刷新与可访问名称完成。
- [ ] failed/interrupted 只落入目标 conversation，queued cancel 直接消失，无失败/中断历史队列。
- [ ] TUI `/queue` 查看/edit/cancel 与服务端 truth 接线完成，既有快捷键和非交互退出语义不回归。
- [ ] 真实 daemon + Playwright 核心场景有可重复证据。

## 4.13 对抗性验收

| 质疑 | 必须给出的证据 |
|------|----------------|
| “只是把外层 queue 改成 10，内部仍全局串行” | 真实 lifecycle 同时停在 10 个 deferred provider 调用，且 runtime active map 有 10 个不同 session |
| “用户消息立即显示只是 localStorage 乐观 UI” | 第二个浏览器/刷新后的 snapshot 在 provider 首 token 前看到同一 promptId |
| “持久化了，但重启会重复执行工具” | running 变 interrupted，fake provider/tool 调用计数不增加；仅 queued 自动继续 |
| “第 101 个竞态下仍可能插入” | 并发 accept 压测后 DB queued 精确为 100，所有拒绝均为 scheduler queue-full |
| “queued B 泄漏进 A 的 context” | fake provider 捕获 A 的完整 request，明确不含 B 文本 |
| “取消一按就启动下一条，旧 run 仍在收尾” | barrier 证明 B 的 provider 调用晚于 A 的 RunLedger/stream/sandbox settle |
| “provider 429 和本地 queue full 混在一起” | wire DTO 的 source/code 不同，UI 文案和 retryable 语义分别断言 |
| “切到别的 session 仍被全局 running 禁用” | Playwright 在 A streaming 时切 B，B 可发送并独立显示状态 |
| “Queue 看似只有两条，后续消息无法操作” | Playwright 用滚轮、触控板等价 wheel 与滚动条/键盘路径到达第 3 条以后并完成 edit/cancel；无自动滚动 |
| “TUI 仍在猜 queued 数量” | 重建 TUI store/重新进入 `/queue` 后数量与 promptId 来自 snapshot，代码与测试不依赖 pending Promise 计数 |

只有上述发布门全部关闭，才能把“多 session 延迟”和“发送后长时间无视觉反馈”认定为解决，而不是仅改善了表面 loading。
