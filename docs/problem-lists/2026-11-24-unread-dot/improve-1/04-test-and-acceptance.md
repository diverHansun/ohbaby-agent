# 4. 测试与验收

## 4.1 测试策略

- **后端字段**写进现有的全局列表测试：`packages/ohbaby-agent` 里 `global-query` 的测试，和 `packages/ohbaby-server/src/protocols/global-sessions.unit.test.ts`。
- **已读记录和判定**是纯逻辑，新建 `apps/ohbaby-web/src/ui/sidebar/session-seen.unit.test.ts`。
- **前导列渲染**改现有的 `apps/ohbaby-web/src/ui/sidebar/Sidebar.unit.test.tsx`。
- **定时重读**用假定时器测 `runtime/index.ts` 的行为，放在已有的 runtime 测试里。
- **视觉**用 `ohbaby-web-mock` 启动。mock 的会话都在第一次打开之前结束，所以验收时先把 localStorage 里的 `since` 改小，让它们变成未读。

## 4.2 后端验收（S 组）

| 编号 | 场景 | 通过标准 |
|---|---|---|
| S-1 | 会话有一轮 `succeeded`、结束于 T | 列表项 `lastTurnEndedAt` 是 T |
| S-2 | 最近一轮是 `failed`、结束于 T2，更早一轮 `succeeded` | 取 T2 |
| S-3 | 最近一轮是 `interrupted`（用户停止）或 `cancelled`，更早一轮 `succeeded` 结束于 T | 取 T |
| S-4 | 只有子代理轮次（`context_scope_id` 不为空） | 没有 `lastTurnEndedAt` |
| S-5 | 没有任何轮次，或只有 `running` | 没有 `lastTurnEndedAt` |
| S-6 | `toUiGlobalSession` 收到毫秒数 | 输出 ISO 字符串；没有时不输出这个键 |
| S-7 | 分页和排序 | 和改动前一致；第二页的会话同样带 `lastTurnEndedAt`（子查询只对页内行计算） |

## 4.3 已读判定（U 组）

| 编号 | 场景 | 通过标准 |
|---|---|---|
| U-1 | 第一次读取，localStorage 里没有 key | 生成 `since` 并写入 |
| U-2 | 结束时间早于 `since`，没有 `seen` | 不是未读 |
| U-3 | 结束时间晚于 `since`，没有 `seen` | 未读 |
| U-4 | 结束时间晚于 `seen[id]` | 未读；等于时不是 |
| U-5 | 是当前会话 | 不是未读 |
| U-6 | 没有 `lastTurnEndedAt` | 不是未读 |
| U-7 | `markSeen` 传入更小的时间 | 不写入，不通知 |
| U-8 | 另一个标签页改了 key（`storage` 事件） | 快照更新，订阅者收到通知 |
| U-9 | localStorage 读写抛错 | 不报错，内存里照常工作 |
| U-10 | `latestTurnEnd(runs, id)` | 只取这个会话 `succeeded` / `failed` 的最大 `endedAt`；`interrupted`、`cancelled`、未结束的不算；别的会话和空 id 返回 undefined |

## 4.4 渲染验收（R 组）

| 编号 | 场景 | 通过标准 |
|---|---|---|
| R-1 | 非当前会话未读 | 前导列 `role="status"`、`aria-label="New reply"`，含 `.ohb-session-unread` |
| R-2 | 当前会话的结束时间更新 | 不亮；`seen` 被写成这个时间 |
| R-3 | 当前会话在运行、在等审批，同时未读条件成立 | 显示运行或审批，不显示未读 |
| R-4 | 打开一个未读会话 | 点消失；切走后也不再亮 |
| R-5 | 定时器 | 页面可见时每 15 秒重读一次列表；页面隐藏时不读；卸载后清掉 |
| R-6 | 当前会话自己 runs 里的结束时间比列表新 | 记下的是较大的那个，不等列表重读；切走后不亮 |
| R-7 | 未读行打开菜单 | Archive 可用，不显示 Running |
| R-8 | 页面隐藏时打开着某个会话 | 不写 `seen`；页面重新可见后补写 |

## 4.5 浏览器验收（B 组）

| 编号 | 场景 | 通过标准 |
|---|---|---|
| B-1 | `?mock=typical`，把 `since` 改小后刷新 | 非当前会话出现蓝点，计算后的颜色是 `rgb(96, 165, 250)` |
| B-2 | 蓝点位置 | 和审批点、工作区文件夹图标在同一列，行内上下居中 |
| B-3 | hover 有蓝点的行 | 蓝点不动、不被「…」挡住，标题宽度不变 |
| B-4 | 点开一个有蓝点的会话，再切走 | 点消失，切走后不再出现 |
| B-5 | `?mock=approval` | 审批点照旧，当前会话不显示蓝点 |
| B-6 | 375px 手机宽度 | 蓝点位置和桌面一致 |

## 4.6 对抗性审查要点

- 有没有地方拿浏览器的 `Date.now()` 和服务器的结束时间做"已看"判定（`since` 除外）？
- 子查询有没有漏掉 `context_scope_id IS NULL`？漏了的话子代理每跑一轮都会亮。
- `SessionActivity` 加了 `"unread"` 之后，用 `activity !== "idle"` 判断"在运行"的地方（比如归档置灰）会不会把未读当成运行中？
- 定时器在页面隐藏时有没有停？卸载时有没有清？
- 当前会话为什么永远不亮：判定里排除了，记已看也覆盖了，两处都要有。
- 后台标签页会不会替前台标签页把蓝点清掉？

## 4.7 完成定义

S、U、R、B 四组全部通过；后端和 Web 的类型检查、lint、单测通过；02 §2.3 Stage 3 的设计文档已同步。

## 4.8 实施结果（2026-11-24）

| 组 | 结果 | 覆盖位置 |
|---|---|---|
| S | 通过 | `global-query.integration.test.ts`“carries when the latest main turn with a result ended”（S-1 至 S-5、S-7）；`global-sessions.unit.test.ts`（S-6）；原有分页测试不变并通过 |
| U | 通过 | `session-seen.unit.test.ts`，8 个用例 |
| R | 通过 | `Sidebar.unit.test.tsx` 两个新用例（R-1 至 R-4、R-6 至 R-8）；`session-runtime.focus.integration.test.ts` 新用例（R-5） |
| B | 通过 | 浏览器走查，见下 |

浏览器走查（`ohbaby-web-mock`，1024 宽和 375 宽）：

- B-1：蓝点计算颜色 `rgb(96, 165, 250)`，7×7px。
- B-2：圆点中心 x=25.5，和工作区文件夹图标中心相同；圆点中心 y 和行中心相同。
- B-3：hover 时行尾出现图钉和「…」，圆点位置不变。标题因为行尾按钮让位而变窄，这是所有行原有的 hover 行为，和蓝点无关。
- B-4：点开“Refactor the session sidebar”后点消失；再切到另一个会话，两个都不再亮，`seen` 记下了两条。
- B-5：`?mock=approval` 里当前会话只显示橙黄审批点，没有蓝点；其他会话的蓝点和它同列。
- B-6：375px 抽屉里蓝点、审批点位置和桌面一致。

mock 的回复结束时间按页面加载时刻往前推算，每次刷新都会变成“新回复”，所以 mock 下刷新后看过的会话会再次亮起。真实数据的结束时间来自 run_ledger，不受影响。

后端、SDK、server 和 Web 的类型检查、eslint、prettier 通过；Web、server、SDK 全量测试 179 个文件通过；`ohbaby-agent` 的 `services/session` 目录测试全部通过。

没有自动测试覆盖的：`AppController` 用 `latestTurnEnd(view.snapshot.runs, activeId)` 给 `Sidebar` 接线这一步（`latestTurnEnd` 本身和 `Sidebar` 收到 prop 后的行为都有测试）；别的标签页记已看后本页 `Sidebar` 跟着熄灭，只在 store 层测了 `storage` 事件。
