# improve-2：pi 源码借鉴与取舍

2026-10-02 调查；依据本机官方仓库 `/Users/hansun025/Projects/code-cli/pi`，commit `5fd446ca1843682e8da3fec4ceb71c42f56fbace`，`packages/tui/package.json` 标记 `@earendil-works/pi-tui@0.87.1`。这不是“线上最新版”声明，也不是本轮选定依赖版本。

## 3.1 可复用能力与实际边界

| 能力 | 源码事实 | ohbaby 取舍 |
| --- | --- | --- |
| Editor | 公共组件，自有 render/handleInput/宿主协议；非 React 组件，未提供现成 Ink adapter | 本轮不采用，继续修现有 reducer |
| 字素编辑 | Editor 按字素处理移动/删除，区分文本索引和显示宽度 | 借鉴原则；本轮用运行时 Intl.Segmenter，不深层导入 pi 私有 helper |
| 大段粘贴 | 大于 10 行或 1000 字符时可建 paste marker；getText 与 getExpandedText 不同 | 不照搬 marker，避免新建草稿序列化协议 |
| 编辑器状态 | setText 清 paste 映射且光标移到末尾；getText → setText 不能完整恢复内部粘贴状态 | 单纯替换 value/onChange 不能保住当前会话草稿与光标 |
| 提交 | Editor 展开内容并 trim，清空后调用 onChange/onSubmit | ohbaby 仍需自己的接收/未知回执语义，SDK 不代管业务可靠性 |
| 高度/按键 | 编辑高度和 Page 步长依宿主 rows，公开配置主要是 padding/候选数量；无完整状态快照和外部光标 setter | 与动态区预算、既有历史/候选 PgUp 行为有适配成本 |
| Markdown | 可独立 render(width)，公共主题接口；不要求启动 pi TUI renderer | 后续消息呈现阶段优先验证，而非为本轮提前安装 |
| 宽度/截断 | root index 公开 visibleWidth、truncateToWidth、wrapTextWithAnsi、sliceByColumn 等 | 后续与 Markdown 一起比较；与 Ink 的 tabs/部分 Unicode 宽度并非完全相同 |

源码入口：`packages/tui/src/index.ts`、`src/components/editor.ts`、`src/components/markdown.ts`、`src/utils.ts`；`packages/coding-agent/src/modes/interactive/components/custom-editor.ts` 是业务应用组件，**不属于 pi-tui SDK**。

## 3.2 为什么本轮不接 Editor

ohbaby 已有会话草稿、队列租约、未知结果重发以及自己的历史/命令补全。接 Editor 必须额外解决宿主 rows/requestRender、焦点和硬件光标、按键翻译、组件生命周期、完整草稿恢复。维持实例能保留更多内部状态，但又需要会话实例生命周期管理；导出文本再 setText 不能等价恢复。

这不是“pi Editor 不好”，而是当前目标下适配成本大于删除几段 reducer 的收益。它适合由 pi TUI 整体管理的界面；若以后真要整体迁移，再重新评估，不能把今天的小型适配器当成未来承诺。

禁止把访问私有成员、deep import、修改 node_modules 或维护 fork 作为默认接入方式。用户限制只引入 pi-tui，不因参考 CustomEditor 或工具 renderer 而引入 coding-agent。

## 3.3 调查验证及限制

此前只读调查使用临时隔离目录，没有安装项目产品依赖：

- 选定官方测试合计 422 个通过，涉及终端输入、Editor、渲染缩放、宽度与 Markdown。它们证明对应 pi 快照的行为，不证明 ohbaby 已通过集成。
- Markdown 在 8/16/40/80 列的 24 个静态样例经 Ink Box/Text 输出，没有观察到重复换行；未覆盖完整 App 流式、全部样式或真实 Ghostty。
- 宽度对比中，家庭 emoji、OSC 链接、tab、部分 Unicode 的现有实现/pi/Ink 结果不全相同。因此不能把一组函数全替换后仅跑 ASCII 用例。
- pi MainScreen 在修改视口上方旧行、前插、resize 时仍可能清屏并清回滚；相同帧和尾部更新的探针未清回滚。迁移不会自动解决 improve-1 的阅读问题。

没有完成真机 IME、复制和触控板验收，不将“官方测试通过”改写为产品完成。

## 3.4 对计划的影响

本轮采用字素边界、文本与投影分离、明确按键归属的思路；保持当前 UI 宿主。后续 D 若采用 Markdown，单独记录精确版本、公共 API、Unicode/ANSI/流式回归和实际删除的自研代码；以维护成本净减少判断价值，不以安装 SDK 当里程碑。

## 3.5 OpenCode 的 Todo 展示（2026-10-02 补充）

本地 OpenCode commit `16c56fe5ec`，`packages/tui/src/feature-plugins/sidebar/todo.tsx`：open 初值 true；show 条件是列表非空且存在非 completed 项；超过两项可点击标题折叠。`routes/session/index.tsx` 的 TodoWrite 则是工具结果中的列表，和 sidebar 常驻区是不同位置。

这份源码没有把侧栏 Todo 显隐直接绑定 run/interrupt，因此不能引用它证明“OpenCode 一停止就隐藏”。ohbaby 借鉴默认展开和信息收拢，具体采用本轮 frontend/04 §4 的运行生命周期建议。所有项完成但 run 仍在生成最终回复时，ohbaby 建议保留 completed/total 到 run 真正结束，与该 OpenCode 快照的条件不同。
