# Session View Reset 文档索引

## 目标

本目录记录 `/sessions` 切换后旧会话内容残留、同时又不能回退终端防闪烁修复的短期稳定方案。

短期方向:

- 继续保留 `CommittedTranscript` + Windows TTY guarded `<Static>`。
- 引入明确的“会话视图重置”原语，只在 session boundary 触发。
- `/sessions` 和 `/resume` 选择已有 session 时，先确认目标 snapshot，再清理 terminal surface 并渲染目标历史。
- `/new` 和 fresh startup 保持干净新画布语义。

长期锚点:

- 后续学习 Claude Code / opencode 的 managed viewport、route-scoped session view 和 virtual list 设计。
- 不把长期 viewport 重构塞进本轮短期修复。

## 文档职责

1. `01-current-problems-and-code-analysis.md`
   - 描述用户可见问题、根因、当前代码路径和必须守住的边界。
2. `02-short-term-design-and-implementation-plan.md`
   - 给出短期方案、事件顺序、失败处理和长期方案锚点。
3. `03-related-files-code-blocks-and-packages.md`
   - 列出涉及的 ohbaby 文件、参考项目文件、包影响和代码边界。
4. `04-testing-acceptance-review.md`
   - 定义自动测试、手工验收、daemon/session backend 回归和审查标准。
5. `05-doc-self-review.md`
   - 记录文档自审结论、风险检查和需要用户重点审核的决策。

## 审核建议

建议先看 `01` 和 `02`，确认短期方向是否符合产品预期；再看 `04`，确认测试和验收标准是否足够覆盖“不能把终端闪烁带回来”。

