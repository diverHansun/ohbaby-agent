# improve-1：测试与验收标准

> 2026-10-03 接续：用户已确认 [improve-3 Stage 1](../improve-3/02-optimization-plan-and-change-scope.md) 中 Ctrl+O 主动展开/收起时可进行必要的一次清屏重印，原生 scrollback 可被当前已加载会话投影替换。这是主动切换的限定取舍；本轮无变化刷新稳定、真实历史修正、顺序与内容正确性仍须通过，不允许普通通知反复清屏，也不代表前轮已验收。

2026-10-02。对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1–3。**这是待执行的验收契约，不是已通过记录。**前期 70 个现有测试通过只构成调查基线，不能证明本轮修复有效。

## 4.1 方法与测试范围

遵循项目 [docs-test](../../../../docs-test/README.md) 的分类、命名、目录及 mock 规则。本轮采用既有 Vitest/Ink 测试设施，不另建全仓测试标准。局部 unit/contract 与源码放在一起；跨 SDK/store/App 的集成场景放 `tests/integration/cli/`。新文件使用 `.unit/.contract/.integration.test.ts(x)`。

- unit：消息来源筛选、历史状态、短句生命周期、底栏字段与数字格式。
- contract：实际 Ink 输出和 FakeTTY，检查控制序列、行列与可见内容。
- integration：真实 SDK/store/recovery/App 协作，只替换可控后端/模型事件与时间。
- Ghostty 手工：触控板/滚轮上滚、复制、resize、中文输入、审批返回。模拟终端不能证明真机通过。

不调用真实模型、不执行实际写文件/删除/授权工具来构造样例。使用合成消息、工具结果、审批和子代理事件；验收批准的是 fake 事件。

## 4.2 关键场景

| ID  | 场景与验收点                                                                                                                                      | 类型/建议落点                      | Stage |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----- |
| T01 | 80×12 FakeTTY，短动态 3 行与长历史 40 行，初始化后触发 3 次内容不变更新。修复后两组均不反复发 CSI 3 J；无动画/输入时 stdout 无新增可见写入        | transcript 输出 contract           | 1、3  |
| T02 | 完整 App 加两行底栏、Tasks、notice、多行草稿、审批；长历史与子代理每秒等价通知组合。不能只测裁剪后的 live tail                                    | tests/integration/cli 下组合测试   | 1、3  |
| T03 | 历史晚到修正、旧页前插、重复事件、恢复与切会话。按消息身份保留正确内容/顺序，不冻结旧值、不双印或漏条目                                           | transcript/recovery contract＋集成 | 1、2  |
| T04 | Ghostty 中运行流式输出、工具执行、待审批、结束但子代理仍运行、全部结束五种状态分别上滚；连续观察不少于 10 秒，不被自动拉回，复制稳定              | 真机                               | 1、3  |
| T05 | 实时/恢复/历史的 subagent-status/result 不进入时间线；普通 system、user-steer、用户原文和 assistant 引用仍显示；持久化输入不变                    | transcript unit/contract           | 2     |
| T06 | 内部消息插在 assistant delta、工具结果之间，不改变正常 live/committed 归属，不截断回复                                                            | transcript contract                | 2     |
| T07 | ready、无 older、hasMore=false 时 historyInvalidated 不产生不可清除 stale；有旧页时刷新成功清状态，失败保留旧内容且可重试；重复通知不造成重印循环 | session-recovery unit              | 2     |
| T08 | TUI 不出现 stale 文案及换词版本，无逐段 Thought/空推理标题；实际同步错误和审批仍可见                                                              | 消息/完整 App contract             | 2、3  |
| T09 | 同 run 普通重渲染、模型重试、权限往返短句保持；新 run 才允许选新句；状态文案优先级真实                                                            | working-spinner unit               | 3     |
| T10 | 只出现一种活动效果；无动画开关有效；结束、隐藏、卸载不再产生动画写入。测同等窗口 stdout 次数/字节，记录与原 28 次/秒隔离样本的区别                | 动画计时 contract                  | 3     |
| T11 | 用户中性区域和细侧线；工具名称少量类别色、参数中性，失败/审批无色也可识别；中文/emoji/长路径按显示列宽裁剪                                        | 消息 contract＋真机截图            | 3     |
| T12 | 两行底栏顺序正确，无 session ID/effort/Permission/Context 标签；显示实际模型、effort、mode/level、当前会话路径                                    | prompt/底栏 contract               | 3     |
| T13 | 2,000/1,000,000 显示约 0.2% 2k/1m，20,000/1,000,000 为 2% 20k/1m；零、小正值、边界舍入、无数据/非法总量不伪造有效数据                             | render/usage unit                  | 3     |
| T14 | 模型/会话切换中让旧异步请求晚返回，不能串路径/effort/权限/用量；旧 usage.modelId 不覆盖当前选模；能力不兼容时不展示旧 effort                      | 底栏投影 unit＋集成                | 3     |
| T15 | 保留普通 PgUp 历史补载、slash PgUp/PgDn、↑/↓输入历史、草稿、粘贴和中文输入；审批进入退出不误提交，Ctrl+T/Tasks 原行为可用                         | prompt contract＋真机              | 全部  |
| T16 | resize、退出、异常、重入后光标和终端模式恢复；Windows 原兼容路径及低色彩输出不主动破坏                                                            | 既有相关测试＋真机                 | 全部  |

T01 的修复前基线是长动态帧三次清回滚、短动态和 Static 对照零次。正式测试要使用实际默认路径；不能用全局 `OHBABY_TUI_STATIC_TRANSCRIPT=1` 或关闭动画掩盖缺陷。无动画是对照组，默认动画仍须验收。

T03：数据正确与用户可读同时验收。快照中的数据更新了，但 Static 历史仍显示旧文本，不算通过。resize 或用户主动切换会话可能需要重绘，应记录触发条件；不把这些操作的结果冒充普通后台更新，更不能允许持续清空既有回滚内容。

## 4.3 Ghostty 验收步骤

1. 记录 macOS、Ghostty 版本、行列、是否 tmux/SSH 及影响滚动的有效设置；不改设置绕过缺陷。原生上滚验收以不随普通输出自动到底的配置为前提（Ghostty 默认 no-output）。若用户有效配置包含 output，记录该终端行为，并用独立受控配置做对照；不能要求应用逆转终端策略，也不能修改用户设置后冒充修复。
2. 使用可控测试驱动载入超过三屏的中英文历史，包含工具、用户消息和后台子代理；在 120×40 与 80×24 各走一遍 T04。
3. 从底部上滚至少一屏，停留 10 秒；持续发流式数据/等价后台通知。视图保持可读，复制一段跨行正文，再主动回到底部检查新输出仍完整。
4. 先输入未提交草稿，再打开 fake 审批，执行允许/拒绝样例并返回。审批期间保持现有 Prompt 禁用/焦点行为；返回后短句稳定、草稿未丢，后台任务真正变化仍更新。
5. 全部结束后继续发等价通知，界面不反复跳动；随后发送真实子代理状态改变，确认仍可见。
6. 缩放到 60×20，检查两行底栏和输入不越界；再恢复尺寸、切换会话、补载更早历史，确认无丢失/错位/重复。
7. 深色、浅色各记录关键界面截图；低色彩用受控测试加实际可用终端检查。截图证明样式，操作录像或记录证明滚动。

真机暂不可用时可先完成自动测试，但 T04/T15/T16 的对应部分记为未验证，不能将整体结论写成通过。主验收不要求将所有终端和 tmux/SSH 排列全部组合测试。

## 4.4 集成边界与回归

- 子代理 reader 的优化若跨 SDK，必须测试真实 loading/error/审批/终态变化仍通知，并运行 Web 相关消费者回归。
- 来源过滤位于显示路径；runtime 输入、持久化、session 恢复和消息身份不变。
- context.window.updated 沿既有 SDK/store 更新；测试不同 session 同时更新，不新增前端 token 估算。
- `render/usage.ts` 同时被状态面板使用，格式调整须检查 status-panel 既有行为；必要时将底栏格式与详情格式分开，不复制后端计算。
- Input/队列/审批语义保留，当前性能修复不能重新发送未知结果的提交、自动选择授权或改写用户草稿。

## 4.5 命令与完成条件

已有局部测试可从仓库根执行：

```bash
pnpm exec vitest run packages/ohbaby-cli/src/tui/session-recovery.unit.test.ts packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.unit.test.tsx packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx packages/ohbaby-cli/src/tui/render/usage.unit.test.ts
pnpm exec vitest run packages/ohbaby-cli/src/tui
```

实施者将新增测试的精确文件路径纳入相关命令；跨模块集成测试依 `docs-test` 放置并显式执行，不能因尚无文件而把 passWithNoTests 当通过。若修改 SDK，再运行其相关 reader 测试及 Web 消费路径测试。

提交与 PR 按项目 `docs-test/ci-strategy.md` 的现有检查执行。至少完成相关测试、format、lint、typecheck；正式提交/合并时执行项目要求的 test/preflight/integration/build，不为本轮另建 CI。记录执行命令、实际结果和环境限制；其他任务造成的基线失败单独归因，不掩盖本轮失败，也不顺手修其代码。

| 完成项     | 通过标准                                                               |
| ---------- | ---------------------------------------------------------------------- |
| 输出策略   | T01–T04 有证据，默认路径可读；历史修正未被牺牲                         |
| 内容可信   | T05–T08 无误删和内部信息外露，stale 状态不变成用户提示                 |
| 活动状态   | T09/T10 跨状态稳定，无多重动画和终态空转                               |
| 已确认设计 | T11–T14 两行与无标签格式正确，来源一致；真实终端观感符合中性、克制方向 |
| 行为回归   | T15/T16 保留既有输入、审批、Tasks、退出恢复                            |
| 最终记录   | 实施后另写 05，区分通过、未验证、遗留；规划期不提前生成通过结论        |

## 4.6 对抗性检查

| 最易出错的情况                    | 防御                                             | 仍需观察                           |
| --------------------------------- | ------------------------------------------------ | ---------------------------------- |
| 用 Static 绿灯掩盖 macOS 动态路径 | 默认环境与 Static 对照，检查 stdout 实际控制序列 | Ghostty 和真实滚动仍需操作验证     |
| 按正文过滤内部 JSON               | 来源/角色契约＋assistant 引用用例                | 旧记录字段缺失时不能凭关键词猜来源 |
| 为了安静停止所有轮询              | 等价与真实变化分别构造                           | 多个后台任务与审批交错             |
| 模型切换后旧异步值覆盖底栏        | 会话/模型身份和请求代次测试                      | 恢复快照与当前配置不同步           |
| 漂亮卡片/长草稿挤爆动态帧         | 完整 App 的高度和真机组合验收                    | 极窄/极矮窗口的有界降级            |
