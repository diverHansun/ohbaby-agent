# 参考项目与取舍

## 来源与可核实锚点

本地源码均为只读调研。用户 Codex/Cursor 截图是视觉方向，不推断未提供的交互。

| 项目 | 路径（相对所列项目根） | 借鉴 |
|---|---|---|
| deepseek-harness | `packages/client/ui-workspace/src/client/rows/Rows.module.css:255` | hover/menuOpen 才显操作，菜单开启时保留行背景 |
| deepseek-harness | `packages/client/ui-workspace/src/client/rows/Rows.tsx:52` | 实测溢出、恒速移动、末尾停止，离开复位 |
| deepseek-harness | `packages/client/ui-primitives/src/Menu.module.css:6` | 紧凑白色卡片、固定 portal、约 34px 项高 |
| ZCode | `packages/ui/src/components/ui/context-menu.tsx:25` | 轻边框、小圆角、16px 图标和 8px 图文间距 |
| ZCode | `packages/ui/src/TaskListItemContextMenu.tsx:63` | 多入口共用 TaskActionMenuContent，行为不分叉 |
| ZCode | `packages/ui/src/TaskListItem.tsx:490` | pin 阻止事件传播，聚焦也显示动作 |
| kimi-code | `apps/vscode/webview-ui/src/components/ui/context-menu.tsx:41` | 菜单高度受可用视口限制，4px 内边距 |
| codex | `/Users/hansun025/Projects/code-cli/codex` | 未找到桌面侧栏 TSX/CSS；只采用用户截图，不宣称提取了桌面实现 |

前三个项目根依次为 `/Users/hansun025/Projects/code-cli/deepseek-harness`、`/Users/hansun025/Projects/code-cli/ZCode`、`/Users/hansun025/Projects/code-cli/kimi-code`。

## 采用、调整、不采用

采用紧凑菜单、真实溢出判断、共享动作入口、焦点与指针一致反馈。ohbaby 已有 13px 列表文字，菜单保持相近比例；两项卡片宽度可从约 176px 调整，不复制高分辨率截图的物理尺寸。
恒速标题滚动采用本轮 600ms/24px 每秒初值，不照搬其他项目 30px 每秒。列表位移动画使用原生 WAAPI。
不引入参考仓库的 Radix、子菜单、快捷键栏、Fork/Edit Icon/Copy/Delete、大型 token 框架和 RAF 跑马灯实现。

## 对方案影响

[02](02-optimization-plan-and-change-scope.md) 的专用菜单/无新增依赖保持；视觉值见 [frontend/03](frontend/03-ui-layout-and-style.md)。用户明确要求优先于参考。
