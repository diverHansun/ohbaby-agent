# Prompt 发送后对话空白延迟

> 状态：**规划中（improve-1 文档已按 2026-08-18 确认方案优化，待最终审查）。** 规划会话不写业务代码；实施按 `improve-1/02` + `improve-1/04` 在独立会话进行。
>
> 时间口径：2026-08-18，代码基线 `main@474f147`。

`ohbaby serve` 后在浏览器发送首条 prompt，输入框清空后页面仍停在欢迎态，数秒后用户气泡与 Thinking card 才一起出现。根因不是浏览器渲染慢，而是 Web 没有把“本地已提交”和早到的 `prompt.updated(starting)` 投影成对话反馈，只等待较晚的正式 `message.appended`；首次 runtime / MCP 热身放大了这段等待。

本议题分批：

| 批次 | 目录 | 解决什么 |
|------|------|----------|
| **improve-1（本批）** | [`improve-1/`](./improve-1/) | 借鉴 OpenCode：最小 optimistic overlay、稳定消息 ID、现有服务端事件接管；补 busy 回退与独立 Thinking 生命周期 |
| improve-2（未开） | 暂不建目录 | serve 启动预热 MCP/runtime；评估 TUI 启动中投影；排队 prompt 是否进入对话流 |

## 文档地图

| 文档 | 作用 |
|------|------|
| [improve-1/README.md](./improve-1/README.md) | 本批范围、阅读顺序、开发闸门 |
| [improve-1/00-discussion.md](./improve-1/00-discussion.md) | 已确认决策与边界 |
| [improve-1/01-problem-analysis-and-current-state.md](./improve-1/01-problem-analysis-and-current-state.md) | 现状、竞态根因与代码锚点 |
| [improve-1/02-optimization-plan-and-change-scope.md](./improve-1/02-optimization-plan-and-change-scope.md) | 实施契约 |
| [improve-1/03-reference-projects.md](./improve-1/03-reference-projects.md) | OpenCode / Kimi Code / DeepSeek 的 adopt-adapt-reject |
| [improve-1/04-test-and-acceptance.md](./improve-1/04-test-and-acceptance.md) | 测试、真实 `ohbaby serve` E2E 与发布门 |
| `improve-1/05-implementation-acceptance.md` | 实施完成后由验收模式写入；规划期不存在 |

推荐阅读：`improve-1/00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为准；若与 `00` 冲突，先修订文档再实施。

## 与既有权威文档的关系

| 文档 | 关系 |
|------|------|
| [`../2026-07-12-workspace-prompt-concurrency/`](../2026-07-12-workspace-prompt-concurrency/) | **仍是 FIFO、queued 与 `clientRequestId` 的权威。** 本批澄清：scheduler 的 `starting` 早于最终 run-ledger ownership，故可用于临时展示，但不能据此过早持久化正式 conversation message。正式消息仍使用预分配 `userMessageId`。 |
| [`../../ohbaby-web/goals-duty.md`](../../ohbaby-web/goals-duty.md) | Web 仍是投影 adapter。本地 optimistic 只覆盖协议事实到达前的短窗口；服务端 submission / message 到达后按优先级接管，不成为第二事实源。 |
| [`../../ui/views/use-case.md`](../../ui/views/use-case.md) F2 | TUI 仍按正式 `message.appended` 离开 EmptyState。本批不改 TUI 展示模型。 |
| [`../2026-07-13-web-stream-scroll-and-composer-placeholder/`](../2026-07-13-web-stream-scroll-and-composer-placeholder/) | 跟滚需覆盖 optimistic 气泡和 Thinking 出现；除非回归失败，本批不改滚动算法。 |
