# 4. 测试与验收标准

本仓库没有独立 `test-blueprint.md`。沿用 `docs-test/` 的 colocated 分类：`*.unit.test.ts` / `*.contract.test.ts` / `*.integration.test.ts` / `*.smoke.test.ts`；Web 特有约束见 [`docs/ohbaby-web/test.md`](../../../ohbaby-web/test.md)。本批围绕 01 的 P1–P10 和真实用户感知验收，不追求覆盖率数字。

## 4.1 测试范围

| 类型 | 覆盖 | 不覆盖 |
|------|------|--------|
| unit | message factory/runner 预分配 ID；Web local attempts、展示优先级、乱序对账、Thinking、spinner、草稿恢复 | 真实 MCP 耗时、像素级视觉差异 |
| contract | adapter→service→runner ID 贯穿；busy requeue 不产生正式 UI message；receipt/SSE schema 不变 | 新协议兼容（本批无新协议） |
| integration | prompt scheduler starting/busy 与 snapshot projection；必要的 Web client/store 串联 | 外部 provider 稳定性 |
| browser E2E | 由实施 agent 自己启动独立 `ohbaby serve`，验证首条发送即时变化、ID 接管、Queue 与错误呈现 | 全站视觉回归、跨浏览器矩阵 |
| regression | typecheck、相关 agent/web/TUI 测试 | 与本批无关的全量性能 benchmark |

建议实施命令，最终按实际新增文件补齐：

```bash
pnpm exec vitest run \
  apps/ohbaby-web/src/ui/App.unit.test.tsx \
  packages/ohbaby-agent/src/core/message/manager.unit.test.ts \
  packages/ohbaby-agent/src/core/agents/runner.unit.test.ts \
  packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts \
  packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts \
  --passWithNoTests

pnpm typecheck
pnpm --filter ohbaby-cli build
```

若定向测试全部通过，合并前再运行相关分类脚本或 `pnpm test`；不得用只跑新增测试代替回归。

## 4.2 关键场景与用例

### Phase A：稳定 ID 与 busy 安全边界

| ID | 场景 | 类型 | 验证点 | 回应问题 |
|----|------|------|--------|----------|
| T-A1 | message factory 收到显式 ID | unit | `Message.id` 使用给定值；time/role/parts 行为不变 | P2 |
| T-A2 | message factory 未收到 ID | unit | 继续调用 generator，不改变 assistant/system/普通路径 | P2 |
| T-A3 | user prompt 走 adapter→service→instance→runner | contract/unit | core user message、submission、formal UI message 都等于 receipt.`userMessageId` | P2 |
| T-A4 | run-ledger busy | contract | requeue 完成后 core store/snapshot 无该临时 user message；prompt `starting → queued`；adapter 没有发布该 ID 的正式 UI `message.appended`。不声称 core message 从未短暂可见 | P7 |
| T-A5 | busy 后重试成功 | contract | 同一预分配 ID 可重新创建并最终只产生一个 formal UI user message | P2 P7 |
| T-A6 | subagent/goal/无预分配 ID | unit | 继续生成独立 ID，无 undefined/重复 message | P2 |
| T-A7 | schema diff | review/contract | `UiPromptReceipt`、`UiPromptSubmissionStatus`、SSE event 形状无变化 | P6 |

### Phase B：Web 展示接管

| ID | 场景 | 类型 | 验证点 | 回应问题 |
|----|------|------|--------|----------|
| T-B1 | Enter，HTTP Promise 尚未 resolve | unit | draft 同帧清空；主布局、local user row、一个 startup Thinking、Send admission spinner 已出现 | P1 P4 P5 |
| T-B2 | receipt 到达，starting 尚未到 | unit | local row key/identity 切到 `userMessageId`；spinner 停；user row 与 Thinking 不消失 | P2 P8 |
| T-B3 | queued SSE 早于 receipt（idle 首条） | unit | eligible local row 不被 queued 立即清除，不退回欢迎页 | P3 |
| T-B4 | `prompt.updated(starting)` 到达 | unit | server submission 接管 local 文本/ID；仍只有一条 user row、一个 Thinking | P6 P8 |
| T-B5 | formal message 到达 | unit | formal UiMessage 接管；同一 render 中无双 user row；startup Thinking 不因 message 对账提前消失 | P2 P8 |
| T-B6 | run running 在 formal message 前到达（当前 adapter 顺序） | unit | server provisional user row 继续；只显示现有 run Thinking；formal 后到仍无双行 | P8 P10 |
| T-B7 | formal message 早于 receipt / SSE 乱序 | unit | 仍按 ID/clientRequestId 合并为一条；后到 receipt 不制造 pending | P2 P10 |
| T-B8 | `starting → queued` busy requeue | unit | provisional row和 startup Thinking 退出；Queue 显示该 prompt；无 formal row | P7 |
| T-B9 | active run 时再发 | unit | 新 prompt 不插 conversation optimistic；HTTP 期间按钮有反馈，server queued 后只在 Queue | P3 P7 |
| T-B9a | local 未观察到 starting，但 snapshot 显示其它 active run + matching queued | unit | 仍按 Queue 呈现，不因丢失中间事件残留 conversation row | P7 P10 |
| T-B9b | 当前 prompt 已 `starting`、live run 尚未出现时提交 follow-up | unit | follow-up 仍判为 Queue placement；conversation 与 Queue 不重复显示 | P7 P10 |
| T-B9c | admission pending 时在 existing session 与 new-session scope 间切换 | unit | local row 与 startup Thinking 只留在提交起点/receipt 目标 session，不跨 session 串线 | P3 P10 |
| T-B10 | 短时间连续提交 | unit | keyed attempts 不互相覆盖；最多一个 conversation candidate，其余按 Queue placement | P3 P10 |
| T-B11 | HTTP reject，draft 仍空 | unit | matching attempt 移除、spinner/Thinking 停止、旧文本恢复 | P5 |
| T-B12 | HTTP reject，用户已输入新 draft | unit | 新 draft 不被旧文本覆盖 | P5 |
| T-B13 | accepted 后 failed/interrupted，formal message 未到 | unit | submission-derived user row 保留并显示 inline error；不伪装成 core message | P9 |
| T-B14 | cancelled before formal | unit | 无成功态假象；按既有取消语义清理/标记，Thinking 停止 | P9 |
| T-B14a | succeeded terminal | unit | matching local attempt 删除；startup Thinking 停止；formal user row 保留 | P8 P10 |
| T-B14b | prompt status=running，但 live run projection 暂未到 | unit | server provisional row 保留，并用 startup Thinking 兜底；不得空白或双卡 | P8 P10 |
| T-B15 | receipt 已 resolve，`selectSession` 仍 pending | unit | attempt 已 accepted、ID 已更新、spinner 已停止；首帧与 Thinking 不等待 selection | P1 P5 |
| T-B15a | receipt 已 resolve，`selectSession` reject | unit | accepted row 保留、旧草稿不恢复；显示独立导航错误，不诱导重复发送 | P1 P5 |
| T-B16 | spinner / reduced motion | unit/manual | 约 1 秒一圈；`aria-busy` 正确；reduced-motion 不持续旋转 | P5 |
| T-B17 | 跟滚 | unit/manual | local row/Thinking 出现时沿用 sticky-to-bottom；用户已上滚时不强拉 | P1 |
| T-B18 | reload 时没有 local attempts | unit/integration | starting/running 独立重建 provisional；failed/interrupted 独立重建 user row + inline error | P6 P9 P10 |
| T-B19 | 较早 terminal provisional 后已有较新 formal messages，再 reload | unit | formal 与 provisional 按 `createdAt` 进入同一时间线，旧失败不会被追加到底部 | P8 P10 |

### Phase C：真实浏览器与回归

| ID | 场景 | 类型 | 验证点 | 回应问题 |
|----|------|------|--------|----------|
| T-C1 | 空测试 workspace 第一条 prompt | browser E2E | Enter 后下一帧主区已有用户文本 + Thinking；不得停留空欢迎页等待 runtime | P1 |
| T-C2 | admission 与 startup 分工 | browser E2E | HTTP 接受后 Send 停转，Thinking 继续；正式 message/run 到达时无跳空、无双行 | P5 P8 |
| T-C3 | active run follow-up | browser E2E | follow-up 只进入 Queue；当前 conversation 不插假正式消息 | P3 P7 |
| T-C4 | 刷新/reconnect | browser E2E | local overlay 不持久化；snapshot 中 starting/failed/formal 事实正确重建视图 | P6 P9 |
| T-C5 | TUI 回归 | unit/manual | 本批未改变 TUI message/queue 行为 | scope |

## 4.3 集成边界

- **Web local attempt ↔ receipt/SSE/navigation**：测试必须分别控制 receipt Promise、`selectSession` Promise 与事件到达顺序，至少覆盖 `queued-before-receipt`、`starting-before-receipt`、`message-before-receipt`、`receipt-before-selection` 和 `selection-reject-after-receipt`。
- **scheduler claim ↔ run-ledger claim**：T-A4 必须让最终 run claim 真正 busy，不能只 mock 一个普通 Error 后声称覆盖 requeue。
- **UI message ↔ core message**：T-A3 用同一个 prompt 的预分配 ID 断言两层，不用文本相等代替身份相等。
- **starting projection ↔ formal message**：同一 render selector 决定优先级，测试查询 user row 数量和 ID，避免“先双行、effect 后清除”漏过。
- **Thinking ↔ user row**：分别驱动 submission/message/run，证明它们是相关但独立的展示寿命。
- **serve E2E 进程归属**：实施 agent 只能停止自己启动的 daemon，不复用或停止用户已有 serve；使用独立 DB、workspace 与端口。

## 4.4 真实 `ohbaby serve` E2E 操作规范

实施会话应先构建，再在自己的长驻进程中启动：

```bash
pnpm --filter ohbaby-cli build
node packages/ohbaby-cli/dist/bin.js serve start \
  --host 127.0.0.1 \
  --port <isolated-port> \
  --db-path <temporary-directory>/prompt-latency.sqlite \
  --web-assets-dir apps/ohbaby-web/dist
```

要求：

1. 临时目录必须是本次创建的明确路径；不得使用用户生产 DB。
2. 日志记录 `ohbaby web ready` 的 URL 后再打开浏览器。
3. 在空 workspace 输入一个可观察到 runtime 热身的短 prompt；在 Enter 后立即检查 DOM/截图，再检查 202、starting、formal/run 接管后的 DOM。
4. 发送 follow-up 验证 Queue。若需要 busy 场景，优先用自动化 fake/contract，真实 E2E 不通过破坏用户 daemon 制造竞态。
5. 保存必要截图或浏览器断言结果；不得打印 API key、auth token 或 `.env` 内容。
6. 验收结束后优雅终止该前台进程，并确认端口不再监听。

## 4.5 回归清单

- Queue 编辑 lease、取消、FIFO 与 `clientRequestId` 幂等不变。
- snapshot/SSE replay 不修改 Composer draft；只有本次 HTTP reject 可条件恢复。
- slash overlay、IME composition、Enter/Shift+Enter 语义不变。
- Stop 仍要求 live + running + sessionId；startup Thinking 无 Stop。
- permission、todo、tool card、stream delta 和 assistant message 不因 provisional user row 重排。
- sticky scroll 规则不退化；不顺手重构 `streamScroll.ts`。
- subagent/goal-owned prompt 不被强制赋主用户 prompt ID。
- receipt/server/SSE schema 与 DB migration 均无变化。

## 4.6 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 首帧反馈 | 空 workspace Enter 后下一帧已有用户文本、主布局与 Thinking | T-B1 + T-C1 |
| 稳定身份 | receipt/submission/formal UI/core user message 使用同一服务端 ID | T-A1–A3 + T-B2–B7 |
| 无双行 | 任意 receipt/SSE/message 顺序下最多一条对应 user row | T-B2–B7 |
| busy 安全 | starting 可回 queued；无正式 UI message、无 core 残留、Queue 正常 | T-A4–A5 + T-B8 |
| Thinking 连续 | admission→starting→running 不闪断、不双卡；所有 terminal 后 local retire 且停止 | T-B1–B8/B13–B14b + T-C2 |
| spinner 语义 | 只覆盖 HTTP admission；202 后停；约 1 秒一圈且 reduced-motion 可用 | T-B1/B2/B16 + T-C2 |
| 失败 | 未受理安全恢复；已受理 terminal failure 保留文本+错误 | T-B11–B14 |
| queued 产品 | active run follow-up 只进 Queue | T-B9–B10 + T-C3 |
| 真实浏览器 | 独立 agent-owned `ohbaby serve` 完成 E2E 并被清理 | §4.4 + T-C1–C4 |
| 自动化 | 相关 unit/contract/integration、`pnpm typecheck` 全绿 | §4.1 命令与新增测试 |

## 4.7 对抗性审查要点

1. **把 starting 误当最终 ownership**
   攻击：为了 TUI 或“更真实”再次把正式 message 前移。
   防御：T-A4；02 明确 starting 只做 provisional。
   残余：core runner 仍会在最终 ledger claim 前短暂写 core message，persistent snapshot/context 理论上可能在极短窗口读到；busy 后会删除。本批只统一 ID、不额外提前 adapter 正式事件，也不宣称消除了这个存量窗口。

2. **effect 清理导致一帧双行**
   攻击：先渲染 optimistic + formal，再在 `useEffect` 清 pending。
   防御：formal > starting > local 必须在 render 派生时完成；T-B5/B7 断言始终一条。

3. **queued 规则过于粗糙**
   攻击：`if queued then clear` 重现首条真空，或 `if queued then show conversation` 污染 Queue。
   防御：固定 placement + 是否观察过 starting；T-B3/B8/B9。

4. **Thinking 绑错寿命**
   攻击：formal message 到达即清 local attempt，Thinking 消失到 run update。
   防御：独立 selector；T-B2/B5/B6。

5. **恢复旧草稿覆盖新输入**
   攻击：HTTP reject 无条件 `setDraft(oldText)`。
   防御：attempt 关联 + current draft empty guard；T-B11/B12。

6. **把 selection 失败误当 admission 失败**
   攻击：receipt 已 202，后续 `selectSession` reject 落入同一个 catch，删除 attempt 并恢复旧 prompt。
   防御：receipt 是 linearization point，导航独立报错；T-B15/T-B15a。

7. **ID 统一破坏非用户路径**
   攻击：所有 message 都强制外部 ID，subagent/assistant 出现 undefined 或冲突。
   防御：optional internal ID + T-A2/A6。

8. **E2E 污染本机环境**
   攻击：复用默认 DB/端口或停止用户已有 daemon。
   防御：独立临时目录、端口、进程句柄；结束后确认监听关闭。

**残余风险**：真实 MCP/runtime 热身仍可能数秒，startup Thinking 会持续较久。这是本批接受的真实等待；本批成功标准是用户立即获得明确反馈，而不是伪装消除实际启动成本。预热优化留给 improve-2。
