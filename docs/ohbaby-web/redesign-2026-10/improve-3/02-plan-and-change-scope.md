# improve-3 · 2. 方案与改动面：会话菜单与搜索

> 依据：[03 §4.4–§4.5](../03-ui-layout-and-style.md)（侧栏与菜单线框）、[04 §2.4–§2.5](../04-interaction-and-states.md)（搜索、菜单状态）、[05](../05-components.md) 的 `Menu`、`SessionMenu`、[06 §3.3](../06-data-api-and-state.md)（搜索并发）。现状见 [01](01-current-state.md)，验收见 [04](04-test-and-acceptance.md)。

## 目标

在侧栏里完成会话整理和查找：移入、换项目、移出、置顶、导出、归档，以及跨全部历史的搜索。

## 范围

做：

1. **会话菜单**：`ui/sidebar/SessionMenu.tsx` 用通用 `Menu` 改写 `SessionActionsMenu`。一级菜单：Pin / Unpin、Move to project…、Export…、分隔线、Archive；Move to project… 和 Export… 在原位置换成二级列表（不做二级子菜单，02 §1）。右键会话行打开同一菜单。
2. **改归属**：调用 `POST /v1/sessions/:id/project`，等服务端返回后再移动行；运行中允许，不加提示（D16）。成功后当前会话只更新缓存的请求目录。
3. **项目菜单**：项目分组标题的 `[..]`：Hide project（沿用现有接口）；成功后同时刷新项目和会话列表，清除该组缓存行，当前主区保持打开。
4. **侧栏搜索**：`ui/search/SidebarSearch.tsx`，Search 格展开搜索框，结果替换会话树；防抖 250ms，新请求中止旧请求；标题命中在前，正文命中显示片段并高亮（片段按纯文本处理）；`Cmd/Ctrl + K` 打开；Esc 一次只关一层（04 §3）。
5. **归档**：行先消失，失败时恢复并显示右上角错误通知；成功不提示。

当前会话只在归档成功后回草稿，失败保留原对话；其他目录的归档与导出不得改变当前会话或 SSE。各批最终行为以这份文档和 06 的刷新规则为准。

不做：重命名会话、拖拽排序、归档列表浏览（00 Non-goals）。

## 改动面

| 目录 | 新增 | 修改 | 删除 |
|---|---|---|---|
| `ui/sidebar/` | `SessionMenu.tsx`、`ProjectMenu.tsx` | `Sidebar`、`SessionRow`（右键、moving 状态） | `ui/session/SessionActionsMenu.tsx` |
| `ui/search/` | `SidebarSearch.tsx`、`useSessionSearch.ts`（防抖与中止，纯逻辑在 `.ts`） | — | — |
| `runtime/` | — | `global-layer.ts` 暴露搜索和改归属 | — |
| `store/` | 搜索切片 | 接入全局状态入口；不把查询并发逻辑堆入 `store.ts` | — |

## 风险

| 风险 | 应对 |
|---|---|
| 快速输入时旧结果覆盖新结果 | 只认最后一次查询，旧请求中止（06 §3.3） |
| 菜单的键盘和焦点细节回归 | `Menu` 已在 improve-1 有单测；本批补菜单二级列表的键盘测试 |
