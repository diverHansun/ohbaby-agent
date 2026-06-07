# Problem And Scope

## 背景

Improve 1/2 已经完成了 AppShell、PromptDock、context window usage、status panel、工具行、reasoning 折叠、prompt 光标、基础闪烁缓解等改造。当前剩余的核心问题分成两类：

1. 历史用户 prompt 可识别性不足  
   目前历史用户消息主要依靠左侧 dim 竖线区分。长 prompt、多段中文、URL 或命令混在 transcript 中时，用户难以快速定位自己的输入。

2. transcript 动态区边界不清  
   当前 `MessageList` 直接渲染 `messages.map(...)`。任何 streaming delta 都会让消息列表所在 React 子树重新计算。虽然 improve-2 已经降低 prompt 输入闪烁，但 transcript 和 live streaming tail 还没有结构性隔离。

## 参考项目结论

### opencode

opencode 的关键点不是某个颜色或卡片样式，而是边界清晰：

- Prompt 是独立 dock，当前输入有背景块和状态行。
- 历史内容与输入区层级不同，当前输入最突出。
- OpenTUI 渲染模型支持更细粒度的局部刷新，避免所有内容跟着输入重绘。

本项目仍使用 Ink，所以不能照搬 OpenTUI，但可以学习其结构边界。

### kimi-code

kimi-code 的关键点是每个 message 组件负责自己的 `render(width): string[]`：

- 用户消息有明确 bullet / 缩进 / role color。
- assistant markdown 与用户输入有稳定缩进差异。
- 组件知道自己占多少行，便于后续 viewport 和滚动策略。

本项目应学习它的“消息行模型明确”，而不是迁移 pi-tui。

## 本阶段范围

纳入 improve-3：

- 新增 transcript 分层模型：committed transcript + live tail。
- 新增或调整 `MessageList` 层级，使稳定历史和当前流式尾部职责分离。
- 历史用户消息使用淡色块包裹，保留左侧轻 accent。
- 明确 active session 切换时的 reset/key 策略，避免旧 session 内容残留。
- 增加顺序验收：用户消息、assistant text、tool call/result、后续 text 必须按 UI 语义顺序显示。
- 增加 selector 粒度，减少 app 根组件对整份 state 的订阅。
- 为后续 `<Static>` 或真正 scrollback 留出边界，但本阶段不强行启用。

不纳入 improve-3：

- 不实现完整虚拟列表。
- 不实现自定义滚动条。
- 不做历史搜索。
- 不迁移 OpenTUI 或 pi-tui。
- 不把所有历史消息做强卡片化。
- 不改变 SDK 消息协议，除非测试证明当前协议无法表达正确顺序。

## 成功标准

- 历史用户 prompt 在长 transcript 中能一眼定位。
- 当前 PromptDock 仍然是最强视觉焦点。
- streaming assistant 输出时，不需要重绘无关 Header/Logo/Prompt 的可见内容。
- tool line 的 running spinner 和 completed summary 不造成布局跳动。
- active session 切换后，不出现其他 session 的旧消息。
- 单元测试、集成测试、TUI E2E、真实 API key 测试通过。
- 子代理审查后无阻塞级风险。

