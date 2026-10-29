# 2. 优化方案与改动面：子代理实例的读取与控制后端

> 2026-10-29 按 D46 从 improve-1 拆出。讨论记录和用户原话统一放在 [improve-1/00](../improve-1/00-discussion.md)，现状见 [improve-1/01](../improve-1/01-problem-analysis-and-current-state.md)，本目录不另写 00、01。
> 前提：improve-1 已合并，实例和执行的新模型（会话归属、名额、`closedAt`、未消费消息的关闭记录）已经在 main 上。

## 2.1 目标与范围

给右侧栏（improve-3）准备后端接口：按主会话列出未关闭的实例，单独停止某个实例，按实例读取详情，关闭后拒绝 UI 读取。接口走现有的三条通道：SDK、HTTP、in-process。

**不做通用面板后端（D46）。** 我们查了 ZCode 和 opencode：两家的 Tab 容器都只在前端，终端和浏览器各有自己的后端（PTY 服务、Electron 主进程），没有共用的"面板/Tab"服务端模型（见 [improve-1/03 的 3.7](../improve-1/03-reference-projects.md)）。所以给终端、浏览器铺路只需要 improve-3 在前端留好页面类型，这里不建面板注册表，也不持久化 Tab 布局。

## 2.2 接口契约

### A. 实例列表快照

现在 Web 的列表是按 execution 历史一条条追加的，统计只覆盖当前这一轮（[subagent-views.ts:76](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-views.ts:76)）。改成按实例给快照：

- **一个实例一行。** 同一个实例 send 了十次也只有一行。范围是当前主会话全部未关闭的实例，跨轮次，不能拿执行历史默认的前 50 条或当前 root 的统计代替。
- **每行至少包含：** 所属主会话、稳定的 ID 和 name、简短任务说明（description，没有就取 prompt 摘要）、创建和最近更新时间、实例状态、当前或最近一次 execution 的引用、实际 mode、是否在等审批、是否还有执行资源在收尾、未处理消息条数（D45）。improve-3 的列表和 Active/Done 分组只依赖这些字段。现在"等审批"只按 root run 统计（[subagent-views.ts:106](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-views.ts:106)），要改成按实例给出。
- **Active/Done 不进后端。** 它们是 UI 分组，由 improve-3 根据状态推导，core 的状态枚举不新增这两个值。
- **只有拿到完整快照才替换。** 只有成功拿到完整的、属于当前会话的快照，才能替换列表。读取失败或结果不完整时，不能推断某个实例已关闭。以后要分页的话，"这一页没有"和"实例被移除"必须分开表示。
- **刷新复用现有机制。** 不为列表另造事件总线。close 只改了 `closedAt`、没有新的 execution 更新时，也必须触发列表失效。agent 工具的结果和单实例控制的回执都可以触发立即刷新。

### B. 单实例停止

新增一个带类型的控制入口（SDK、HTTP、in-process 三条都要），调用的 Host 操作和 `agent(action="stop")` 相同：

- 不依赖主代理正在运行，也不调用主会话的 abort。
- 请求带上主会话、实例和**预期的 execution 身份**。如果目标已经结束，或者已经换成了新的 execution，就返回实际状态，不去停新的那次。这样迟到的点击不会误停后续执行。
- 只返回一个回执，里面用一个字段区分"中断已受理"和"清理已确认"。返回后刷新实例快照；清理确认得晚的，靠快照刷新反映出来。
- 跨主会话的请求一律拒绝。

### C. 详情读取

- 保留现有的 watch、revision 和分页协议。
- 按实例选择，另外可以带一个可选的 `anchorExecutionId`，用来从主会话的历史入口定位到某一次执行。定位到历史位置，不影响标题显示的当前状态；旧的 Queued/Completed 事件不能覆盖新状态。
- 实例 close 后，UI 的详情接口拒绝继续读取，并释放相关投影。主模型通过 monitor 的授权历史读取不受影响。
- 释放 watch 只是停止读取，不能触发 stop 或 close。
- 旧的按 execution 读取的接口如果 CLI 或历史记录还在用，就保留，不因为 Web 改用实例列表而全局删除。

### D. 权限

`coordination/session-access.ts` 对列表、停止、详情三类请求都按主会话校验。读和控制分开授权，和 improve-1 里 `agent` 工具的只读/控制划分一致。

## 2.3 分批实施

按 D49 在 `subagent/backend` 上实施，接在 improve-1 后面。先把 B1 到 B3 的接口类型（列表、停止、详情锚点）一次定下来并提交，improve-3 就可以提前开工（D46）。

| 批次 | 内容 | 完成标准 |
| --- | --- | --- |
| B1 实例列表快照与关闭失效 | SDK contract 和 sync、in-process-rpc、server `routes/subagents.ts`、agent 侧 `subagent-views.ts` | 列表一实例一行、跨轮；close 后失效。通过 I2-01、I2-02 |
| B2 单实例停止 | 同上，加 Host 的 stop 入口 | 带预期 execution 的停止可用，迟到不误停。通过 I2-03 |
| B3 详情定位与权限 | readers、watch、`session-access.ts` | 锚点定位、关闭后拒读、跨会话拒绝；CLI 旧接口照常。通过 I2-04 到 I2-06 |

## 2.4 改动面

| 范围 | 新增或修改 | 删除或收敛 |
| --- | --- | --- |
| `packages/ohbaby-sdk/src/contract/`、`sync/`、`in-process-rpc/` | 实例列表、单实例停止、详情锚点、关闭失效和读取边界 | Web 不再用 execution 历史条数当实例数量 |
| `packages/ohbaby-server/src/protocols/web/routes/subagents.ts`、`coordination/session-access.ts` | 列表、控制、详情的路由和权限 | 关闭后仍能读 Web 详情的路径 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-*.ts` | 实例投影、按实例的 reader | 不删除 CLI 还在用的 execution reader |
| `apps/ohbaby-web/src/api/daemon/client.ts` | 新接口的客户端方法（只加方法，不接 UI） | 无 |

## 2.5 风险

| 风险 | 怎么防 |
| --- | --- |
| 前端合并旧列表，导致 close 后实例又出现 | 快照整体替换；close 只改 `closedAt` 时也要失效 |
| 迟到的停止请求误停新执行 | 请求必须带预期的 execution 身份 |
| 读取失败被当成实例已关闭 | 不完整的结果不替换列表 |

## 2.6 与讨论记录对齐

| 决策 | 落在哪 |
| --- | --- |
| D10、D24、D29：关闭后 UI 不可见，主模型仍可读历史 | A、C |
| D36–D40：Active/Done 只是 UI 分组，列表一实例一行 | A |
| D07、D45：单独停止不影响主代理；未处理消息条数 | A、B |
| D46：不建通用面板后端 | 2.1 |

## 2.7 待讨论

轮到 improve-2 时再定：列表刷新具体复用哪条现有机制（watch 还是工具结果触发的拉取）。目前倾向复用现有刷新，不新增推送通道。
