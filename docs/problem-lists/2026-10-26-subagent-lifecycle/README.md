# 子代理生命周期、可见性与控制入口

本议题 2026-10-26 开始讨论，2026-10-28 形成正式方案，2026-10-29 按 D46 拆成四个 improve。目标有两个：一是让后台子代理能跨主代理的轮次继续工作，并把停止、复用、关闭和结果交付的规则定清楚；二是把子代理的查看入口搬到 Web 右侧栏。

**进度（2026-10-31）：** improve-1 到 improve-4 已完成，D54 统一后台执行和最终复审修复已通过本机全量、端到端与独立子代理审查，进入 main 发布收尾。最终结论见 improve-4/09。

## 四个 improve

按 1 → 2 → 3 → 4 的顺序实施。按 D49 只建两个本地分支：后端（improve-1、2 和补充批次）由 Codex 在 `subagent/backend` 上做；前端（improve-3、4）由 Claude 在 `subagent/frontend` 上做，它从 `subagent/backend` 切出。每个 improve 内部按批次提交。

| improve | 内容 | 本地分支 | 文档 |
| --- | --- | --- | --- |
| 1 | 统一 `agent` 工具和子代理生命周期：执行名额、跨轮结果交付、monitor、监督；Web/TUI 同时认新旧工具名 | `subagent/backend` | [00](improve-1/00-discussion.md)、[01](improve-1/01-problem-analysis-and-current-state.md)、[02](improve-1/02-optimization-plan-and-change-scope.md)、[03](improve-1/03-reference-projects.md)、[04](improve-1/04-test-and-acceptance.md) |
| 2 | 子代理实例的读取与控制后端：实例列表快照、单实例停止、详情定位、关闭后拒读 | `subagent/backend` | [02](improve-2/02-optimization-plan-and-change-scope.md)、[04](improve-2/04-test-and-acceptance.md) |
| 3 | 右侧 Tab 容器、入口页、Subagents 列表和详情的前端 | `subagent/frontend` | [02](improve-3/02-optimization-plan-and-change-scope.md)、[04](improve-3/04-test-and-acceptance.md) |
| 4 | 主会话入口切到右侧栏，删除旧浮层，回归 | `subagent/improve-4` | [02](improve-4/02-optimization-plan-and-change-scope.md)、[04](improve-4/04-test-and-acceptance.md) |

所有讨论记录和用户原话（D01–D54）都在 [improve-1/00](improve-1/00-discussion.md)，现状分析和参考项目也只在 improve-1 里写一份，improve-2 到 4 直接引用。每个 improve 实施完成后，在各自目录里写 `05-implementation-acceptance.md`。

最终收尾与当前验收结论见 [improve-4/09](improve-4/09-final-closeout.md)：覆盖 D54、R5/R6/B5 修复、编译 Web 端到端测试和发布边界。

## 方案要点

**工具和控制（improve-1）**

- 统一的 `agent` 工具有六个 action：spawn、send、list、monitor、stop、close。参数写进 schema，并按 action 校验。
- spawn 和 send 启动的执行一律在后台运行，没有前台模式（D54）。运行中的 send 把消息放进下一次模型请求，不打断当前工作。
- 每个主会话最多同时跑六个子执行。异步创建前先占名额，清理确认后才归还；满了就明确告知"未启动"，不自动排队。执行自然结束后，它留下的后台 shell 继续跑但不占名额；被 stop 时，要等这些 shell 退出后才还名额（D42）。
- stop 结束本次执行，实例还能接着用；close 注销实例，list 和 UI 都看不到，send 也无法恢复，但持久历史仍可供主模型只读。执行非自然结束时，还没消费的消息关闭并告知主代理，不带进下一次执行（D45）。
- 已完成的实例默认保留供复用。确定不再需要，或者上下文已经不适合时，再 close 后新建。

**结果和监督（improve-1）**

- 用户按 Stop 只结束主执行，子代理继续跑；要停某个子代理，用 `agent(action="stop")` 或右侧栏。主代理空闲时收到后台结果会新开一轮；忙的时候，结果进入下一次模型请求。
- monitor 立即读取一个或多个子代理已有的记录，不调用模型、不等待、不订阅。
- 主代理空闲且有后台在跑时，首次 2 分钟、之后每 5 分钟监督唤醒一次；连续 3 次没有新事实就停（D44）。子代理卡住时，靠 30 分钟的执行超时兜底。
- 没有文件隔离，写冲突靠提示词约束（D43）。派遣时还有四条提示词软约束（D47）。

**右侧栏（improve-2 到 4）**

- 后端只做子代理实例的读取和控制，不建通用面板后端。Tab 状态放在前端，用页面类型给以后的终端、浏览器留扩展位（D46）。
- 这一批只有 Subagents 页面：Active/Done 分组的实例列表和只读详情，详情里可以单独停止。关 Tab 不会停止代理。
- 主会话保留工具输出，点击"xx 子代理启动"直接打开右侧详情。旧的子会话浮层最后删除。

## 边界

主要产品行为已经确认完毕。字段命名、计时细节、清理方式这些工程问题，在各个 02 里按已确认的行为给出方案；实施中如果发现必须改变产品语义，再带证据提出来。

本次核查基于 ohbaby `94abaa64e8b21d93ccc88bbad69de0b486483004`，实施前要按新的 HEAD 重新核对 01 里的行号。关键问题不只是工具改名：现在原主 run 同时管着后台资源、结果投递和收尾，必须和"由哪一轮派出"这个来源信息拆开；现有的 dispatch 并发数也不等于实际在跑的子执行数。

历史决策见 [execution-reliability improve-3](../2026-09-19-execution-reliability/improve-3/00-discussion.md)，新旧规则的对应关系见 improve-1/01。Web 现有设计见 [redesign-2026-10](../../ohbaby-web/redesign-2026-10/README.md)，improve-4 实施时同步更新，不改写历史讨论。
