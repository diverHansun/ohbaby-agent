# Improve-3：Codex 独立审查与浏览器验收

日期：2026-10-30（Asia/Taipei）。审查者：Codex；前端作者：Claude。

结论：**暂不满足合并门槛**。列表、停止、审批、会话隔离等主要操作正常，但独立审查发现三项 P2 问题，均已在编译后的 Web 页面复现。现有自动化测试通过不等于 I3-06 已通过。本轮保留前端作者的生产代码，提交测试夹具和本报告，交用户审查。

## 分支与范围

- 后端验收原文已单独提交为 `d9031790`；improve-1/2 已通过 `4b2a9646` 合入本地 `main`。
- 本地临时分支为 `codex/improve-3-review`。通过 `c54549f6` 导入 `subagent/frontend`，保留原三批提交 `e540341b`、`9f01b073`、`7610109a`。
- 原 worktree `.claude/worktrees/subagent-frontend` 保持原样。没有把 improve-3 合入 `main`，没有 push。
- 两个独立子代理分别按代码规范和设计符合性审查 `b94cc001..7610109a`；另一个子代理审查浏览器测试夹具。主代理复核结论并操作真实页面。
- improve-2/05 中的 B4 属于已记录的后续后端工作；本轮没有把验收文档中的建议自动扩成新的实施范围。improve-4 的历史锚点入口也不作为这一批缺陷。

## 必须处理的三项问题

### R1（P2）：新旧阅读入口争用一个服务端 watch

位置：`apps/ohbaby-web/src/ui/side-panel/subagents/SubagentInstanceDetail.tsx:53–55`。

新详情单独创建 conversation reader；旧入口在 `ui/session/useSessionInteractions.ts:74–76` 也创建 reader，二者共用同一个客户端。服务端每个 client view 只保留一个 subagent watch（`packages/ohbaby-server/src/coordination/client-view.ts:618–619,880–886`），SDK 在 `packages/ohbaby-sdk/src/sync/subagent-conversation-reader.ts:550` 按 watchId 过滤事件。第二个 reader 打开时，第一个 reader 的订阅被替换，但 UI 没有提示或重新订阅。

真实复现：

1. 启动下述夹具，在主会话发送 `PANEL_RUNNING`。
2. 展开主会话的 `Total 0s`，点派遣记录，打开旧 Runner 详情；在夹具 stdin 输入 `tick`。旧详情显示 `PANEL_STREAM_TICK_1`。
3. 打开右栏 → Subagents → Runner；再输入 `tick`。
4. 新详情显示 `PANEL_STREAM_TICK_2`，旧详情停在第 1 条。关闭右栏，再输入 `tick`，旧详情仍没有第 3 条；重新打开右栏可读到第 3 条。

这违反 04 §4.3 的“旧浮层行为不变”，也影响 I3-03/I3-06 的实时阅读。修复应明确两个入口的订阅所有权与恢复规则，并补共存回归测试；不应仅因单个 reader 测试通过就认为两个入口兼容。

新详情收到第 2 条，旧详情停在第 1 条（测试附件已清理）

### R2（P2）：从列表重新打开同一实例会丢失阅读位置

位置：`SubagentInstanceDetail.tsx:78–100`，以及 `ui/session/SubagentConversationBody.tsx` 向消息流传入的 execution 锚点。

返回列表会销毁 reader。重新打开时再次按 latestExecutionId 调用 `reader.select`，生成 execution 锚点（SDK reader `:636–637` → `:463–465`）；`ui/conversation/ConversationStream.tsx:267–295` 把这个锚点当成显式定位，覆盖先前缓存的阅读位置。源码还显示缓存只保存 position/tools，分页数据窗口不随 reader 保留；本次截图直接证明的是阅读位置跳转。

真实复现：发送 `PANEL_START`，打开已完成的 Reader，将消息区滚到 Reading checkpoint 11 附近。DOM 读取到 `scrollTop=2465`。返回列表，再打开 Reader，`scrollTop=20`，页面回到第一段；内容高度保持 `11605`，不是内容长度变化导致的偏移。

这直接违反 I3-06“列表和详情来回切换不丢阅读位置”。需要区分“打开当前实例、恢复阅读”与“显式定位历史执行”，同时验证加载较早消息后往返仍保留数据窗口和位置。

| 返回前 | 重新打开后 |
| --- | --- |
| 第 11 段附近（测试附件已清理） | 跳回第一段（测试附件已清理） |

### R3（P2）：窄屏首次打开入口页时 Escape 无效

位置：`apps/ohbaby-web/src/ui/side-panel/SidePanel.tsx:72–91`；打开按钮在 `ui/shell/MainHeader.tsx`。

打开面板会移除顶栏触发按钮，入口页没有设置初始焦点；焦点落到 `body`。Escape 只由 aside 的 `onKeyDown` 处理，因而收不到事件。详情标题会自行获取焦点，所以“先进入详情再按 Escape”的测试无法发现这个问题。

真实复现：820×800，无已开的 Tab → 点击 Open side panel → 立即按 Escape。面板仍打开；DOM 显示 `activeElement.tagName === 'BODY'`、焦点不在面板内。点击 Back to chat 可以返回，说明不是整个页面失去响应。

需要补首次打开入口页、恢复列表页的焦点与 Escape 测试，并保留关闭后返回触发按钮的行为。

按 Escape 后仍留在入口页（测试附件已清理）

## 验收覆盖

页面由编译后的 CLI 启动真实 Host/SDK/server，浏览器通过正常控件操作。只把模型换为本地脚本化 OpenAI 兼容服务；没有向页面注入应用状态或伪造网络结果。测试目录、数据库、配置和模型凭据独立于用户环境。

| 验收项 | 证据与结果 |
| --- | --- |
| I3-01 | 首次显示入口页，菜单只有 Subagents；可开两个同类 Tab，Delete 关闭当前 Tab；收起再开保留选择；方向键改宽 420→444；刷新后面板保留展开、Tab 回到入口页。已有单元测试覆盖宽度边界和持久化。通过。 |
| I3-02 | 真实列表 Active 2（Running、Needs approval）、Done 1（Completed）；停止后 Interrupted 归 Done；审批后 Completed；Reader 续跑后仍只有一行。刷新失败、未处理消息计数由现有集成测试覆盖，失败状态分组和标签由 instance-status 单元测试覆盖。通过。 |
| I3-03 | 第二次 Reader 执行读到新结果，可加载之前的 26 次 read 历史；标题来自实例状态。单独打开时真实流增量可见，但新旧入口共存会停更，见 R1。未全部通过。 |
| I3-04 | 右栏停止后台 Runner，Approval 仍等待审批，Reader 不受影响；Allow once 后真实 bash 写入隔离 sentinel。前景 Foreground 停止后，主代理从等待状态继续并输出 `PANEL_FOREGROUND_ACCEPTED`。迟到停止目标、Stopping、错误回执由现有集成测试覆盖。通过。 |
| I3-05 | 前景执行中收起右栏，主代理仍在等待；重开详情仍 Running。切换新主会话显示空提示，创建 Other reader 后只显示该会话实例。close Reader 后行消失并退出详情。Tab 卸载释放 watch、不调用 stop 由现有集成测试覆盖。通过。 |
| I3-06 | 真实历史分页、宽屏并排、390px 详情排版和 Back to chat 正常；展开后 Escape 可恢复；主输入框可在侧栏打开时正常发送。重连由现有测试覆盖，未做真实断网演练。阅读位置和首次打开 Escape 失败（R2、R3），共存实时阅读失败（R1）。不通过。 |

视觉走查采用 1440×900、820×800、390×844。桌面布局保持左导航、主聊天、右栏；手机宽度的任务说明省略，正文自然换行，停止和返回控件可操作。未发现阻断性的溢出或重叠。已有左导航在跨断点缩窄时会成为抽屉，关闭后右栏正常铺满；未把这个已有行为记为新缺陷。

桌面列表（测试附件已清理）

手机宽度详情（测试附件已清理）

## 可重复运行的夹具

新增 `scripts/run-subagent-panel-e2e.mjs`，先 `pnpm build`，再交互运行 `node scripts/run-subagent-panel-e2e.mjs`，浏览器打开它打印的 `PANEL_READY.url`。

- `PANEL_START`：Reader 完成 26 次真实 read；Runner 保持可取消的真实流；Approval 等待 bash 审批。
- `PANEL_SEND_READER`、`PANEL_CLOSE_READER`：续跑和关闭同一个 Reader。
- 新主会话发送 `PANEL_OTHER_SESSION`：检查隔离。
- `PANEL_FOREGROUND`：主代理前景等待，手动在详情 Stop。
- `PANEL_RUNNING`：创建运行中的 Runner，适合复现 R1。
- 终端输入 `tick`：向打开的模型流追加唯一标记；`status`：读取后端事实；`finish`：核对核心场景并清理；`quit`：仅清理。

`finish` 断言了 Reader 两轮完成且已关闭、Runner 已被停止、Approval 完成且 sentinel 正确、Other reader 属于另一主会话、真实 read 历史存在。它**不代替**滚动、焦点、订阅共存等浏览器证据。

本轮核心场景 `backend-pass`、进程/端口/provider 清理均通过；额外 R1 场景退出时也确认清理成功，没有遗留验收服务。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| Web + SDK sync 定向测试 | 76 个文件、895 项通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 错误、109 个警告 |
| `pnpm build` | 通过 |
| 测试夹具 `node --check` | 通过 |
| `pnpm test` 全仓测试 | 643 个文件通过、6 个文件跳过；7505 项通过、17 项跳过，退出码 0 |
| 编译后 Web E01–E05 | 通过。真实 read 结果已展开核对；刷新前后最终回复各一条、用户续问一条、会话不变；没有运行时标记泄露。UI、backend、cleanup、diagnostics 均 PASS，退出码 0 |

前端原 `05` 保留作者记录；本报告补充独立复核结果。三项问题修复并回归前，不建议合入 main。improve-4 可以准备设计，但入口迁移应明确承接 R1 的订阅所有权，避免依赖“旧入口以后会删”来接受当前静默停更。
