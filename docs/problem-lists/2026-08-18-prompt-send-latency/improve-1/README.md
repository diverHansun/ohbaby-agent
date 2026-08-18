# improve-1 · Web 即时反馈与稳定 ID 接管

> 状态：**规划文档已按确认方案优化，待最终审查。** 本规划会话不写业务代码。
>
> 时间口径：2026-08-18，基线 `main@474f147`。

## 1. 本批一句话

借鉴 OpenCode 的核心因果，而不照搬其完整前端框架：Web 在 Enter 同一帧提交最小 optimistic overlay；既有 `UiPromptSubmission(starting)` 接管启动中展示；最终 `UiMessage` 以同一个服务端 `userMessageId` 接管。三阶段只是展示优先级，不新增状态机、事件类型或第二事实源。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结已确认决策 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状、根因与竞态边界 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 后续实施会话的执行契约 |
| [03-reference-projects.md](./03-reference-projects.md) | 参考项目取舍 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 自动化、E2E 与验收门 |
| `05-implementation-acceptance.md` | 实施完成后由验收模式写入（规划期不存在） |

阅读顺序：`00 → 01 → 02 → 03 → 04`。实施只读 `02 + 04` 仍应能完成本批。

## 3. In scope

- Web：Enter 同一帧清空输入、切出欢迎页、显示 optimistic 用户气泡与启动中 Thinking。
- Web：发送按钮 spinner 只覆盖 `POST /v1/prompts` admission；202 或失败即停，Thinking 可继续。
- 展示接管链：`local attempt → UiPromptSubmission(starting) → UiMessage`，按权威性派生，不建立显式三阶段状态机。
- ID：receipt 前只用 `pending:${clientRequestId}` 作为 React 展示 key；receipt 后 provisional 与正式消息统一使用服务端 `userMessageId`；core user message 也复用该 ID。
- queued：上一轮仍 active 时的新 prompt 只进入 Queue；空闲首条在极短 queued 窗口可由本地 optimistic 保持反馈。
- busy：`starting → queued` 时 provisional 对话行和启动中 Thinking 自动退出，对应 prompt 回到 Queue；不创建或补偿删除正式消息。
- Thinking：独立于 pending 气泡的清理时机，在 local admission、server starting、run running 三段间无空窗接管。
- 失败：HTTP 未受理则安全恢复草稿；已受理但正式消息尚未产生而启动失败，则保留 submission-derived 用户文本并显示内联错误。
- 后端：仅补齐预分配 `userMessageId` 到 core user message 的传递和创建能力；不提前正式 publish。
- 测试：Web 单测、core/scheduler 契约测试、真实独立 `ohbaby serve` 浏览器 E2E。

## 4. Out of scope

- 在 scheduler execute 开头正式持久化或发布 `message.appended`。
- 拆分 `RunManager` 的 claim/start 生命周期，或新增跨进程补偿事务。
- 修改 `UiPromptReceipt`、新增 SSE 事件或新的服务端状态枚举。
- 通用 optimistic framework、独立 reducer、跨页面 optimistic 基础设施。
- queued prompt 成为正式 conversation message 或进入模型上下文。
- TUI optimistic / starting projection；本批只做回归测试。
- serve 启动时预热 MCP/runtime（improve-2）。
- POST 等待 `startSession`、Starting 阶段提供无效 Stop、全屏蒙层、骨架屏或像素级品牌动效系统。

## 5. 开发闸门

1. [ ] 用户审阅并确认本目录 00–04。
2. [ ] 独立实施会话按 02 完成 Phase A（稳定 ID）→ Phase B（Web 展示接管）→ Phase C（验证与文档同步）。
3. [ ] 按 04 跑 unit / contract / integration / typecheck，并由实施进程启动独立 `ohbaby serve` 完成浏览器 E2E。
4. [ ] 分批提交；实施完成后可另开验收会话写 `05-implementation-acceptance.md`。
