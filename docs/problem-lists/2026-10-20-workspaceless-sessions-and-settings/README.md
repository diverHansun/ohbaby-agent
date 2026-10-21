# 无工作区会话与设置后端

2026-10-20 开启第一轮；2026-10-21 根据讨论补充定稿。代码基线为 `73f12b63`（0.1.16），尚未实施。

本轮将工作区绑定优化和设置拆成两个功能批次，每批都包含必要的后端、SDK 和 Web 页面。用户可以不选项目直接聊天，也可以把已有会话移入或移出项目。Web 的详细视觉与组件设计留到前端实施前，本轮只确定行为和大致布局。

## 轮次与边界

| 轮次 | 开启日期 | 触发 | 内容 |
|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-10-20 | 首轮 | 默认工作区、会话归属与目录切换、全局列表与搜索、设置后端、Web 大致布局 |

按用户本次要求，实施分“工作区绑定优化”和“设置”两批（见 [02](improve-1/02-optimization-plan-and-change-scope.md)），都属于 improve-1。审核建议工作区先、设置后，具体顺序待用户确认。本轮只审核并保存文档，不开始实施。

本轮包括：

- 新会话先是草稿，默认不选项目；第一次发送才创建。未选项目时使用 `<OHBABY_HOME>/workspace/default`，默认是 `~/.ohbaby/workspace/default`。
- 已有会话可在运行时移入、换项目或移出项目，保留会话 ID 和历史。换项目时当前轮用原目录，下一轮用目标目录；移出项目时保留原工作目录。
- 跨项目、无项目的全局会话列表与搜索。搜索覆盖未归档根会话的标题和用户、助手可见正文。
- 设置后端提供模型、MCP、Skills、Agents、联网搜索、关于/诊断六块数据，写入复用已有能力。第一版只编辑当前一套模型连接，多 LLM provider 配置保存留到后续。
- Web 侧边栏、草稿中的可选项目选择器、会话项目菜单、搜索与七页设置面板。

不在本轮的内容见 [02 §2.8](improve-1/02-optimization-plan-and-change-scope.md)。按 KISS 控制范围，不为少见的后台任务情况增加调度或迁移系统。

## 文档地图

| 文件 | 内容 |
|---|---|
| [00-discussion.md](improve-1/00-discussion.md) | 最终确认的决策与边界 |
| [01-problem-analysis-and-current-state.md](improve-1/01-problem-analysis-and-current-state.md) | 当前代码与缺口，带代码锚点 |
| [02-optimization-plan-and-change-scope.md](improve-1/02-optimization-plan-and-change-scope.md) | 方案、实施阶段、接口与 Web 大致布局 |
| [03-reference-projects.md](improve-1/03-reference-projects.md) | 参考项目的会话移动、搜索规则与取舍 |
| [04-test-and-acceptance.md](improve-1/04-test-and-acceptance.md) | 测试与验收标准 |
| 05-implementation-acceptance.md | 预留：实施完成后记录验收，规划期不存在 |

02 是后续实施的依据，04 是验收依据。本次仅更新文档，不改业务代码。

## 相关文档

- [Web 会话侧栏整理（2026-09-30）](../2026-09-30-web-session-sidebar/README.md)：替换单目录分组，保留置顶等已落地能力。
- [全局单 Daemon](../2026-07-11-global-single-daemon/README.md)：沿用 `InstanceStore` 与请求级目录头。
- [多项目运行时](../../ohbaby-server/hono-app/04-multi-project-runtime.md)：实施后同步。
- [Web 架构](../../ohbaby-web/architecture.md)、[UI 组件约定](../../ohbaby-web/ui/components.md)。
- `daemon-workspace-scope` 已归档，不作为依据。
