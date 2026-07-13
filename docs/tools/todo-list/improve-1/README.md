# TodoList improve-1

本目录记录 TodoList 从“已有后端工具雏形”走向 Web/TUI 可交付模块前的开发计划。它是一次开发前 problem-list，不替代上一级七份模块设计文档；最终契约以 `docs/tools/todo-list/` 下的文档为准。

## 文档索引

| 文档 | 用途 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结已确认决策、未决事项和实施边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 记录代码现状、问题及根因 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 给出分阶段方案、改动面与提交计划 |
| [03-reference-projects.md](./03-reference-projects.md) | 说明 Kimi Code、OpenCode、Claude Code 的采用与舍弃 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 定义自动化测试、真实浏览器/TUI 验收和退出条件 |

## 当前阶段

- 状态：开发前文档对齐。
- 本轮范围：只修改设计与实施计划文档并做交叉自检。
- 下一阶段：用户确认文档后，新建 `codex/todo-list` 临时分支实施。
- 合并策略：实现、测试、子代理审查和分批提交完成后停在临时分支，不自动 merge。

## 推荐阅读顺序

1. 先看 `00-discussion.md`，确认产品决策没有偏差。
2. 再看 `01` 与 `02`，确认问题范围和实现顺序。
3. 最后看 `03` 与 `04`，确认借鉴依据和验收强度。
