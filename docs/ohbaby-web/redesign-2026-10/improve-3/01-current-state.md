# improve-3 · 1. 现状

> 假设 improve-2 已完成：全局侧栏、草稿首发和按会话目录连接已经可用，`api/daemon/global-sessions.ts` 已有改归属和搜索的调用。路径相对 `apps/ohbaby-web/src/`。

- 会话菜单是 `ui/session/SessionActionsMenu.tsx`（300 行），自己实现弹出和定位，只有置顶、导出、归档，没有项目归属操作。improve-1 已经提供通用 `Menu`。
- Web 没有全局搜索界面；后端 `GET /v1/sessions/search` 已经可用（覆盖全部未归档根会话的标题和可见正文）。
- 改归属的后端接口 `POST /v1/sessions/:id/project` 已经可用，运行中也允许调用，下一轮在新目录运行。
