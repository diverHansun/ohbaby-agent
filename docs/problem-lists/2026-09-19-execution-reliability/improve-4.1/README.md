# improve-4.1：会话切换、命名与命令反馈收尾

> 开启日期：2026-09-29。调研基线：`8d154655fc64c3ed377eca44c5053a885b966239`，本地分支 `codex/improve-4`。Pi `github-copilot/claude-opus-5.5 medium` 与子代理方案审查已完成，补齐意见后在本地 `codex/improve-4.1` 开始分批实施；这不是功能验收结论。

本阶段由 improve-4 验收后暴露的会话切换问题触发，属于返修补充阶段。用户随后加入 Bash 异常图标、主/子会话命名、slash command 残留反馈三项收尾要求，并追加移除子会话向下箭头、治理历史工具阶段缺失提示。它们与原切换问题共同构成本阶段范围，不替换原问题，也不重开停止、退出、冷恢复整体设计。

## 阅读顺序

1. [goal-duty](goal-duty.md)：本阶段目标、职责、边界与待讨论事项。
2. [00 已确认讨论](00-discussion.md)：用户明确提出的要求与前序约束。
3. [01 现状与问题](01-problem-analysis-and-current-state.md)：实际代码链路、已复现问题、静态风险、测试缺口。
4. [02 优化方案与改动面](02-optimization-plan-and-change-scope.md)：Stage 1–5、反馈归属、命名来源、跨层接口、迁移与回滚；整体待审查。
5. 03 暂不创建：本次以本仓库实际实现、已有 TUI 行为和用户截图为依据，没有新增外部项目调研。
6. [04 测试与验收](04-test-and-acceptance.md)：T01–T38，单元/集成/编译客户端/真实模型及对抗性审查；随方案一并审查。
7. `05-implementation-acceptance.md`：仅在本阶段实施后产生，当前不创建。

## 状态口径

- [improve-4 的历史验收](../improve-4/05-implementation-acceptance.md)记录当时执行过的测试；其通过不能覆盖本次新暴露的问题。
- 2026-09-28 切换诊断确认视图版本冲突、首次读取竞态和慢加载误标恢复。
- 2026-09-29 新增命名、图标和命令反馈的只读调研；运行了 54 项现有定向单元测试及调用生产函数的最小探针，没有调用真实模型或启动服务。
- 本阶段尚未修改产品代码、数据库或主/子执行提示词。未 merge、未 push。
- 用户已确认：不增加子代理命名请求；任务行描述每次任务、子会话名称稳定；slash 无用卡移除而有效结果与失败反馈保留。慢加载提示位置是方案默认建议，尚未单独确认。
- “最后收尾”表示本次范围意图，不表示尚未验证的边界已经通过。

## 关联文档

- [总路线](../README.md)
- [improve-4](../improve-4/README.md)
- [Web skill invocation](../../../ohbaby-web/ui/slash-commands/skill-invocation.md)
- [会话服务职责](../../../services/session/goals-duty.md)
- [system-prompt improve-3 已有边界](../../../core/system-prompt/improve-3/00-discussion.md)

本目录承接跨模块讨论与实施交接。未扩建另一套模块级规划目录，不回写旧轮次 05 为本次验收。正式实施前核对 00/02/04 与最新代码，并明确处理规划审查反馈。
