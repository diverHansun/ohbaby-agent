# 问题基线与当前状态

基线：2026-09-30，main `b13c9376`，启动时工作区干净。下文描述改造前现状。

## 问题与七维诊断

| 维度 | 证据与现状 | 缺口 |
|---|---|---|
| 目标职责 | `apps/ohbaby-web/src/ui/session/SessionSidebar.tsx` 渲染项目会话索引 | Recent 没有时间筛选，footer 只有计数，增加杂讯 |
| 架构 | `SessionScreen.tsx` 注入操作；`SessionSidebar.tsx` 负责排序/列表 | 单行还无独立菜单、标题滚动、重排行为 |
| 数据 | `packages/ohbaby-sdk/src/permission.ts:UiSessionIndexEntry` 没有 pin | 置顶应是 Web 偏好，不改变共享 DTO |
| 数据流 | `SessionScreen.archiveSession → runtime.archiveSession → client/http` | 当前归档回调不把成功/取消结果返回侧栏，不能可靠清理 pin |
| 用例 | `SessionSidebar.sortedSessions` 按 updatedAt 降序；归档单独按钮 | 不支持 pin/unpin 或右键菜单 |
| 非功能 | `ui/styles/layout.css` 固定 34px 归档栏、ellipsis；原生 Select title 提示 | 平时浪费宽度、提示挡字，暂无长标题动效及菜单边缘处理 |
| 测试 | `ui/App.unit.test.tsx` 已验证归档确认/取消不选行 | 缺置顶持久化隔离、菜单键盘、重排/长标题浏览器证据 |

## 文档与实现

`docs/ohbaby-web/ui/components.md` 规定项目轨、侧栏展开和 New session，但未定义本轮 pin/menu。
`docs/ohbaby-web/ui/README.md` 引用旧导航目标；历史 HTML 不是本轮交互权威。完成后增加本议题链接，避免两套要求并行。

## 跨模块边界

归档后端在 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts:archiveSessionInternal` 更新 status 为 archived，并从活动投影移除；归档当前聊天会按既有逻辑选择剩余会话。只有 Pin/Unpin 承诺保持 active session。
浏览器现有 `api/daemon/navigation-state.ts` 使用 localStorage；可沿用技术，但 pin 独立存储、不混入导航记录。

## SWE 判断

现有服务端数据与 UI 分层可继续使用。只增加行、菜单和本地偏好边界，复杂度与实际交互匹配。避免新增通用菜单框架、动画依赖、同步协议和 TUI 接口；风险集中在异步归档跨项目、DOM 焦点和存储异常，分别在 02/04 处理。
