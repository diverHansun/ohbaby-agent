# 轮次投影（turn projection）

本议题于 2026-11-06 开启。目标是让界面上的“一轮”按后端真正的执行单位（主会话的 run）来划分，而不是按用户发出的 prompt。这样子代理把主代理唤醒后新开的那一轮，也能像普通的一轮一样折叠中间过程、显示最终答案、提供复制按钮和耗时行，并标明是子代理触发的。

起因：用户发现有些会话的最后一条回答不能复制。核查后发现，子代理做完后会唤醒主代理新开一个 run，但这个 run 没有 prompt 记录，而 Web 和 TUI 都按 prompt 去找“一轮”，于是这一轮在界面上整个丢了身份。

范围包括后端（给 run 记录触发来源和结局、视图按需返回 run）、Web 和 TUI。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-06 | 首轮 | run 的触发来源与结局、视图里的 run 覆盖范围、Web 按 run 投影轮次、TUI 按 run 显示耗时 | 后端已实现，待前端接入与验收 |

## 2026-11-07 后端交接

- 前端可以用 `message.runId` 在当前视图的 `runs` 中找到这条消息所属的主 run。翻历史时，同页的消息和 run 一起返回。刚开始、还没有消息的主 run 也会出现在当前视图中。
- 每个已结束的主 run 只检查最后一条 AI 消息。Stop 的 SQLite 回归用例在流式输出半段正文后中断，关闭客户端再重开数据库，视图与历史仍能读到相同的消息 ID 和正文。停止提示有独立的 `lifecycle-interruption` 标记，前端复制时可将它排除。按钮和剪贴板按 [04 的 T11 至 T11c](improve-1/04-test-and-acceptance.md) 验收。
- 用本议题最初报告的旧会话验证，新查询在 1 条 prompt 下返回 4 个成功结束的主 run，4 条收尾 AI 消息均有正文。旧账本中四条触发来源都是 `user`。复制资格按 run 与正文判断，旧来源标签的兜底见 [00 的 P6](improve-1/00-discussion.md)。
- 后台子任务运行期间由程序检查状态。Goal 当前这次主 run 成功结束时，如果它派出的子任务还在排队或运行，现有 Goal 驱动会退出这次续跑循环，Goal 仍保持 active。子任务交回结果、失败或超时，主代理再按现有交付规则处理。这次等待期间用户仍可以发消息。

后端验收依据为 [04 的 T1 至 T6](improve-1/04-test-and-acceptance.md)。本次全量运行通过 4,940 项单元测试、2,133 项集成测试、581 项契约测试，另有 2 项单元测试跳过。类型和格式检查通过，lint 报告 0 个错误、107 个警告。

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、术语、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | run/turn/step/call 在代码里的对应、run 的几种来源、Web 与 TUI 现在怎么划分一轮、视图里 run 的覆盖范围 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 4、接口与兼容、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | codex、claude-code、deepseek-harness、ZCode、kimi-code 怎么定义一轮、怎么处理唤醒 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门、对抗性审查 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题不写关键改动清单，02 只写到包和文件一级；也不写模块级改进文档，实施完成后同步各模块的权威文档（02 Stage 4）。
- 分工在实施前与用户确认。
- 不需要数据库迁移：`run_ledger.trigger` 本来就是文本列。不可逆点：无。

## 相关议题

| 议题 | 关系 |
|---|---|
| [Web 整轮过程折叠](../2026-09-29-web-run-process-collapse/README.md) | 定下了现在“按 prompt 判断一轮、不加 SDK 字段”的做法。本议题有意改为按 run 判断，并给 `UiRun` 加字段；折叠的其余规则保留 |
| [消息复制](../2026-11-04-message-copy/README.md) | 复制按钮挂在每轮最终答案上，常显的那一行跟最后一个已结束的轮次走。本议题落地后，唤醒那一轮的回答也能复制 |
| [会话 fork](../2026-11-04-session-fork/README.md) | 切点现在按 prompt 定，会漏掉之后的唤醒轮次。本议题落地后再改为按 run 定 |
| [撤销重发](../2026-11-04-conversation-undo/README.md) | 本议题勘测发现 `subagent_execution.root_prompt_id` 从未写入，撤销方案靠它找子代理行不通。本议题落地后在撤销议题里修订 |
| [side chat](../2026-11-04-side-chat/README.md) | 复制主会话历史的切点同样要改为按 run 定，本议题落地后再改 |
