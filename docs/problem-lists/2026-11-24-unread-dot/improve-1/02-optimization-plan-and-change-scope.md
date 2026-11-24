# 2. 优化方案与改动面

> 本文交给实施会话。Web 路径相对 `apps/ohbaby-web/src/`，后端路径相对仓库根目录。

## 2.1 方案总览

后端在全局列表的每一项上加一个字段：这个会话最近一次"有结果"的轮次是什么时候结束的。前端定时重读列表，再拿这个时间和本地记下的"上次看到的时间"比，晚了就亮蓝点。

```
后端 run_ledger ──MAX(ended_at)──▶ GET /v1/sessions 每项带 lastTurnEndedAt
                                         │ 每 15 秒、获得焦点、页面可见时重读
前端 localStorage { since, seen[id] } ──▶ lastTurnEndedAt > (seen[id] ?? since)
                                         │ 且不是当前会话
侧边栏前导列：移动中 > 运行中 > 等待审批 > 未读（#60A5FA 圆点）
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| B1 后端给什么 | `UiGlobalSession.lastTurnEndedAt?: string`（ISO）。取该会话主轮次（`context_scope_id IS NULL`）里 `status` 是 `succeeded` 或 `failed` 的最大 `ended_at`；没有就不带这个字段 | 语义正好是"有新结果了"：成功、出错都算，用户停止和崩溃恢复（`interrupted`）不算，和 00 §0.4 一致。字段可选，旧前端和 TUI 不受影响 | 用 `updatedAt`：改标题、移动也会变；用 `stats.lastMessageAt`：用户发消息、点停止也会变 | 每页多一个子查询。先按游标和 `LIMIT` 切出这一页，再只对页内的行算子查询（实施时按审查意见改，见 §2.8） |
| B2 前端怎么及时知道 | 页面可见时每 15 秒重读一次全局列表；原有的焦点、可见性、重连时重读不变 | 改动最小，跨工作区一视同仁，复用 `GlobalLayer.refresh()`：它和焦点触发共用，重复触发会合并成一次，也带着 `reloadSessions` 的防覆盖逻辑。未读是"你不在场时发生的事"，晚十几秒亮起没有影响 | daemon 新增跨实例事件流：要写订阅、鉴权、重连、补发，和"微调后端"的预期不符。三个参考项目里两个用推送，留给"跨会话等待状态"议题，那里需要实时；到时可以把定时重读换成事件触发 | 页面开着时每 15 秒一次刷新：读一次工作区列表，再从首页起把已加载的会话页重读一遍（每页 100 条，点过 Show more 就不止一页）；最多晚 15 秒亮 |
| B3 搜索结果 | 不带新字段 | 搜索走另一条 SQL，搜索列表也不显示状态点 | 给搜索也加子查询：没有用处 | 无 |
| F1 已读状态存哪 | localStorage，key 是 `ohbaby.web.session-seen.v1:[服务器 origin]`，值是 `{ since, seen: { 会话 id: 毫秒时间 } }` | 用户选定（00 C3）；和置顶的 key 规则一致 | 存后端：要加表和接口 | 不跨设备；被删除的会话会在 `seen` 里留下几十字节，不清理 |
| F2 首次使用 | 第一次读不到 key 时，`since` 记为当时的 `Date.now()` 并写入 | 已有会话的结束时间都早于 `since`，不会全部亮起 | 把每个已有会话的结束时间逐个写进 `seen`：每次重读都要写存储 | `since` 用浏览器时钟、结束时间用服务器时钟，两边差几秒只影响第一次使用前后那几秒 |
| F3 未读的判定 | `lastTurnEndedAt` 存在，且不是当前会话，且 `Date.parse(lastTurnEndedAt) > (seen[id] ?? since)` | 一条式子，不需要额外状态 | 无 | 无 |
| F4 什么时候记为已看 | 页面可见时，当前会话的回复结束时间一出现或变化，就写进 `seen[id]`。时间取两处的较大者：列表里的 `lastTurnEndedAt`，和当前会话自己 `runs` 里最近一次 `succeeded` / `failed` 的 `endedAt`（同样来自 run_ledger，主轮次，服务器时间）。页面隐藏时不写，重新可见时补写 | 打开会话就清掉未读（00 §0.4）；当前会话不亮（00 C4）。会话自己的 runs 在轮次结束时就带着结束时间，不用等列表重读，切走也不会误亮。后台标签页不写，免得替正在看别的会话的标签页清掉蓝点 | 切走时写 `seen = Date.now()`：浏览器时钟和服务器时钟比较不可靠；轮次结束时重读列表（最初的方案）：切走得快仍会误亮，没经过 `running` 的极短轮次也触发不了 | 无 |
| F5 状态放哪 | `SessionActivity` 加 `"unread"`。`Sidebar` 合并：当前会话的运行态优先，否则未读，否则 `idle` | 前导列已经按 `activity` 画，优先级在一处决定 | 给 `SidebarSessionItem` 另加 `unread: boolean`：`SessionRow` 要自己再排一次优先级 | 无 |
| F6 样子 | 新 token `--unread: #60a5fa`；圆点 7px，和审批点共用尺寸规则；`role="status"`、`aria-label="New reply"` | 用户选定（00 C2）；和审批点同位置、同大小 | 复用 `--progress`：语义是"进行中" | 无 |
| F7 多标签页 | 监听 `storage` 事件，别的标签页记了已看，这里也熄灭 | 和置顶一致 | 无 | 无 |

## 2.3 分阶段实施

### Stage 1：后端字段

**`packages/ohbaby-agent/src/services/session/global-query.ts`**

- `GlobalSessionPage.sessions` 的元素类型改成 `GlobalSession`：`Session & { readonly lastTurnEndedAt?: number }`，并导出。
- `listGlobalSessions` 的 SQL 先在子查询里按原条件、排序和 `LIMIT` 切出一页（别名 `page`），外层再 `SELECT page.*, (子查询) AS last_turn_ended_at` 并按同样顺序排序。子查询：

  ```sql
  SELECT MAX(r.ended_at) FROM run_ledger r
  WHERE r.session_id = page.id AND r.context_scope_id IS NULL
    AND r.status IN ('succeeded', 'failed')
  ```

  表名和列名用 `schema.runLedger`、`schema.session` 拼，不写死；`run_ledger` 的列都带别名 `r`，避免和 `session.status` 混淆。
- 行映射：`rowToSession(row)` 之后，`last_turn_ended_at` 是数字就加上 `lastTurnEndedAt`。

**`packages/ohbaby-agent/src/services/session/index.ts`、`packages/ohbaby-agent/src/index.ts`**：导出 `GlobalSession` 类型。

**`packages/ohbaby-sdk/src/contract/global-sessions.ts`**：`UiGlobalSession` 加

```ts
/** When the latest main turn that produced a result (success or error) ended. */
readonly lastTurnEndedAt?: string;
```

**`packages/ohbaby-server/src/protocols/global-sessions.ts`**：`toUiGlobalSession` 的参数改成 agent 包导出的 `GlobalSession`，`lastTurnEndedAt` 有值时输出 ISO 字符串。

**`packages/ohbaby-server/src/app/openapi.ts`**：如果列表的响应 schema 列出了会话字段，补上 `lastTurnEndedAt`。

完成定义：04 的 S 组通过。

### Stage 2：前端未读点

**新建 `ui/sidebar/session-seen.ts`**

- `globalSessionSeenKey(serverUrl)` 返回 `ohbaby.web.session-seen.v1:[origin]`，origin 的算法和 `session-pins.ts` 的 `serverOrigin` 一致（抽出来共用，或者直接复用导出）。
- `getSessionSeenStore(serverUrl)` 返回 `{ getSnapshot, subscribe, markSeen(id, at) }`。快照是 `{ since, seen }`。
- 读不到 key 时生成 `since = Date.now()` 并写入；存储不可用时只在内存里记，页面内照常工作。
- `markSeen` 只在新时间更大时写，避免无意义的写入和通知。
- `subscribe` 时监听 `storage` 事件，key 匹配就重新读取。
- 导出纯函数 `isUnread(session, snapshot, activeId)`，按 F3 判定。

**改 `store/sidebar-groups.ts`**：`SessionActivity` 加 `"unread"`。

**改 `ui/sidebar/Sidebar.tsx`**

- 取 seen store 和快照（同置顶的 `useSyncExternalStore` 写法）。
- 合并后的 `activity`：`props.activity` 里有值就用它，否则 `isUnread` 为真时是 `"unread"`。分组和行渲染都用合并后的结果。
- 新 prop `activeTurnEndedAt?: number`：当前会话自己 runs 里的回复结束时间。
- `useEffect`：页面可见（`useSyncExternalStore` 订阅 `visibilitychange`）时，取列表值和 `activeTurnEndedAt` 的较大者调用 `markSeen`（F4）。

**改 `ui/sidebar/SessionRow.tsx`**：前导列加未读分支，在等待审批之后：

```tsx
<span className="ohb-session-lead" role="status" aria-label="New reply">
  <span className="ohb-session-unread" aria-hidden="true" />
</span>
```

更新组件注释。

**改 `ui/sidebar/sidebar.css`**：`.ohb-session-awaiting, .ohb-session-unread` 共用尺寸规则，`.ohb-session-unread { background: var(--unread); }`。

**改 `ui/styles/tokens.css`**：在 `--attention` 后面加 `--unread: #60a5fa;`，注释写"新回答没看过的圆点"。

**改 `ui/sidebar/SessionList.tsx`**：传给行菜单的 `busy` 原来是 `activity !== "idle"`，会让未读行的 Archive 变灰并显示 Running。改成只在 `running` 或 `awaiting` 时为真。

**改 `ui/shell/AppController.tsx`**：用 `session-seen.ts` 导出的 `latestTurnEnd(view.snapshot.runs, activeId)` 算出当前会话的回复结束时间，传给 `Sidebar`。

**改 `runtime/index.ts`**：在现有的焦点、可见性监听旁边加一个 15 秒的定时器，页面可见时调用 `this.global.refresh()`（会合并重复触发）；清理函数里清掉。间隔写成命名常量。

**改 `dev/mock-scenarios.ts`**：`globalRow` 默认带 `lastTurnEndedAt: iso(minutesAgo)`，浏览器验收用。

完成定义：04 的 U、R、B 组通过。

### Stage 3：同步设计文档

路径相对 `docs/ohbaby-web/redesign-2026-10/`。

| 文件 | 位置 | 改成 |
|---|---|---|
| `03-ui-layout-and-style.md` | 色板表 | 加 `--unread` 一行 |
| `03-ui-layout-and-style.md` | 会话行一节 | 补"有没看过的新回答时，这一列显示 `--unread` 蓝点" |
| `04-interaction-and-states.md` | 会话行状态表 | 加 `unread` 状态，优先级改成 moving > running > awaiting > unread |
| `05-components.md` | SessionRow | 前导列状态加未读 |
| `06-data-api-and-state.md` | `SidebarSessionItem.activity` 的类型、§3.4 | 类型加 `"unread"`；§3.4 补一段：未读靠全局列表的 `lastTurnEndedAt` 和本地已读记录，所有会话都有；运行中和等待审批仍只有当前实例 |
| `06-data-api-and-state.md` | §1 接口表 `GET /v1/sessions` 行、§3.2 刷新时机表 | 写明 `lastTurnEndedAt`；加“页面可见时每 15 秒”一行 |
| `03-ui-layout-and-style.md` | §1 原则表“品牌只在字标”“状态不只靠颜色”两行 | 说明蓝点是状态色不是品牌色；橙黄点和蓝点不会出现在同一行，且都有读屏文字 |
| `05-components.md` | SessionRow 的 States、Accessibility | 加 `unread` 和 `New reply` |
| `08-test-and-acceptance.md` | UC-CHAT-01 清单、§2 unit 一行、视觉走查表 | 加未读点验收条目、状态位优先级、侧栏行检查点；“除字标外没有金粉蓝”补上状态点例外 |

## 2.4 兼容与迁移

- `lastTurnEndedAt` 是可选字段。旧前端忽略它；新前端遇到旧后端时没有这个字段，就永远不亮，不会出错。
- 新的 localStorage key，不迁移旧数据。

## 2.5 风险与回滚

| 风险 | 应对 |
|---|---|
| 列表查询变慢 | 先切页再算子查询，子查询只跑页内的行（最多 501 行），走 `(session_id, context_scope_id, status, …)` 索引 |
| 定时重读打扰本地操作 | 走 `refresh()`：重复触发合并；遇到进行中的本地改动会放弃结果；失败只记错误状态，已有行保留 |
| 当前会话刚答完就切走，误亮 | F4：用会话自己 runs 里的结束时间记已看，不等列表 |
| 第一次使用时一片蓝 | F2 的 `since` |

后端（Stage 1）、前端（Stage 2）、文档（Stage 3）分三次提交，出问题可以单独回退。

## 2.6 与其他议题的关系

- 跨会话等待状态（待开）：要让别的会话也显示运行中、等待审批，需要实时推送。到那时可以新增 daemon 层事件流，把本议题的定时重读换成事件触发；`lastTurnEndedAt` 和已读记录不用改。

## 2.7 留到以后

- 手动"标为未读"。
- 清理 `seen` 里已删除会话的记录。

## 2.8 实施时按审查意见做的调整

计划写完后派子代理做了一轮对抗式审查，以下意见被采纳，已据此修改代码和上文：

| 意见 | 原方案 | 调整 |
|---|---|---|
| 子查询会对所有根会话都算一遍再 `LIMIT`（`session` 表没有 `updated_at` 单列索引，SQLite 先建临时排序树） | `SELECT *, (子查询) … ORDER BY … LIMIT ?` | 先切页再算（Stage 1） |
| `refreshSessions()` 不合并重复调用，服务端慢时定时器会堆积请求 | 定时器调 `refreshSessions()` | 改调 `refresh()`（B2） |
| 轮次结束时重读列表仍有竞态，极短轮次不经过 `running` | `running` 真变假时 `refreshCatalog()` | 用当前会话自己的 runs 记已看（F4） |
| 后台标签页会替前台标签页清掉蓝点 | 无可见性判断 | 只在页面可见时记已看（F4） |
| 未读行的 Archive 被禁用 | 02 没列 `SessionList.tsx` | 补上改动和测试 |
| 子查询列名没加表别名 | 裸列名 | 加别名 `r` |
| 设计文档还有几处没列进同步表 | 03/04/05/06 四处 | 补 03 §1、06 §1/§3.2、05、08（Stage 3） |
