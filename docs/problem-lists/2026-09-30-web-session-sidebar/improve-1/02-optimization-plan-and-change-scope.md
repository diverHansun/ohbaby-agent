# 优化方案与改动面

## 方案与取舍

会话索引 + 按服务/项目隔离的浏览器 pin → 侧栏派生排序 → 独立行/菜单。后端 DTO、聊天内容及更新时间不修改。

| 决策 | 选择 | 取舍 |
|---|---|---|
| 持久化 | 版本化 localStorage，按项目一个 key | 不上服务端；清站点数据或换 origin 不迁移 |
| 菜单 | 小型专用 portal 菜单，两个入口一套动作 | 不引入 Radix/全局菜单框架，必须处理焦点与边缘 |
| 动效 | DOM 前后位置 + WAAPI transform | 不动画布局，不引入 motion 库 |
| 样式 | 沿用现有字体/侧栏，局部语义变量 | 不重建全站 design system |

## 轮内 Stage

1. 偏好与行为：`ui/session/session-pins.ts` 负责校验/排序/存储，hook 提供渲染订阅；写真实风险测试。DoD：刷新/项目隔离/更新消息不改 pin 顺序。
2. 行与菜单：改 `SessionSidebar.tsx`、增加 `SessionRow.tsx`、`SessionActionsMenu.tsx`，`SessionScreen.tsx` 归档返回成功与否；按 [前端交互](frontend/04-interaction-and-states.md) 完成。DoD：菜单、pin、archive 均不误选行。
3. 样式与动效：`layout.css` 清除旧圆点/footer/归档样式，增加 feature 样式及导入；按 [前端视觉](frontend/03-ui-layout-and-style.md) 检查。DoD：可见移动、长标题、菜单边界及 reduced motion。
4. 子代理代码审查、浏览器验收，写 05 和 frontend/09。修复实际发现后复验；不 commit。

## 按包改动面

只改 `apps/ohbaby-web` 和关联文档。runtime 可提供只读可选 serverUrl 标识给偏好 scope，旧测试 runtime/嵌入方省略时按当前 origin。SDK/server/core/TUI 不改。

## 协议与错误

没有新网络接口/持久化迁移。归档仍走现有 Promise，只在成功后清理发起操作时的项目 pin；用户切换项目不应清理新项目。存储异常当前页仍可操作、显示简短保存失败文字，无成功 toast。

## 风险与回滚

滚动使用 overflow-anchor:none，焦点恢复用 preventScroll；菜单离开页面/切项目关闭。动画中继续操作以当前视觉位置衔接，不阻塞输入。加载为空不能清 pin。两标签页 storage 事件同步，写前重新读取；严格同时写同一项目采用最后写入者胜，不承诺分布式合并。
回滚本轮 Web/UI 文件即可；独立版本 key 可忽略，无服务端迁移。

## 边界

遵循 [00](00-discussion.md)。不扩展 Rename、恢复、拖拽、触屏专项、成功提示。不增加全量符号清单。
