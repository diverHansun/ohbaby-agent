# improve-5 实施与最终组合验收

> 后续用户截图反馈调整了首轮显示与 Web goal 入口；收尾需求、修复和补充验收见 [06](./06-prompt-and-composer-followup.md)。本页保留首次交付时的事实记录。

日期：2026-10-15。开发分支 `codex/goals-upgrade-improve-5`，基于 improve-4 最后提交 `17fdae14`。本记录对应 [04 验收契约](./04-test-and-acceptance.md)；原始方案和历史模块文档保留，不把当时的预期交付改写成当时已经实现。

## 交付与实施前核对

本批完成四项生产变更：同次准入的模型正文和 UI 短提示分别接线；删除非活跃目标自动注入；criterion 新写入 trim/6000 UTF-16 校验；SDK/CLI/Web 展示后端轮次与活跃时长。阶段架构见 [docs/goals/improve-5](../../../goals/improve-5/architecture.md)。

实施前核查确认 improve-2 的 ticket 已包含 modelText/displayText/turnNumber，store progress 已有静默事件链；improve-3 blocked/恢复与 improve-4 自动 steer 已落地。没有重新设计这些契约。Web 实际面板已经经过 improve-3/4 精简，所以沿当前布局局部加入两行数字，不恢复规划快照里的旧布局。

基线定向验证为 15 文件、229 项通过。首次新增 criterion 测试出现 11 个预期失败，证明空白、trim、UTF-16 边界与替换前校验确实缺失；消息路径测试复现实时显示全文和 paused 注入。UI 首轮新增断言有 5 个预期失败。随后修改生产代码并验证转绿。

SWE 取舍：正文和显示仍是一条普通 user 消息的两个消费值；复用既有 metadata、goal.updated、duration formatter 和局部 UI 组件。校验在聚合根完成；直接共用 objective 上限常量，避免两个常量漂移。没有数据库迁移、新事件、计时器、消息身份、通用注入框架或状态机扩张。

## U1–U14 证据

下表省略共同源码前缀：`adapters/` 和 `goals/` 位于 `packages/ohbaby-agent/src/`，`server/` 指 `packages/ohbaby-server/src/`。确定性 provider 用来控制边界，不冒充真实模型；真实 API 证据单独列出。

| ID | 证据与实际通过条件 |
| --- | --- |
| U1 | `adapters/ui-inprocess.contract.test.ts` 首轮 live 断言；`adapters/goal-context.integration.test.ts` 三轮 live 与持久正文/metadata；`server/runtime/daemon/goal-execution.e2e.test.ts` HTTP+SQLite 两轮 live/session/reconnect 短提示一致，正文完整。`adapters/ui-persistent.integration.test.ts` 关闭客户端和数据库后重开，仍显示 Goal started |
| U2 | `goal-context.integration.test.ts` 每条 goal 消息仍有独立且唯一的 model-context part，实际请求包含 environment_context、mcp_tool_catalog 与固定工具名；仅外部 MCP discovery 被替换为测试工具，菜单/装配使用生产代码。daemon E2E 另直接查 SQLite 的正文和 runtime part |
| U3 | `ui-inprocess.contract.test.ts` paused/blocked 普通输入、显式 pause 后 queued 用户请求不再含 light note；daemon E2E blocked 普通输入保留环境信息但无目标前缀，显式 GetGoal 仍读到目标和 Tokens。steer 与 complete 后 queued 输入分别验证原文 |
| U4 | daemon 确定性及真实 E2E 检查实际 session-title 请求包含 objective/正文；生成标题非空且不等于短提示。未要求模型使用英文或固定关键词 |
| U5 | `adapters/goal-blocked.contract.test.ts` 有/无 turnBudget、非零轮次和停止时长在 session view/snapshot/event 一致；daemon E2E 用新 remote client 重连检查，同一停止值不变；persistent integration 关闭/重开 SQLite 后数字相同；complete 后 goal=null |
| U6 | daemon 两轮测试只允许 created、显式 budget、budget exhausted 的三次语义 notice，计轮/usage 只刷新投影；初始零轮、两轮累计及停止时长都有断言 |
| U7 | 前批 blocked/resume、预算双维/反序/非法尾部测试随全量回归；HTTP blocked 恢复不清零。浏览器实际把 2/2 的目标以 3 turns + 1h 恢复，结束为 3/3，刷新仍保持 |
| U8 | CLI 真实 Ink renderer 在 40 列 resize 后数字仍可读；浏览器 1280×800 与 390×844 验证长 objective、短气泡、两行指标、折叠 Optional limits 和恢复操作。document scrollWidth 等于视口宽度，控制台无 warning/error；Active time 标签局部增宽避免多余折行 |
| U9 | `goals/injection.unit.test.ts` G20：自动提醒无 token，查询保留 total/cached/usage incomplete；现有 budget 测试验证轮次/时长预算；daemon 显式 GetGoal 查询另有断言 |
| U10 | `goals/store.unit.test.ts` trim 后 5999/6000 接受、6001 拒绝；3000 个非 BMP emoji 按 UTF-16 长度接受，加一个 code unit 拒绝；undefined/空串/空白省略。`persistence.integration.test.ts` 旧超长且带空白 criterion 原样回放 |
| U11 | `goals/persistence.integration.test.ts` 内存与 SQLite 两后端，replace=false/true 非法 criterion 均先于存在性和替换检查；原目标、轮次、用量、记录完全相同，重建后也不变 |
| U12 | `goals/injection.unit.test.ts` 首轮/续轮分别验证 objective 和 criterion 中闭合标签及 & 被转义，每个包装只出现一次 |
| U13 | 新 `adapters/goal-context.integration.test.ts` 走真实 runtime/ContextManager 自动阈值压缩与公开 compactSession 手动压缩：无 goal→goal 1/2轮→blocked→手动压缩→resume 第3轮→cancel→普通输入；全部 system 消息（含摘要请求）相同，旧 goal 普通 user 文本实际被压缩，单个活动摘要，歪曲摘要不改变 store 权威目标；原 `goals/goal-compact.integration.test.ts` SQLite 状态恢复用例继续通过 |
| U14 | `rg` 在 packages/apps 源码（排除 dist/node_modules）找不到 renderGoalContextNote、suppressGoalContextNote、promptTextForModel；类型检查通过。历史文档中的名称仅作为追溯记录保留 |

## 跨批组合

| 契约 | 本批证据 |
| --- | --- |
| 准入轮号、正文、短显示一致 | 新 context 集成与 daemon 两轮 E2E；`goal-execution.integration.test.ts` G26/G27 原 objective/epoch 场景继续验证新正文与累计计轮 |
| 迟到结算不污染新目标 | `goal-execution.integration.test.ts` 原 pause/resume 与 new-goal 场景补 UI turnsUsed/objective 断言：同目标恢复为2轮，新目标为1轮；旧用量保护继续通过 |
| blocked、恢复和数字共存 | U5/U7 及现有 Web/CLI 恢复契约；不为本批新增另一套恢复入口 |
| 完成及失败结算恢复 | 原 G21 recovery 集成、HTTP complete 尾部结算及重连 goal=null；不会恢复已完成目标，不重复 usage/clear |
| steer 与普通用户消息不被短提示覆盖 | 确定性 HTTP 和真实 API 均验证用户原文、自动 steered receipt、同轮输入消费；续轮才出现下一个 goal 短提示 |
| 截止与子代理范围 | `goals/goal-deadline.integration.test.ts`、`goal-execution.integration.test.ts`、adapter G24 等原测试随总回归执行，未修改 deadline/root 定点中断策略 |
| 请求空闲失败和展示 | `server/runtime/daemon/model-idle.e2e.test.ts` 默认确定性用例经真实 HTTP/SQLite 验证部分输出超时、目标暂停和后续服务可用；前批三 provider watchdog 单元/集成随总回归执行；本批不重复调用三个付费 provider 用例 |

## 实际运行记录

以下为最终代码冻结后执行的结果；定向测试不代替发布门。

| 检查 | 结果 |
| --- | --- |
| `pnpm test:unit` | 339 文件，4231 通过、2 跳过 |
| `pnpm test:contract` | 37 文件，550 通过；最后修改的 adapter contract 已另行复跑 |
| `pnpm test:integration` | 165 文件，1564 通过，含串行运行的 CLI 打包集成 |
| 确定性 HTTP E2E（goal + idle） | 2 文件，6 通过；4 个付费 opt-in 用例默认跳过，其中 goal 的真实用例已单独实际运行 |
| `pnpm test:smoke` | 命令正常结束，12 个 opt-in 用例全部跳过；不算实际 smoke 通过，真实 API 覆盖以上述单独执行的 E2E 为准 |
| 类型与 lint | typecheck 通过；全仓 lint 0 errors / 122 既有 warnings，最后修改文件 lint 通过 |
| 构建、格式、生成物 | `pnpm build` 完整通过，CLI 已复制 Web 资源；本批源码 Prettier 与 diff check 通过；没有意外生成物变更，base prompt 内容未修改 |
| CLI/Web | 上述 U8 自动化与浏览器实际验收通过；没有把 Ink renderer 测试称作日常配置下的人工 TUI 验收 |

开发中全量运行暴露了新增测试的 UiGoal 夹具缺字段、optional getSessionView 调用未收窄，以及一个错放的计轮断言；均修复。构建会编译测试源码，因此这些类型问题也使打包测试失败过；最终记录以全部修复后的执行为准，不把早先失败归为环境问题。

### 真实 API

按 `tests/models-4-tests.md` 使用 DeepSeek `deepseek-flash` / openai-compatible，独立临时 workspace/home/SQLite；凭据只由程序读取 `.env`。单次限制最多8请求、每请求60秒、测试150秒。共执行三次：

1. 首次实际走完两轮与完成，但测试错误要求标题含英文 telescope，模型给出合法中文标题，断言失败。移除语言限制，保留真实标题请求含 objective 的证据。
2. 第二次完整通过：5请求、2轮，35,396 total / 34,048 cache-read。独立复审随后发现第二轮请求查找会误命中 objective 中引用的 Progress 字样，这一运行不作为“第二轮正文已正确选取”的最终证据。
3. 将请求选择收紧为独立 `^Progress: N continuation turns,` 行后，第三次完整通过：**5请求（4 goal + 1 title）、2轮、35,443 total tokens、34,048 cache-read tokens、usageIncomplete=false**。完成通知恰好1次，返回准确 marker，自动 steer 成功，首/续轮正文和 runtime context、live/replay 短文案、标题来源、重连清理均通过，恢复项为0。

没有用此结果宣称所有 provider、长时间缓存命中率或真实模型摘要质量都已验收。

## 参考、审查与建议取舍

实际核对五个本地参考仓库，HEAD 与 [plan/03](../plan/03-reference-projects.md) 一致。Claude Code Best 是第三方实现，其双轨启发不意味着引入 isMeta 双消息；Kimi 数字形状可借鉴，逐秒推算与 criterion slice 不采用；Codex 的4000码点拒绝与700字节整段省略是不同策略，本项目保持6000 UTF-16拒绝；ZCode/DSH 主要用于请求空闲保护与编排分离的回看。

子代理先审查生产改动，再复核新增组合/E2E测试；未发现生产 P1/P2。第二轮查找断言漏洞已修复并重新真实执行。用户指定的 Pi 仅调用一次：`github-copilot/claude-opus-5.5`、medium，会话 `b243f964-461e-4e89-9918-6593116755f5`，启动目录为仓库根。Pi 只读审查未发现 P1/P2，完整原文已在聊天中展示，没有改写或入库为独立评审正文。

建议取舍：CLI 保留自然换行，40列测试可读，不采用可能截掉轮次的 truncate-end。时间仅显示已用活跃时间，不展示时间预算分母，预算详情仍主动查询。标题生成失败时临时标题可能保留 goal 正文的通用首句，这是既有行为，本批按“正文或 objective 为命名源”的约定保留，不改命名协议。新 SDK 必填字段需随 daemon/CLI/Web 一起发布，未实现新客户端连接旧 daemon 的额外兼容层。

watchdog 的 improve-5 回看已完成：生产 createIdleWatchdog 仍只有 llm-client streaming 消费，attempt/retry/partial usage 所有权未迁移，无新增独立使用者，维持原位置。

旧 docs/goals 原文保留，各相关页面顶部增加最新行为或 superseded 指引，新增 improve-5 架构页覆盖接口/流D/数据/用例/UI/测试变化。没有留下一个额外的“第6批纯测试”。大恢复原文的 MB 级重连压测仍未执行，也不宣称本批改变了其成本。

## 提交与合并

按职责分批提交，提交钩子的全仓 lint 和类型检查均通过：

| 提交 | 内容 |
| --- | --- |
| `1adbe248` | criterion 写入校验与原子替换保护 |
| `b15c1610` | 正文/短显示接线、inactive 注入删除、SDK/CLI/Web 数字与回放 |
| `99c9258d` | 自动/手动压缩组合回归、daemon 与真实 API E2E |
| `9cecaed6` | 阶段架构、逐项验收证据和历史文档指引 |

2026-10-15，发布门通过后，`codex/goals-upgrade` 与 `main` 均从 `62d99d14` fast-forward 到 `9cecaed6`，统一包含 improve-1 至 improve-5。核对三个分支指向同一提交，无冲突、无丢弃修改。本段是合并后的文档补记，随后同步到三个分支；没有远端推送。保留本批开发分支以便追溯。
