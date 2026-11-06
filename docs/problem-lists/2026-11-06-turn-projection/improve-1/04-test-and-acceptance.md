# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 3。测试与源码放在同一目录，命名 `*.unit.test.ts(x)`、`*.integration.test.ts(x)`、`*.contract.test.ts(x)`，用 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | 账本的触发来源与按 ID 查询、`runToUiRun` 的字段映射、Web 的轮次投影、耗时组件、TUI 的耗时行插入 |
| integration | 真实 SQLite 加进程内运行时：四种情况写入的 `trigger` 与默认策略；视图与历史返回的 run；Web 从事件到显示的完整链路 |
| contract | SDK 合约：`UiRun` 新字段、`UiSessionHistory.runs`，HTTP 与进程内实现一致 |
| 浏览器走查 | 一个用户 prompt 之后有子代理唤醒的真实会话：每轮折叠、耗时、标签、复制 |
| 手工 | TUI 里同样的会话 |

## 4.2 关键场景

### Stage 1：后端

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 四种情况 | integration | 用户发消息、goal 续跑、子代理唤醒、goal 期间的子代理唤醒（走 `runGoalTurn`）各跑一次：`run_ledger.trigger` 分别是 `user`、`goal`、`subagent`、`subagent`；视图和 `run.updated` 事件里的 `UiRun.trigger` 一致；goal 期间的唤醒，提交方仍是 `goal`（`driver`、todo 作用域不变） |
| T1b | 默认策略 | unit + integration | `DEFAULT_RUN_POLICY` 对三个触发来源都有配置，`goal`、`subagent` 的 run 能正常创建（不抛 `RunDefaultsPolicyError`），`multitaskStrategy` 都是 `reject`；主会话已有运行中的 run 时，再起一个 `subagent` 触发的 run 按 `reject` 处理 |
| T2 | 结局映射 | unit | 账本状态 `succeeded`、`failed`、`cancelled`、`interrupted` 分别映射到同名的 `outcome`；`pending`、`running` 没有 `outcome`；现有 `status` 的映射不变 |
| T3 | 视图里的 run 跟着消息走 | integration | 一个主会话有 60 个已结束的 run，其中夹着子代理作用域的 run：视图装载的消息涉及哪些主会话 run，就返回哪些，不受 50 个的限制，不含子代理作用域的 run，按新的在前排列；刚开始、还没有消息的运行中 run 也在列表里；`seed` 补载的是最近一个主会话 run 的消息，不会被子代理 run 或排序干扰 |
| T4 | 增量更新与裁剪 | integration | 连续产生新 run：视图的 run 列表包含新 run，不再截断到 50；视图裁剪消息后，run 列表只剩保留下来的消息涉及的和运行中的 run |
| T5 | 翻历史 | integration | 加载更早一页：`UiSessionHistory.runs` 正好是这一页消息涉及的主会话 run，带 `trigger` 和 `outcome`；子代理执行与作用域历史返回 `runs: []` |
| T6 | 合约 | contract | `UiRun.trigger`、`UiRun.outcome`、`UiSessionHistory.runs` 的结构；HTTP 与进程内实现返回相同内容；旧行（`trigger` 为 `user`）原样返回 |

### Stage 2：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T7 | 子代理唤醒的轮次 | unit + integration | 一个用户 prompt 之后有三个没有 prompt、`trigger` 为 `subagent`、`outcome` 为 `succeeded` 的 run：四轮各自折叠中间过程，各自显示最终答案和复制按钮；后三轮的耗时行显示 `Subagent update · Total Xs`，时间来自 run |
| T7b | 没有消息的 run | unit | 一个没有任何消息、`outcome` 为 `failed` 的 run（中途失败）：不成为一轮，不出现耗时行，不影响前后轮次和常显复制行 |
| T8 | goal 续跑的轮次 | unit | `trigger` 为 `goal`、没有 prompt 的 run：能折叠，有耗时行和复制按钮，不加标签；显示 goal 文字的用户消息照常显示 |
| T9 | 普通轮次不变 | unit + integration | 2026-09-29 折叠议题的全部现有用例改用 run fixture 后仍然通过：折叠条件、定稿前不折叠、插话阻止折叠、展开状态记忆、阅读锚点；有 prompt 的轮次耗时仍按 prompt 的时间 |
| T10 | 旧数据兜底 | unit | `trigger` 为 `user`、没有 prompt、run 里有 `subagent-status` 输入：按子代理显示标签；`trigger` 为 `user`、没有 prompt、也没有子代理输入：不加标签 |
| T11 | 失败与取消 | unit | `outcome` 为 `failed`、`cancelled`、`interrupted` 的唤醒轮次：不折叠，耗时行显示对应结局，有最终答案时仍可复制（与普通轮次的现有规则一致） |
| T12 | 顺序与常显复制行 | unit | 轮次按 run 的开始时间排序；常显的复制行在最后一个已结束轮次的答案上，包括唤醒那一轮；有轮次在运行时没有常显行 |
| T13 | 翻历史 | integration | 加载更早的消息后，较早的轮次能折叠、有耗时和复制按钮（以前超过 50 个 run 就会失效） |
| T14 | 字段缺失 | unit | run 没有 `outcome` 时：有 prompt 的轮次用 prompt 的状态判断折叠和结局文字；没有 prompt 的不折叠，仍显示耗时、答案和复制按钮。run 没有 `trigger` 时按 `user` 处理（再经旧数据兜底），不报错 |
| T15 | 真实会话走查 | 浏览器 | 让主代理派一个子代理、等它做完把主代理唤醒（真实 provider，或能派子代理的脚本模型）：唤醒那一轮出现 `Subagent update` 标签、折叠控件、耗时和复制按钮；复制得到这一轮的最终答案；刷新页面后显示不变 |

### Stage 3：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T16 | 耗时行按 run | unit | 与 T7 相同的数据：TUI transcript 有四行耗时，后三行带 `Subagent update`；有 prompt 的那一行位置与现在一致 |
| T17 | 翻历史与去重 | unit | `session-recovery` 合并 `UiSessionHistory.runs` 和该页的 prompt 后，较早的轮次也有耗时行；同一个 run 只出现一行耗时（按 `runId` 去重）；没有消息的 run 不生成耗时行 |
| T18 | 手工走查 | 手工 | 在 TUI 里打开 T15 的会话，看到每轮的耗时行和标签 |

## 4.3 集成边界

| 集成点 | 怎么验证 |
|---|---|
| run 账本与 runner | T1 用真实的 `submitPromptWork` 三条路径，不手工构造账本行 |
| 视图投影与增量事件 | T3、T4 走真实的 `source-session-projection` |
| Web store 与事件归约 | T13 用 `reduceUiEvent`、`replaceSnapshot` 走真实的 store |
| 消息复制 | T7、T12 复用消息复制议题的 `message-copy` 测试设施 |

## 4.4 回归清单

- `W/ui/conversation/run-process.unit.test.ts`、`run-process.integration.test.tsx`、`ConversationStream.unit.test.tsx`、`message-copy.unit.test.tsx`、`ExecutionProgress.unit.test.tsx` 改用 run fixture 后全部通过。
- `T/store/transcript.ts` 现有的耗时行测试通过。
- 运行状态相关测试：`UiRun.status` 的映射和 `selectActiveRun` 的行为不变。
- 子代理视图（`SubagentConversationBody`）显示不变。

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` |
| 自动化测试 | T1 至 T14（含 T1b、T7b）、T16、T17 通过 | `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` |
| 浏览器走查 | T15 通过，附截图 | 内置浏览器 |
| 手工 | T18 通过 | 本机 TUI |
| 文档 | 02 Stage 4 的文档已同步 | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 消息内容冒充子代理触发（例如用户输入里写 `subagent-status`） | 触发来源由后端在创建 run 时按提交方写入，不读消息正文；旧数据兜底只认运行时输入的类型标记（`runtimeInputKind`），用户输入不会带这个标记 | 无 |
| 某种新来源忘了配默认策略或传触发来源 | 默认策略表改为必须覆盖每个触发来源，新增取值时类型检查就会报错；创建 run 只有 runner 一个入口；T1b | 将来绕过 runner 直接写账本的代码 |
| 子代理的结果被当成用户发起的一轮 | goal 期间的唤醒提交方是 `goal`，触发来源按“是否带子代理状态输入”判断，单独测试（T1 第四种情况） | 无 |
| run 没有 `runId` 的消息被错误归入某一轮 | 投影只按消息上明确的 `runId` 归属，没有 `runId` 的消息原位显示，与 2026-09-29 议题一致 | 无 |
| 一个失败的唤醒轮次被折叠，用户看不到错误 | 折叠只在 `outcome === "succeeded"` 时发生 | 无 |
| 视图里的 run 列表过大 | 只保留已加载消息涉及的 run 和运行中的 run，规模与已加载消息成正比 | 极长的会话一次加载很多页时，run 列表随之变大，与 prompt 列表相同 |
