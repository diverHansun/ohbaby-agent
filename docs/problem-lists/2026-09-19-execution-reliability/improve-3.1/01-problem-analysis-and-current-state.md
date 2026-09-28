# 现状与问题

调查基线 `1a7018f1`。路径均相对仓库根目录；这里只列承重模块，不列逐行改动。

## 当前流程

主代理调用 `subagent_run` → host 接受 execution 并写入队列 → 子实例串行执行 → 持久结果交付主代理。Web 通过 SDK 列表和单 execution 详情读取子过程，当前约每秒刷新。现有 `SubagentTree` 在会话 header 上方显示列表；`SubagentView` 会替换主阅读区，并隐藏主输入框。

[improve-3 的 05](../improve-3/05-implementation-acceptance.md) 是已实施基线；此前 pre、improve-1/1.1/2/2.1 分别提供结果提取、审批、快照续传、工具事实和 Web 生命周期基础，本轮消费它们，不重新定义这些机制。

## 差距与依据

| 问题 | 代码事实与关键范围 | 对本轮的影响 |
| --- | --- | --- |
| P1 顶部独立区域打断主会话布局 | `apps/ohbaby-web/src/ui/session/SessionScreen.tsx`、`SubagentView.tsx`、`subagents.css`：列表在 header 上方，详情替换主区域 | 入口应回到调用发生的位置；保留根阅读器挂载 |
| P2 子过程不是主会话同等的实时流 | `packages/ohbaby-sdk/src/subagent-reader.ts` 读快照；Web 子流传入固定非运行状态；`adapters/ui-state/source-session-projection.ts` 的根投影排除 child scope | 不能只改 CSS 或加快轮询，须补受授权的 scope 增量投影 |
| P3 单执行详情不足以表达连续子会话 | `adapters/ui-inprocess/subagent-views.ts` 与 `executionHistory` 按 childRun 取历史；host 中多个逻辑子代理可共享物理 childSession | 查看器必须按逻辑子代理/scope 隔离，跨其多次 run；不能只用 childSessionId |
| P4 父消息与历史卡片缺少可靠锚点 | `agents/subagents/execution-store.ts` 存 prompt、requestId、requesterRunId，但未持久保存对应 child user message ID；SDK 未投影完整关联 | 新数据须显式链接，不能靠文本、时间或工具结果猜配 |
| P5 排队时还没有正式 user message | `agents/subagent-host.ts` 先接受并排队；`core/agents/runner.ts` 在 turn 开始时创建初始 user message，且该消息未带 runId | Queued 是显示投影；提前写入模型历史会影响正在执行的上一轮 |
| P6 切换会丢阅读局部状态 | `ConversationStream.tsx` 挂载/会话变化触发贴底；`tool-card.tsx` 展开状态保存在组件内 | 需按逻辑查看器保存阅读锚点和展开状态 |
| P7 TUI 实际已有内部详情 | `packages/ohbaby-cli/src/tui/app.tsx` 的 Ctrl+G 与 `components/subagent-browser.tsx` 展示文字、思考、工具及结果 | 需澄清用户最新范围，不能把“现有”误写成“只有概览” |

## 已有可靠性能力与边界

- 同一子实例忙时接受后续委派并串行排队，正常结束继续 drain；失败、超时后的暂停/显式恢复沿用 improve-3。`subagent-host.unit.test.ts` 已覆盖这些行为。本轮不引入并发运行同一实例的新语义。
- 根会话已经具有 snapshot、generation/revision、增量合并、断流恢复和读请求过期保护。SDK `session-view.ts`、`session-sync.ts` 可复用其原则；不能直接把过滤过的共享 session 版本当作连续 scope 版本。
- `core/message/manager.ts` 已有单一 commit coordinator；新增只读投影必须消费同一提交源，不能覆盖协调器或旁路持久化。
- 服务端根绑定校验位于 `packages/ohbaby-server/src/coordination/session-access.ts`；读取前后均需验证。当前 root-only 路由不能通过切换 active binding 到 child 来绕开。
- Web 采用 UI → SDK → server 的边界，workspace 的逻辑 SSE 连接共享。见 [Web 架构](../../../ohbaby-web/architecture.md)。本轮不在 React 里直接 fetch 或另建 EventSource。

## 七维结论

职责和用例的差距是“能查一次执行”与“持续阅读同一子会话”不同；架构和接口差距是 scope 读取、订阅与锚点不足；数据模型差距是 execution 到父消息缺显式身份；质量差距是切换重挂载、流式与历史竞态；测试缺口是这些边界尚未组合验证。现有 Markdown、思考与工具渲染可继续共用，无需重写消息系统或引入状态库。

本轮目标能力、拟新增字段和接口均在 02 中定义，不属于本页已实现能力。
