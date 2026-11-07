# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1、2。测试与源码放在同一目录，按 `*.unit.test.ts(x)`、`*.integration.test.ts` 分类，用 `pnpm test:unit`、`pnpm test:integration` 运行。本文的编号只在本轮有效；引用其他议题的编号时一律加前缀，例如“轮次投影 T11b”。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | Web store 的缓存与组合规则；后端投影留下的标记；Web 答案判定 |
| integration | 真实 SQLite 重开前后，投影出的消息是否带标记（成对） |
| 走查 | 用户报告的两个问题，在 Web 上从头复现一遍 |

后端集成测试只能断言投影出的消息：`packages/ohbaby-agent` 不依赖 Web，引用不了 `projectRunProcesses`。“据此判定有没有答案”由 Web 单元测试 T6 用同样形状的消息覆盖。

## 4.2 关键场景

### Stage 1：长会话里旧答复保留按钮

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 子代理轮次被实时挤出窗口 | unit（`W/store/store.unit.test.ts`） | 第一次视图有答复消息和已结束、`trigger: "subagent"` 的 run，没有 prompt；第二次视图（同一会话、更新的版本）已不含它们。快照里仍有这个 run，`projectRunProcesses` 算出的轮次 `answerId` 指向这条答复，`trigger` 仍是 `subagent` |
| T2 | 普通用户轮次被实时挤出窗口 | unit（同上） | 第一次视图有用户消息、答复、已结束的 run 和 prompt；第二次视图都不含。快照里 run 和 prompt 都在，轮次仍有 `answerId` |
| T3 | 只用仍被消息引用的副本 | unit（同上） | 某条消息被删除（`invalidateSessionHistory` 的 `removedMessageIds`，或历史失效后被清掉）后，只被它引用的缓存 run 和 prompt 不再出现在快照里；实时视图里的 run 不受影响 |
| T4 | 运行中的副本不进缓存 | unit（同上） | ① 实时视图里运行中的 run 被移出视图后，快照里没有它的运行中副本。② 先由实时视图缓存一个已结束的 run，再安装一页含同一 run 运行中副本的历史页，快照里仍是已结束的那份。③ 实时视图仍有运行中的 run 时，“有没有活动 run”的判断与改动前一致 |

### Stage 2：隐藏工具后中断，不当答案

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T5 | 投影留下标记 | unit（`A/adapters/ui-state/persistent-store.unit.test.ts`） | “正文 + `todo_read`”的消息投影后带 `hiddenToolCalls: true`，`parts` 里没有工具片段；`todo_write`、`select_tools` 各测一次；纯正文和带可见工具的消息都没有这个字段 |
| T6 | 答案判定成对 | unit（`W/ui/conversation/run-process.unit.test.ts`） | 中断（`interrupted`、`cancelled`）的轮次里：最后一条消息“正文 + 中断提示”有 `answerId`；“正文 + 中断提示 + `hiddenToolCalls`”没有 `answerId`，耗时行跟在这条消息后面 |
| T7 | 成功轮次不受影响 | unit（同上） | “阶段说明（带标记）→ 收尾答复”的成功轮次，答案仍是收尾答复，阶段说明计入过程、可以折叠 |
| T8 | 重开 SQLite 成对回归 | integration（`A/adapters/ui-persistent.integration.test.ts`，参照 `:1263` 的 Stop 用例） | ① 纯正文流到一半点 Stop：重开前和关闭后重开数据库，实时视图与历史里这条消息都没有标记，正文和中断提示片段都在。② 正文后接 `todo_read`，工具写盘后中断：重开前和重开后，这条消息都带 `hiddenToolCalls: true`，`parts` 里没有工具片段，状态为 `completed`，中断提示片段在 |

## 4.3 回归清单

| ID | 项 | 验证点 |
|---|---|---|
| T9 | 已有的复制与轮次测试 | `W/ui/conversation/message-copy.unit.test.tsx`（含轮次投影 T11、T11b）、`run-process.unit.test.ts`（含轮次投影 T11）、`W/store/store.unit.test.ts`（含轮次投影 T13）全部通过 |
| T10 | Todo 仍不显示 | Web 和 TUI 的会话里都看不到 `todo_read`、`todo_write`、`select_tools` 的工具卡片 |
| T11 | 翻历史 | 点 `Load earlier messages` 后，较早轮次仍能折叠，有耗时行和复制按钮 |

## 4.4 走查

两个场景都用隔离的 daemon（独立数据目录）加脚本模型，做法同轮次投影 T11c、T15。

| ID | 场景 | 怎么构造 | 验证点 |
|---|---|---|---|
| T12 | 问题 1 | ① 让脚本模型先写几轮普通对话，再派一个子代理；子代理完成后唤醒主代理，写出收尾答复（例如正文 `WINDOW_A_VISIBLE_50`）。调整前面的轮数，让这条答复正好是最近 50 条消息里最早的一条。② 页面上确认它有 `Copy answer` 和 `Subagent update` 耗时行。③ 发一条普通消息（例如 `E2E-BASIC`），让这条答复移出窗口。④ 换成普通用户轮次处在窗口边界，再走一遍 | 移出窗口后正文、`Copy answer` 和耗时行都还在，不需要点 `Load earlier messages`；普通用户轮次同样如此 |
| T13 | 问题 2 | ① 脚本模型先输出 `I will check the private task list.`，接着调用 `todo_read`。② 工具写盘后、模型下一步开始前，结束 daemon 进程，再用同一数据目录重启并打开这个会话。③ 另走一遍：同样的位置改为在页面上点 Stop，不重启。④ 对照组：纯正文流到一半点 Stop | ①②③：页面显示 `interrupted`，这句阶段说明下面没有 `Copy answer`。④：仍能复制，剪贴板里没有中断提示 |

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` |
| 单元测试 | T1 至 T7、T9 通过 | `pnpm test:unit` |
| 集成测试 | T8 通过 | `pnpm test:integration` |
| Web 走查 | T10 的 Web 部分、T11 至 T13 通过，附截图 | 内置浏览器 |
| TUI 检查 | T10 的 TUI 部分通过 | 在终端里打开同一会话查看 |
| 文档 | 02 Stage 2 第 4 步已同步 | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 缓存副本让已删除的轮次重新出现 | 只用仍被显示中的消息引用的副本（T3） | 无 |
| 过期的运行中副本让界面以为还有活动 run | 运行中的 run 不进缓存（T4） | 无 |
| 只在实时或只在重开时修好 | 两条路都走 `messageToUiMessage`；T8 在重开前后各断言一次 | 若以后 Web 主会话改走 `run-stream-adapter`，需要在那里同样留标记 |
| 新增隐藏工具时忘了标记 | 标记由同一份隐藏名单驱动，名单加工具即生效 | 另外三份名单（01 §1.4.5）仍要手动同步，本轮不处理 |
| 上下文压缩后标记消失 | 无 | 已知限制，见 02 §2.6 |
| 复制和答案判定再次分叉 | 复制只认 `answerId`；T9 回归 | 无 |
