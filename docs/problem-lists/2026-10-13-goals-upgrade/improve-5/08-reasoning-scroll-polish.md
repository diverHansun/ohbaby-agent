# improve-5 收尾：Thought 正文横向滚动

2026-10-16，基线 `5443bd93`。用户截图反馈：展开的 reasoning 横滑时，Thought 标题和箭头一起移走；长段落撑大滚动范围，滑到右侧只剩大片空白。本轮仅修正消息显示，不改模型文本、持久化或 goal 行为。

## 根因与修复

`MessageRow.tsx` 中的 summary 与 pre 共用 `.ohb-reasoning` details。旧 CSS 将 `overflow-x: auto` 设置在整个 details 上；其 `white-space: pre-wrap` 没有覆盖 pre 自身的浏览器默认 `white-space: pre`。普通中英文长段落因此完全不换行，最长行决定整个 details 的滚动范围。

把横向滚动交给正文 pre，明确使用 `pre-wrap`，保留原换行和缩进。普通段落自然换行；不可断长串仍可横向查看，不通过强制截断或省略丢失内容。正文宽度限于容器，`overscroll-behavior-x: none` 阻止边缘继续传递或回弹。Thought 标题和箭头留在滚动区外。

正文增加键盘焦点、可访问名称和聚焦描边，支持键盘横滑。live 与 saved reasoning 共用 `ReasoningDetails`，原折叠条件不变。未添加 JS 滚动控制或新组件；streaming text、tool panel 的既有滚动规则保留。不可断长串仍按最长行定义横向范围，其他较短行在该范围内留白属于保留原文本的正常表现。

## 验证与审查

- 基线定点测试 18 通过。新增 live/saved 正文独立键盘入口的两项测试先失败（tabIndex 为 -1），修复后通过；保留全文及原始缩进的断言。
- 全仓 unit：340 文件，4248 通过、2 跳过；消息展示 `run-process` integration：2 通过；MessageRow、ConversationStream、styles 定点复核：32 通过。
- Web 构建、CLI 资源打包、3 个改动文件 Prettier 与 diff 检查通过。独立子代理只读复审未发现剩余问题。
- 内置浏览器使用真实 daemon/SQLite 隔离 fixture，包含完成态和无 endReason 两个会话，正文含长中英文段落、358 字符 ASCII 长串、空行、缩进与 END 标记。没有模型请求；无 endReason 是静态初始状态，不冒充真实流式端到端测试。
- 桌面 1280×850 复现旧版：details 横移 2050px，summary 的 x 从 295.5 变为 -1754.5。修复后相同横滑只移动 pre，details.scrollLeft 保持 0、summary.x 保持 295.5；继续向右滑动仍停在正文上限 2050px。滑到右端仍可点击标题收起。
- 手机 390×844 验证默认折叠、键盘展开、普通段落换行、正文方向键横滑及返回左端；正文 scrollLeft 可由 40 回到 0，标题 x 保持 80，页面 scrollWidth=390。应用控制台无 warning/error。

截图保存在本地视觉产物目录：`reasoning-before-scroll.jpg`、`reasoning-after-desktop.jpg`、`reasoning-right-boundary.jpg`、`reasoning-after-mobile.jpg`。验收后停止临时服务并清理隔离数据库，关闭临时标签页并恢复浏览器视口。测试脚本与截图不进入产品仓库。

## 提交与集成

`0f278be1` 提交局部样式、正文键盘入口与测试。提交检查指出新增测试的两处非空断言不符合仓库规范，已改为可选访问并复跑 MessageRow 3 项测试；全仓 lint 最终为 0 errors / 122 既有 warnings，typecheck 通过。

本记录单独提交后，将 improve-5 本地 fast-forward 合入 `codex/goals-upgrade` 与 `main`，不 push。
