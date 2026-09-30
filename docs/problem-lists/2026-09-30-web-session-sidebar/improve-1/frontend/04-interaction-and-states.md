# 交互与状态

## 1. 组件状态

| 状态 | 表现与行为 |
|---|---|
| 默认 | 普通行无圆点/操作；置顶行标题左侧一个实心 pin |
| hover/focus-within | … 立即显示并持续；pin 可点、其余行主体选择聊天 |
| menu-open | 行 hover 背景与 … 保持；标题停止；菜单 Pin/Unpin 与 Archive |
| disabled | 沿用连接禁用；动作不可提交，不做 hover 动效 |
| 重排 | 关闭菜单，标题复位；按当前视觉位置衔接 transform，其他行让位 |
| 减少动态效果 | 无位移/标题滚动，所有动作仍可用 |

## 2. 侧栏状态矩阵

| 页面状态 | 表现/操作 |
|---|---|
| 已加载 | pin 时间倒序在前，普通更新时间倒序在后，稳定 ID 平局排序 |
| 空 | No sessions yet，已有 New session 作为下一步入口 |
| 加载/重连/局部刷新 | 沿用 store 和 composer.disabled；不根据暂时缺失的索引删除 pin |
| 保存失败 | 当前页面保持 pin，显示 Pins could not be saved. Changes last until refresh. |
| 归档失败 | 原 pin 保留；现有错误区域显示原因 |
| 切项目/折叠 | 关闭菜单并取消动画，读取对应 scope 的 pin |
| 无权限/不存在 | 无新增权限页，沿用原会话加载状态 |

## 3. 交互语义

- Pin/Unpin 不选择聊天；最后一次置顶最前。消息更新不改变 pin 顺序。Unpin 回普通 updatedAt 顺序。
- … 和右键共用菜单、相同动作。… 菜单锚定按钮，右键锚定指针；先翻转到可容纳的一侧，再夹紧在 viewport 8px 边界内。点击外部、窗口失焦、滚动/resize、Esc 关闭。菜单内方向/Home/End 导航，Enter/Space 执行；Tab 关闭后自然离开，不困住焦点。Esc/执行后恢复到对应行触发器（preventScroll），直接 Unpin 后焦点落该行主按钮。
- 打开菜单、点 pin/菜单项都不冒泡为选择会话；保留本次发起的 sessionId/scope，不依赖操作完成时的当前项目。
- hover 600ms 后只有标题真实溢出才缓慢滚到末尾并停住；离开复位。菜单/重排停止并复位；结束后若仍 hover 再计时。标题滚动与整行 transform 在不同元素。
- 列表不强制滚顶；关闭滚动锚定。动画仅裁剪显示 viewport 内段，不弹“已置顶”。快速操作不排队，续接当前位置。
- Archive 保留确认框。成功后清理发起 scope 的 pin；取消/失败保留。归档当前聊天后的服务端选中变化沿用既有行为，不属于 Pin 的不切换承诺。

### 审核补充

… 默认 opacity:0，保持键盘可达；有 aria-haspopup/expanded。ContextMenu 键或 Shift+F10 等价右键。菜单打开聚焦首项。归档移除行后焦点回同位置下一行、无行则 New session。
标题在 hover 后的实际宽度测量；静止使用 inline 文本直接裁切，不显示标题省略号，避免与「…」操作按钮混淆。动画时内层可 transform，裁剪区保留 clip 并增加边缘淡出，切换不得跳变。保持恒速，不加十秒上限强行加速。
重排前采集旧视觉 rect，新 DOM 提交后 layout effect 测新 rect；先采集正在运行的 transform，再取消旧动画。焦点恢复在提交后执行 preventScroll；JS 显式检查 reduced-motion。

焦点恢复只对仍连接 DOM 且属于当前项目的目标执行；归档发起时关闭菜单并恢复焦点，完成后仅当焦点仍依赖被移除行时回下一行/New session。已切项目或用户已移开焦点时，不抢焦点。
