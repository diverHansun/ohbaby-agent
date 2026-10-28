# 子代理生命周期、可见性与控制入口

本议题于 2026-10-26 开始讨论，2026-10-28 整理正式方案。目标是让后台子代理跨主代理轮次继续工作，明确停止、复用、关闭和结果交付，并将子代理查看迁入 Web 右侧栏。

**当前为规划交付，未修改实现代码。** 用户确认记录见 00；工程细化与实施范围见 02。所有阶段属于同一个 improve-1，不因实施需要多次会话另开轮次。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [00-discussion.md](improve-1/00-discussion.md) | D01–D41：用户已确认的选择与原话；旧工具命名已由统一 agent 覆盖 |
| [01-problem-analysis-and-current-state.md](improve-1/01-problem-analysis-and-current-state.md) | 当前代码、关键差距与旧设计被替代的部分 |
| [02-optimization-plan-and-change-scope.md](improve-1/02-optimization-plan-and-change-scope.md) | 行为契约、接口、生命周期、右侧 UI、实施阶段与改动面 |
| [03-reference-projects.md](improve-1/03-reference-projects.md) | DSH、Codex、Kimi、ZCode、OpenCode 的源码快照与取舍 |
| [04-test-and-acceptance.md](improve-1/04-test-and-acceptance.md) | 32 项风险验收、测试分层与发布要求；不是已通过报告 |

`05-implementation-acceptance.md` 仅在实施完成后编写，本轮不创建。

## 方案概要

- 统一 `agent` 工具，六 action：spawn、send、list、monitor、stop、close。参数放进 schema 并按 action 校验。
- spawn/send 新执行默认后台，可显式前台；运行中 send 在下一模型请求加入消息，不改变模式、不打断。
- 每主会话最多六个实际子执行，前后台共用。异步创建前预占，清理确认后归还；满额明确未启动，不自动排队。
- 主 Stop 结束主执行与本轮前台，后台继续；主代理空闲时收到后台结果可新开一轮，忙碌时进入下一模型请求。
- stop 结束本次执行，实例可复用；close 注销可运行实例，list/UI 隐藏、send 不可恢复，持久历史仍供主模型只读。
- 已完成实例默认保留供复用；确定不再需要、后续任务关联较低或多轮后上下文不再合适时，可 close 后新建。不设固定轮数自动关闭。
- monitor 对一个或多个代理即时读取已有记录，不调用模型、不等待、不订阅；最终交付仍以任务结果为主。
- 保留空闲监督，以首次 2 分钟、后续 5 分钟为方案基线；用户中断仅禁止定时唤醒，真实结果仍可唤醒。不增加通用提醒服务。
- 本批 UI 只有右侧 Tab 容器、默认入口页和子代理功能。主会话保留工具输出，点击“xx 子代理启动”直达右侧详情；可返回 Active/Done 实例列表。Active/Done 只是 UI 分组。
- 关闭 Tab 不停止代理。替换旧子会话浮层和重复导航，复用详情 reader；文档查看、Review、浏览器和终端都留到后续。

## 本轮状态与边界

主要产品行为已明确，没有需要继续逐项询问的实质选择。字段结构、计时重置、清理与投影方式等在 02 给出符合既有决定的工程方案；实施时如发现必须改变产品语义，再说明证据与差异。

本次核查基于 ohbaby `94abaa64e8b21d93ccc88bbad69de0b486483004`。当前的关键问题不只是工具改名：旧主 run 同时控制后台资源、结果投递与收尾，必须与派遣来源分开；现有 dispatch 并发也不等于实际子执行并发。

历史决策保留在 [execution-reliability improve-3](../2026-09-19-execution-reliability/improve-3/00-discussion.md)，新旧规则对应关系见 01。Web 既有设计见 [redesign-2026-10](../../ohbaby-web/redesign-2026-10/README.md)，实施时同步其权威布局与测试说明，不重写历史讨论。
