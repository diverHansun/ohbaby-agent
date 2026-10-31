# 7. 合并后复验与 UI 打磨

日期：2026-10-30。执行方：Claude。对象：本地 main（`def294b2`，improve-3、improve-4 和 B4 已合并）。

## 结论

**合并后的 main 端到端通过。** 走查中发现两个前端问题和三处视觉粗糙的地方，都已修好，并在编译产物上复验通过。另有一个后端排序问题，转给 Codex。

## 合并后基线（修改前）

| 检查 | 结果 |
| --- | --- |
| `pnpm build`、`pnpm typecheck` | 通过 |
| `pnpm lint` | 0 个错误 |
| `pnpm test` | 642 个文件通过、6 个跳过；7523 项通过、17 项跳过，0 失败 |
| 场景脚本 `run-subagent-panel-e2e.mjs`（1280×800） | `backend-pass`、`cleanup-pass`、`verified: true` |

浏览器里逐项看过：

- 入口打开右侧栏并定位到这次派遣，焦点落在详情标题上。审批浮层还在，主会话没有被设为 `inert`，也没有旧浮层。
- Reader 的两次执行各自定位，再点一次会重新定位。
- Runner 收到 `tick` 的流式内容，Stop 后变成 Interrupted。
- 关闭 Reader 后，它的两条入口撤下，工具卡还在；刷新页面后也不回来。
- 新会话只显示 Other reader。

## 发现的问题与处理

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | **入口状态和列表不一致：** Approval 在等审批，右侧栏列表写 `Needs approval`，聊天里的入口却写 `Running`。 | `SessionConversation` 判断实例在这次执行里等审批，就传 `awaitingApproval`；入口显示琥珀色小点和 `Needs approval`。 |
| 2 | **发送后不跟随：** 手动展开过折叠行（例如为了找子代理入口）或往上翻过以后，再发新消息，消息区停在原处，看不到刚发的内容。原因是展开折叠行会关掉跟随，而发送不会重新打开。 | `SessionScreen` 每次发送递增 `followToken`，`ConversationStream` 收到后恢复跟随并滚到底部，做法和 Claude、Codex 一致。新增 App 测试：修改前停在 200，修改后到底部。 |
| 3 | **`Load earlier messages` 是浏览器默认按钮**（灰框方块），聊天和子代理详情里都是。 | 改成居中的细描边小胶囊（`.ohb-history-more`）。 |
| 4 | **状态图标不统一：** 运行中有转圈，等审批有点，完成、中断、失败什么都没有，文字对不齐，整体也偏单调。 | 新增 `shared/StatusGlyph`，每种状态一个 12px 小图标：转圈、琥珀点、淡绿对勾、红色感叹号、灰色斜杠。列表、详情标题和聊天入口共用这一套。颜色只用已有 token。 |
| 5 | **入口和工具卡读成并列的两行：** 六行交替排列，看不出哪个入口属于哪张卡。 | 入口缩进挂在工具卡图标下面，用一条 1px 的折角细线连着（像 Claude Code 的 `⎿`）。实测折线横坐标和图标中心重合。 |

改动只在 `apps/ohbaby-web` 和设计文档 03（§4.3 消息、§4.9 列表）。

修改前：入口和工具卡并列，Approval 写 Running（测试附件已清理）
修改后：入口挂在卡片下，状态图标统一，Approval 显示 Needs approval（测试附件已清理）
390×844 下的入口（测试附件已清理）

## 修改后复验

- **重新构建后完整走一遍场景脚本：** 结果同样是 `backend-pass`、`cleanup-pass`、`verified: true`。
- **问题 2 的实测：** 先展开、收起折叠行，把消息区滚到顶，再发 `PANEL_SEND_READER`。发送后离底部 0px。
- **其余几处：** 小胶囊、统一的状态图标、折线都按上面的描述显示。窄屏 390×844 下入口和状态不换行、不挤压。

## 转给后端（Codex）

**中断提示排在最前面：** 停止一个正在流式输出的执行后，`[Response cancelled by the user.]` 显示在这条消息的思考和正文前面。主会话也有同样的问题。

- **数据库里的顺序是对的：** `order_index` 依次是思考 0、正文 1、提示 2。
- **原因：** `ensureInterruptionFact`（`core/message/interruption.ts`）追加的提示没有 `metadata.sourceOrder`。投影的 `compareParts`（`adapters/ui-state/source-session-projection.ts:624`）把缺省值当作 0，而流式部件从 1 开始编号，所以提示被排到了最前面。
- **建议：** 追加提示时给它一个比现有部件都大的 `sourceOrder`，或者让排序在缺省时退回 `orderIndex`（`persistent-store.ts:200` 已经是这样做的）。

## 留给用户决定

**折叠行会把运行中的子代理入口一起收起来。** 按 03 §4.3，一轮结束后，中间过程（包括 agent 工具卡和入口）收进 `Total 0s` 折叠行。子代理还在运行时，要先展开才能点到入口；右侧栏开关始终可用。是否让“仍在运行的子代理入口”留在折叠行外面，属于产品取舍，没有在这一轮改。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| Web 测试 | 70 个文件、832 项通过 |
| `pnpm build`、`pnpm typecheck` | 通过 |
| `pnpm lint` | 0 个错误，109 个警告（和改动前一样） |
| `pnpm test` | 642 个文件通过、6 个跳过；7525 项通过、17 项跳过，0 失败 |
| 场景脚本（重新构建后） | `backend-pass`、`cleanup-pass`、`verified: true` |

编译后的 Web E01–E05 没有重跑：这一轮只改了跟随的触发条件和样式，E01–E05 覆盖的刷新和回复去重路径没有动。
