# TUI Improve 1 子代理审查对齐

## 处理原则

- P1/P2 可见契约缺口进入本批次修复。
- 不扩大 SDK message part 结构；能在 TUI 渲染层合并的行为放在渲染层。
- `contextWindow` API 继续保持 session-only、memory-only cache；TUI 不本地估算 token。
- P3 主题问题做轻量 token 化，不引入完整主题文件/用户主题系统。

## 已采纳项

| 来源 | 问题 | 对齐结果 | 测试护栏 |
| --- | --- | --- | --- |
| Wegener | 真实 backend context window refresh 失败被吞成 `null`，TUI 不会 warning | `getContextWindowUsage()` 对已有 session 的 runtime 失败改为 reject；空 session/root 仍返回 `null`。`/status` 内部单独降级为 `Context unavailable`，避免命令整体失败 | `ui-inprocess.contract.test.ts`、`service.unit.test.ts` |
| Aristotle | `/status` panel 缺 Permission 行 | command data 新增 `permission`；panel 渲染 `Permission  auto / default` | `service.unit.test.ts`、`status-panel.unit.test.ts` |
| Aristotle | PromptDock/status bar 仍是旧 `status: idle \| session:` 结构 | 删除旧 Footer/StatusBar；PromptDock 统一显示 `auto · default · session_id`，右侧显示 context window usage | `app.contract.test.tsx`、TUI integration |
| Aristotle | 失败工具结果独立成 `Error ...` 行 | MessageList 合并相邻同 callId 的 failed `tool-result`，输出 `Edit src/app.ts permission denied`；成功结果仍隐藏 | `app.contract.test.tsx`、`tool-part.unit.test.ts` |
| Aristotle | 组件硬编码 Ink 颜色 | 新增 `tuiTheme`，组件颜色通过 token 引用；`dimColor` 语义 prop 保留 | `tsc -b`、rg 扫描 |

## 保留为后续债务

- `cli-highlight` 仍是后续增强项；第一版保留安全的 markdown/wrap 管线，不把语法高亮作为阻塞。
- 工具自动分组、recency 排序、自定义主题文件仍不纳入 v1。
- real Tavily smoke 断言已更新为新 UI 口径，但仍由 `OHBABY_RUN_REAL_TUI_TAVILY_SMOKE=1` 控制是否运行。
