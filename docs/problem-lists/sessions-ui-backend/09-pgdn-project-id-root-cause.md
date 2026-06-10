# 09 - Sessions PgDn 仅显示 6 条的根因与修复对齐

> 创建日期: 2026-06-10
> 状态: 已确认根因，进入实现

---

## 1. 现象

用户在 `/sessions` 中看到 footer 为：

```text
showing 1-6 of 6 · pgup/pgdn · ↑↓
```

按 `PgUp/PgDn` 只能在这 6 条会话中跳转，无法看到同项目下剩余会话。

---

## 2. 前端结论

`SessionDialog` 的分页是纯前端本地切片：

- `SESSION_PAGE_SIZE = 10`
- `visibleOptions = options.slice(pageStart, pageEnd)`
- `PgDn` 等价于把 `selectedIndex` 增加 10，并 clamp 到 `options.length - 1`
- 它不会主动向后端再请求下一页

因此 `showing 1-6 of 6` 表明 TUI 收到的 `interaction.options.length` 就是 6。PgDn 没有第二页可翻，是后端候选 sessions 已被过滤成 6 条后的结果。

---

## 3. 后端数据流

`/sessions` 当前路径：

1. `handleSessionParent()` 调用 `listSessions(options)`。
2. `listSessions()` 读取 `options.sessions.listSessions()`。
3. `ui-inprocess.ts` 的 `listSessionsFromState()` 解析当前 `projectRoot`。
4. 当前实现再通过 `Project.fromDirectory(projectRoot)` 算出 `project.id`。
5. 调用 `sessionManager.listByProject(project.id, { status: "active" })`。
6. 再过滤 `!isSubagent` 和 `sameProjectRoot()`。

问题在第 5 步：如果同一个 `projectRoot` 下的历史 sessions 存在多个 `project_id`，旧 `project_id` 的会话在 SQL 查询阶段已经被排除，后续 `sameProjectRoot()` 无法恢复。

---

## 4. 本机元数据证据

只查询 session metadata，未读取消息正文。

默认 DB 路径：

```text
C:\Users\Huang junzhe\AppData\Roaming\ohbaby-agent\ohbaby-agent.db
```

当前项目路径：

```text
D:\Projects\Code-cli\ohbaby-agent
```

统计结果：

```text
total sessions: 20
active primary sessions under current projectRoot: 18
active child/subagent sessions under current projectRoot: 2
```

18 条 active primary sessions 分布在两个 `project_id`：

```text
a6e02732abca778f3ae0fbbd00d61c622eefc306 | 12
34110ec499fc6fbd4f77f1ab25a8fd8cbce7f865 | 6
```

当前 Git 仓库 root commits：

```text
34110ec499fc6fbd4f77f1ab25a8fd8cbce7f865 2026-05-30 untracked files on mvp: da8cdbe docs(tool-scheduler): align permission state terminology
a6e02732abca778f3ae0fbbd00d61c622eefc306 2026-02-05 first commit
```

`Project.fromDirectory()` 使用 `git rev-list --max-parents=0 --all`，排序后取第一个 root commit 作为 `project_id`。当前排序后的第一个 root commit 是 `34110ec4...`，所以 `/sessions` 只显示这组 6 条。

---

## 5. 根因

`project_id` 当前依赖 Git root commit。仓库出现多个 root commits 后，排序第一的 root commit 可能变化，导致同一个 `projectRoot` 的历史会话被拆到不同 `project_id` 下。

`/sessions` 的产品语义已经确认是“当前 project 的 sessions”，而 ohbaby-agent 也是按当前项目根目录启动。因此用户可见列表不应只由 Git-derived `project_id` 决定。

---

## 6. 修复方案

采用 project root 优先的 metadata 查询：

1. 在 session store / manager 增加 `listByProjectRoot(projectRoot, options)`。
2. 该方法按规范化后的 `projectRoot` 聚合 sessions，支持不同斜杠、尾斜杠和大小写差异。
3. `/sessions` 调用 `listByProjectRoot(currentProjectRoot, { status: "active" })`。
4. UI backend 继续过滤 primary sessions：`!session.isSubagent`。
5. 排序保持 `updatedAt DESC, createdAt DESC`。
6. snapshot fallback 路径继续在可用 `UiSession.projectRoot` 范围内过滤和排序。

预期修复后，本机当前项目会显示：

```text
showing 1-10 of 18
```

按 `PgDn` 后显示：

```text
showing 11-18 of 18
```

2 条 child/subagent sessions 仍按既定设计不显示。

---

## 7. 验收测试

新增或更新测试：

- session store unit test：同一 `projectRoot`、不同 `projectId` 的 active sessions 均被 `listByProjectRoot()` 返回。
- database store integration test：SQLite 持久化路径同样按 `projectRoot` 聚合，并在过滤后应用 `limit`。
- ui-inprocess contract test：`/sessions` 显示同一项目根目录下不同 `project_id` 的 active primary sessions，并排除 archived、subagent 和其它 projectRoot。
- TUI contract/integration 现有 PgDn 测试继续证明：当 options 超过 10 条，PgDn 可进入第二页。

---

## 8. 自审

- 与“默认只显示 active sessions”一致：查询继续传入 `status: "active"`。
- 与“暂不考虑 archived 前端接口”一致：archived 不进入 `/sessions` 默认列表。
- 与“当前 project sessions”一致：当前 project 以启动根目录 `projectRoot` 为用户可见边界。
- 与非 git 目录隔离修正一致：非 git 项目共享 `global` project id 时，也依赖 `projectRoot` 隔离。
- 不改变 UI snapshot 恢复上限，也不重新使用 `getRecent()` 作为 `/sessions` 数据源。
