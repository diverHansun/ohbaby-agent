# Web 对话流式跟滚 + Composer 打字机占位 + IME Enter 守卫

> 状态：**文档已终审对齐（2026-07-13，含 Phase C IME）。** 可按 `02 + 04` 在独立实施会话动手。

## 1. 议题

Web 端对话在 agent **流式输出**时，消息区不会随内容增长自动贴底滚动，用户必须手动滚轮追读。Composer 默认占位文案仍是 `"Message ohbaby..."`，且为原生静态 `placeholder`，无法承载品牌化打字机动效。另外，中文等 IME 组字时按 Enter 本意是确认候选上屏，却被当成「发送消息」抢走。

本批只改 **ohbaby-web 前端交互与呈现**：补齐 stick-to-bottom 跟滚、替换 idle 态打字机占位，并在 Composer `onKeyDown` 增加 IME 组字守卫。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结已确认的产品行为与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 以当前代码为基线的问题与根因 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约：方案、改动面、分阶段 DoD |
| [03-reference-projects.md](./03-reference-projects.md) | ChatGPT / Claude / Cursor 等产品的 adopt / adapt / reject |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、手工/浏览器验收与发布门 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

## 3. In scope

- `.ohb-stream` 在流式输出 / 消息增长时默认 stick-to-bottom 自动贴底。
- 用户主动上滚离开底部附近时，**暂停**自动滚，不拦截滚轮/触控板。
- 用户再滚回底部附近时，**恢复**自动滚。
- 切换 session / 发送新 prompt 等「应回到底部阅读」场景，重置为 stick。
- 替换 idle 默认占位文案为冻结三句（见 00：`Ask Lychee anything…` / `Describe the change you want…` / `Plan the next step…`）；空且未聚焦时显示打字机特效 overlay。
- 聚焦或已有输入时隐藏打字机；`daemon unavailable` / `run in progress` 仍用静态文案（无打字机）。
- **IME 组字中**：Enter / 相关快捷键不发送、不执行 slash；不 `preventDefault` 抢 IME 确认上屏（见 00 / Phase C）。
- 限定在 `apps/ohbaby-web` UI；补充针对性 unit 测试与手工验收。

## 4. Out of scope

- Daemon / SSE / `eventReducer` 流式协议变更。
- TUI composer 占位、TUI 滚动或 TUI IME 行为。
- Markdown 渲染性能优化、虚拟列表。
- **Jump to latest / 「新消息」悬浮跳转按钮**（本批明确不做；可后续批次）。
- 改 Enter/Shift+Enter 的产品语义（非组字时仍 Enter 发送）。
- `prefers-reduced-motion` 以外的无障碍专项重构。
- 像素级品牌动效系统、多语言 i18n 框架。

## 5. 与现有文档的关系

| 文档 | 关系 |
|------|------|
| [ohbaby-web](../../ohbaby-web/README.md) | Web 能力权威仍有效；本批只补交互缺陷，不改导航/并发模型 |
| [workspace-prompt-concurrency](../2026-07-12-workspace-prompt-concurrency/README.md) | Queue / pending prompt 投影已落地；本批跟滚需覆盖 pending + streaming 场景，但不重做队列 |
| [opencode-style-web-navigation](../2026-07-11-opencode-style-web-navigation/README.md) | 三栏布局与 `.ohb-stream` 滚动容器约定保持；本批不改 layout 契约 |

## 6. 开发闸门

1. [x] 用户审阅并确认本目录 00–04（占位文案：`Ask Lychee anything…` 等三句；本批不做 Jump；near-bottom `80px`；**Phase C IME Enter 守卫**）。
2. [ ] 按 02 完成 Phase A（跟滚）、Phase B（打字机占位）、Phase C（IME Enter 守卫）。
3. [ ] 按 04 完成单测与手工/浏览器验收。
4. [ ] 独立验收会话对照 02/04 出具结论（可选）。
