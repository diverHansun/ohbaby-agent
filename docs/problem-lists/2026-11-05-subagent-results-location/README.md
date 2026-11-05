# 子代理结果搬迁

本议题于 2026-11-05 开启，目标是把子代理的长报告从平台数据目录搬进会话存储区。现在报告放在 `<数据目录>/storage/subagent-results/` 下，搬迁后放到 `~/.ohbaby/sessions/<根会话ID>/subagents/`。同时有三项配套改动：

- 删掉读这些报告专用的放行通道 `authorizeInternalRead`，改用存储区的只读权限。
- 改子代理提示词，让子代理把长日志写进 scratch 目录，不再写进用户的工作区。
- 删掉一个没有调用方的参数 `forceFile`。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-05 | 首轮 | 搬迁位置、删除专用读取通道、子代理提示词、删除 `forceFile` | 规划中 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界、和以前决定的关系 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 结果怎么导出、怎么送达、怎么读、怎么删；子代理写文件的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 3、接口、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | 9 个参考项目怎么存子代理结果、怎么组织会话目录、怎么管权限 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门、对抗性审查 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题没有要求关键改动清单，02 只写到文件一级。
- **前置条件**：[会话存储区](../../services/session-storage/README.md)第一期已经落地，包括目录、归属规则，以及“`scratch/` 可写、其余只读”的两档可信路径。本议题不依赖存储区第二期。
- 不做旧数据兼容。本项目还在快速迭代，没有发布过正式版本。
- 不可逆点：无。报告原文一直存在数据库里，文件随时可以重新导出。

## 实施顺序（用户 2026-11-05 确认）

1. 会话存储区第一期
2. **本议题**
3. 会话存储区第二期
4. [消息复制](../2026-11-04-message-copy/README.md)
5. [撤销重发](../2026-11-04-conversation-undo/README.md)
6. [会话 fork](../2026-11-04-session-fork/README.md)
7. [side chat](../2026-11-04-side-chat/README.md)

## 相关议题

| 议题 | 关系 |
|---|---|
| [会话存储区](../../services/session-storage/README.md) | 提供目录、归属规则和只读权限；本议题在它第一期之后实施 |
| [执行可靠性 improve-3](../2026-09-19-execution-reliability/improve-3/02-optimization-plan-and-change-scope.md) | §2.7 定了现在的导出方案。本议题改了位置和读取方式，其余决定保留，见 00 §4 |
| [会话 fork](../2026-11-04-session-fork/README.md) | fork 出来的会话读源会话的报告要确认，和该议题 P11 一致 |
| [side chat](../2026-11-04-side-chat/README.md) | side chat 用主会话的存储区，搬迁后能直接读主会话子代理的报告 |
