# 组件契约

## 1. 分层命名

只增加会话 feature 组件，不建立通用 primitive 库。DOM 动画不能反向依赖服务端。

## 2. 索引

| 单元 | 职责 |
|---|---|
| SessionSidebar | 列表、排序、pin 偏好装配、菜单目标、重排位置 |
| SessionRow | 标题/日期、实心 pin/…、真实溢出测量及标题动画 |
| SessionActionsMenu | 两项菜单、定位、焦点/关闭，portal 避免裁切 |
| session-pins / hook | scope、校验、存储、跨标签页通知、排序 |

## 3. 关键契约

Row 输入 session、active、disabled、pinned、menuOpen、reordering；输出 select/unpin/openMenu。按钮互为兄弟，不嵌套 button。只用于会话，不包装全项目导航。
Menu 输入目标标题/pinned、位置、返回焦点元素、动作回调；不直接调用 HTTP 或存储。语义 role=menu/menuitem，装饰图标 aria-hidden。
Sidebar 的 archive 回调返回 Promise<boolean>：true 才清 pin；取消/错误 false。切换项目不能改变进行中的归档目标。

## 4. Pattern

右键/… 是同一菜单的入口模式，不是两套菜单。重排 hook 只解决本列表，不抽象动画系统。
