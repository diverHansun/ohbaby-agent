# improve-1：优化方案与改动面

> 2026-10-03 接续：用户已确认 [improve-3 Stage 1](../improve-3/02-optimization-plan-and-change-scope.md) 中 Ctrl+O 主动展开/收起时可进行必要的一次清屏重印，原生 scrollback 可被当前已加载会话投影替换。这是主动切换的限定取舍；本轮无变化刷新稳定、真实历史修正、顺序与内容正确性仍须通过，不允许普通通知反复清屏，也不代表前轮已验收。

2026-10-02 整理。用户已确认结束本轮设计讨论。本文把已确认要求与此前 A/B 范围建议整理为后续实施契约；**没有实施代码，也没有通过修复验收**。源码问题及基线见 [01](01-problem-analysis-and-current-state.md)，验证标准见 [04](04-test-and-acceptance.md)。

## 2.1 方案总览

本轮解决 Ghostty 阅读稳定、用户时间线内容正确，以及消息、活动状态和输入区的基础视觉问题。保留 React/Ink，复用已有 SDK、恢复与 store；只提取本轮需要的显示逻辑。pi-tui 不作为完成指标或依赖前置。

```text
SDK 快照/事件 ──→ 既有 store 与恢复逻辑（保存完整事实）
                         │
                         ├─→ 来源筛选 → 时间线划分 → 历史/流式输出
                         └─→ 当前会话状态 → prompt 与两行底栏

终端输出层统一负责：完整动态区域高度、刷新、历史输出与退出恢复
```

应用不能读取 Ghostty 的原生滚动位置并不妨碍规定结果：用户主动上滚后，不应被普通输出或后台通知持续拉回。不能捏造一个没有实际输入来源的 follow=false 状态。

## 2.2 设计决策

| 决策           | 本轮选择                                            | 原因与代价                                                                       |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| 渲染技术       | 保留 Ink/React，先验证输出策略                      | 问题已有明确路径；不会因采用 pi 自动解决。需要验证现有历史修正与终端回滚的兼容性 |
| 内部消息       | 在时间线划分/提交前按来源过滤                       | 已有 runtimeInputKind，无须新增来源协议；持久化和模型上下文不删改                |
| 历史失效       | 内部正确维护和刷新，不在 TUI 提示 stale             | 不转移提示位置；真正失败仍通过对应操作反馈                                       |
| 用户消息       | 中性完整区域、细侧线、正常文字色                    | 去掉文字长度的饱和蓝块；具体色值与间距由终端效果校准                             |
| 工具名称       | 少量类别色，参数/路径保持中性色                     | 对齐 Web 语义；类别和执行状态分开，不用绿色名称代表成功                          |
| reasoning/活动 | 默认隐藏正文和逐段 Thought，保留稳定 working phrase | 审批和错误仍显示真实状态；只保留一种活动效果                                     |
| 输入区与底栏   | 轻边界＋两行底栏，只显示已确认的四组信息            | 底栏增加的高度纳入整帧约束，保留编辑与历史键位                                   |
| 范围           | A/B 为本轮；Permission/Tasks 保持现有骨架           | 其视觉方向已确认，完整交互小修留给后续 C；完整工具预览/详情留给 D                |

## 2.3 分阶段实施

### Stage 1：复现与选择输出策略

以真实 Ink 加可控 FakeTTY 建立默认 macOS 路径基线，覆盖长动态历史、无内容变化通知、完整 App 的子代理订阅和动画。Ghostty 记录版本、窗口行列与是否经过 tmux/SSH，复现运行中和结束后的上滚。

重点文件：`components/transcript/committed-transcript.tsx`、`transcript-viewport` 相关组件、`layout/metrics.ts`、`app.tsx`；必要时核对 `ohbaby-sdk/src/subagent-reader.ts`。

技术验证顺序：

1. 分清后台通知、可见状态变化和 stdout 写入；减少无变化通知/输出，同时保留真实子代理及审批更新。
2. 验证稳定历史与有限活动区的输出分工，测量整个动态区域，不能只给 live tail 预留固定 10 行。
3. 如使用 Static，必须同时通过旧消息修正、历史补载、恢复、会话切换和 resize。不能仅改默认环境变量；更不能把已输出文本当成永不变的业务事实。
4. 选择通过 04 阅读与一致性测试的最小方案，实施提交说明记录选择依据。不访问 Ink/pi 私有成员、不修改 node_modules、不维护第二份业务状态。

**技术验证门**：当前证据还不能确定最终输出实现。若 Ink 候选都无法同时满足原生回滚与历史正确性，带失败场景和控制序列记录回到技术取舍；不得宣称完成，也不得自行切换 AltScreen、全量 pi renderer 或取消历史修正。此门不要求重开已经确认的产品视觉讨论。

DoD：04 的 T01–T04 能稳定区分修复前后；所选策略至少通过历史修正与无变化刷新测试，并取得 Ghostty 实际操作证据。后续样式叠加后必须再验一次完整场景。

### Stage 2：时间线内容与历史状态

- 按现有 Web 契约过滤内部 `subagent-status` / `subagent-result`，在 `splitTranscript` / commit 消费前生效。保留 user-steer、普通 system notice、正常用户消息，以及 assistant 对内部文字的合法引用；不做正文关键词屏蔽。
- 数据仍保留在 SDK/存储与模型输入中。来源筛选不能使内部消息把正常 assistant 尾部提前封存。
- `historyStale` 仅描述实际保留旧页的有效性。无旧页时不产生悬空 stale；刷新成功正确清除，失败保留可读历史及重试能力。
- TUI 不显示 Earlier history may be stale 或其改写，也不为了隐藏它屏蔽真实同步错误。避免后台更新反复刷新并重印全部历史。
- reasoning 默认不展示正文；完成后无逐段 Thought 标题或耗时。单独的保存失败提示若确有必要，用实际错误表达，不留下空标题。
- Subagent 工具摘要不使用整段内部 prompt。只使用已存在的可靠标题/对象字段，无标题时保留工具名及状态，不编造摘要内容。

重点文件：`store/transcript.ts`、`components/message/message-row.tsx`、`components/message/parts/tool-part.tsx`、`session-recovery.ts` 和 `app.tsx`。

DoD：T05–T08 通过；实时、恢复及旧历史使用同一显示规则，内部事实保留且普通消息没有误删。

### Stage 3：活动提示与已确认视觉

- 同一提交/run 的 working phrase 在模型重试、权限往返和普通重渲染中稳定；真实新 run 才重新选取。状态切换时可显示审批/重试状态，但恢复后仍使用原短句。
- 只保留一种轻量活动效果，不叠加 spinner 与扫光。不新建全局动画框架；复用组件与无动画开关。初值由真实终端观感和写入测量确定，结束及不显示时停掉动画计时。
- 用户消息改为中性完整区域＋细侧线；读/搜索、修改、执行/其他用少量类别强调，错误、待审批另有清楚状态。深浅背景和低色彩情况下文字仍清楚。
- 输入区使用轻边界；按 2.10 的两行线框呈现底栏。不更换编辑器，不重分配历史或补全键位。
- 模型/effort 订阅当前选择与会话偏好，不为每个 token 请求元数据。上下文复用 SDK/store 的后端数据，不累计聊天 token 或新增频繁轮询。

重点文件：`working-spinner.tsx`、`spinner.tsx` / `shimmer-text.tsx`、`theme/`、`message-row.tsx`、`components/prompt/index.tsx`、`render/usage.ts`、`app.tsx`。

DoD：T09–T14 通过，并重跑 T01–T04，证明卡片留白、底栏与动画叠加后仍可阅读历史。数据无变化、无输入、无活动动画的稳定窗口不应持续写 stdout。

## 2.4 按包的改动面

| 范围                  | 计划改动                                                                    | 边界                                                   |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| CLI TUI               | 修改显示投影、输出布局、恢复提示、动画和主题；可新增小型底栏投影/格式化函数 | 不把 App 全部搬进 controller，不新建通用组件平台       |
| SDK subagent reader   | 仅当 Stage 1 证明需要时减少等价状态通知                                     | loading/error/任务真实变化必须送达；补共享消费者回归   |
| SDK/model/context API | 使用已有公开接口和字段                                                      | 不新增来源 schema、模型协议或 token 统计逻辑           |
| Agent/server/Web      | 本轮不计划产品功能改动，作为来源契约及数据参考                              | 若发现必需字段缺失，记录具体缺口；不无条件扩张数据透传 |
| 测试                  | 保留有价值用例，新增默认路径和组合行为回归                                  | 不用改快照来掩盖终端控制序列或数据语义差异             |

本轮不计划删除依赖或安装 pi-tui。若某项独立基础能力验证出明确净收益，可另列可逆接入改动及版本/API 测试，不作为本轮完成的必需条件。

## 2.5 数据、兼容与生命周期

底栏取值约定：

| 信息      | 来源与显示                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 路径      | 当前 `UiSession.projectRoot`，不是 CLI 进程 cwd；可用 `~` 和中间省略。暂未绑定/缺失时显示简短 unknown，不沿用上一会话路径                       |
| 模型      | 当前选用模型；与旧 `usage.modelId` 区分。元数据缺失显示 unknown，不通过模型名猜 provider 或能力                                                 |
| effort    | 已识别能力＋兼容会话偏好，或已确认默认值；只显示 high 等值。未知为 unknown，明确关闭为 off，二值开启为 on，已知不支持为 n/a                     |
| 模式/权限 | `permission.mode/level`，显示 auto/default 等实际值；没有 Permission 标签，不猜默认授权                                                         |
| 上下文    | 当前会话后端 `contextWindowRatio/currentTokens/contextWindowTokens`；显示 `2% 20k/1m`，不带 Context，缺失仅简短占位。原始数值先计算比例再格式化 |

`2k/1m` 约为 0.2%，不能显示成 2%。小于 1% 时优先一位小数；极小正值可用 `<0.1%`，零才显示 0%。k/m 用小写；超出窗口的真实数值不能被改成零或正常低占用。上下文是后端估算快照，不承诺逐 token 精确实时变化。

模型切换、会话切换和异步返回须核对身份/请求代次，旧结果不得覆盖当前底栏。已在运行中的调用使用自己的事实；底栏当前配置不用于反写历史工具或解释旧请求。

历史修正和存储保留原协议；不迁移数据库。显示筛选不是删除消息。退出、Ctrl+C、异常与重入保持终端原始模式/光标恢复；Windows 既有路径不主动破坏，但本轮主验收仍是 macOS Ghostty。

## 2.6 风险与回滚

| 风险                                      | 处理与回滚                                                         |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Static 冻结旧内容、重复打印或补页打乱顺序 | Stage 1 先验证；输出策略独立提交，失败退回旧实现，不丢弃存储       |
| 减少通知导致审批/后台终态漏送             | 只消除等价状态；测试真正变化，SDK 优化可独立撤回                   |
| 来源筛选误删普通 system/assistant         | 依据结构化来源与角色契约；回滚仅影响显示，不恢复/重放模型输入      |
| 新底栏扩大动态帧、长中文越界              | 测整帧和显示列宽，重跑长历史组合场景；视觉改动与渲染策略可分开回退 |
| 当前模型与旧用量混淆                      | 分别维护数据来源和会话身份，不拿旧模型填新选择；按会话刷新已有数据 |

不要利用回滚机会重置其他任务的本地改动。此次规划期间仓库存在其他未提交工作，实施前记录其基线并限定本轮改动。

## 2.7 需求对应

P01 滚动由 Stage 1/3 负责；P02 动画由 Stage 3 负责；P03 来源、P04 历史提示由 Stage 2 负责；P05–P07 用户消息/工具/底栏由 Stage 3 负责；P10 历史键位在全部 Stage 中保持。P08 Permission、P09 Tasks 的完整改善是后续 C，本轮只确保现有面板与新布局组合时可用。

## 2.8 不在本轮

完整 pi Editor/渲染器替换、全面 controller 拆分、通用焦点或事件框架、新工具详情浏览器、完整 Write diff 数据链、任务依赖/负责人系统，以及重新设计 Permission 的授权语义。Permission/Tasks 已确认的视觉方向保留在 plan，后续单独落实；不提前建 improve-2。

已有输入字素和异步提交会话风险保留登记；本轮若触及相关路径需防回归，不能据此把输入系统全部重做。未来轮次在本轮 05 闭环后依据实际遗留事项开启。

## 2.9 关键改动清单

用户已要求列关键文件和符号。下列路径相对仓库根；行号是规划基线快照，定位以符号为准。不是实施进度表。

| ID  | 路径                                                                       | 符号/行号快照                                                                     | 主要责任                                                |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| C1  | packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.tsx | CommittedTranscript L19；shouldUseStaticTranscript L65                            | 历史输出边界和默认 macOS 路径                           |
| C2  | packages/ohbaby-cli/src/tui/store/transcript.ts                            | advanceTranscriptCommit L38；splitTranscript L309                                 | 来源筛选、live 分界和历史修正                           |
| C3  | packages/ohbaby-cli/src/tui/layout/metrics.ts                              | computeLayoutMetrics L18                                                          | 完整动态区预算，不限 live tail                          |
| C4  | packages/ohbaby-cli/src/tui/session-recovery.ts                            | createTuiSessionRecovery L75；historyInvalidated 分支约 L340；loadHistory 约 L444 | 失效有效范围、刷新成功/失败语义                         |
| C5  | packages/ohbaby-cli/src/tui/components/working-spinner.tsx                 | WorkingSpinner L20；useTurnPhrase L60                                             | 跨权限/重试稳定短句和活动效果                           |
| C6  | packages/ohbaby-cli/src/tui/components/message/message-row.tsx             | renderMessageParts L171；renderTextPart L294；renderSingleMessagePart L436        | 中性用户区域、分类色、默认隐藏 reasoning                |
| C7  | packages/ohbaby-cli/src/tui/components/prompt/index.tsx                    | Prompt L75；formatDockStatus L884                                                 | 轻边界、两行底栏、保护按键和草稿                        |
| C8  | packages/ohbaby-cli/src/tui/app.tsx                                        | 子代理 refresh effect 约 L165；Prompt 状态组装约 L924                             | 无变化更新、底栏当前数据、移除 stale 提示               |
| C9  | packages/ohbaby-cli/src/tui/render/usage.ts                                | formatContextWindowUsage L3                                                       | 百分比及小写 token 缩写；注意 status-panel 也调用此函数 |

连带项：`theme/colors.ts`、`theme/tokens.ts` 与测试；`components/message/parts/tool-part.tsx` 的 `formatPrimaryInput`；`spinner.tsx` / `shimmer-text.tsx`。如涉及 SDK，承重入口为 `packages/ohbaby-sdk/src/subagent-reader.ts` 的 `createSubagentReader` / `publish`，需共享消费者回归。

既有 TUI improve-3/4 和 spinner 文档作为历史基线；本轮采用本文与 04 的新约束，不追改其历史验收结论。没有新增独立模块文档树或第二份实施契约。

## 2.10 简要布局、状态与实现约束

已确认区域与两行底栏的合并示意；字符不规定具体色值或固定终端列数：

```text
│ 用户提交的消息                 ← 中性完整区域＋细侧线

  助手正文
  Read src/example.ts            ← 名称轻强调，路径中性

  一句 working phrase            ← 仅匹配的活动状态显示
  ────────────────────────────────────────────────────────
  > 当前草稿
  ────────────────────────────────────────────────────────
  ~/Projects/code-cli/ohbaby-agent             auto/default
  claude-opus-5.5 · high                       2% 20k/1m
```

现有 Tasks、审批和通知仍占自己的区域；图中未出现不表示删除。审批显示期间底栏不能遮住操作或改变选择键的归属。

| 状态               | 必须表现                                                       |
| ------------------ | -------------------------------------------------------------- |
| 普通等待输入       | 两行底栏稳定，保留草稿/光标；不出现 stale/逐段 Thought         |
| 模型等待或隐藏推理 | 特色短句和一种轻动画；不把它说成模型真实推理正文               |
| 正文流式/工具执行  | 正文/工具真实状态为主，不重复堆 Thinking；底栏只随实际数据更新 |
| 待审批             | 现有审批结构与选择行为保持；返回后草稿和原短句保持             |
| 运行结束           | 活动效果撤下，后台真实业务变化仍可更新；无变化不持续输出       |
| 切会话/数据暂缺    | 按当前身份更新，unknown/简短占位，不串用另一会话值             |

术语：auto/default 是 mode/level 的示例；high 是 effort 值；k/m 为 token 数缩写；百分比为当前上下文占用。界面不添加 effort、Permission、Context 前缀，但审批面板标题不受这条底栏限制。

宽度：120×40、80×24 验证正常两行底栏；窄至 60×20 优先缩写路径/模型，保留模式、权限和数值。极窄窗口应有界裁剪，不无限换行或破坏输入，不能承诺任意列宽都完整容纳所有文字。高内容面板、中文/emoji 与多行输入同时验收完整动态区。

必须遵守：用户已确认结构、无标签格式、内容来源与数据语义、现有按键、原生回滚目标。可调：中性色值、侧线色、微小留白和单一活动效果速度。视觉判断：用户消息可识别但不刺眼；正文最清楚；工具参数不被灰得难读；无色时仍辨认失败和审批。参考及 Opus 意见不能覆盖这些约束。
