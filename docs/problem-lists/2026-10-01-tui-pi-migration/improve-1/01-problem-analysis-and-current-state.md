# improve-1：现状与问题分析

2026-10-01；ohbaby HEAD `637f3ca3`，调研时产品代码无本轮修改，现有未跟踪规划目录保留。**这是供讨论的现状草稿，不是实施方案或验收结论。**共同约束见 [00](00-discussion.md)，候选处理顺序见 [plan/01](../plan/01-stage-roadmap.md)。

## 1. 问题基线

| ID | 用户现象 | 证据等级与当前判断 | 候选批次 |
| --- | --- | --- | --- |
| P01 | Ghostty 上滚立即回到底部，结束后仍发生 | 已复现 Ink 长动态帧在内容不变时发送清回滚指令；真实 Ghostty 操作未复现 | A |
| P02 | spinner/短句刷新过快 | 实际组件隔离测得一秒 28 次输出；权限往返后同 run 会重新选词 | A/B |
| P03 | 内部 subagent JSON 直接显示 | 找到匹配注入模板，隔离确认内部来源消息进入 committed；未核对截图对应数据库记录 | A |
| P04 | stale 提示常驻且放错位置 | 隔离复现无旧页时仍 stale，调用 loadHistory 不请求且不清状态 | A/B |
| P05 | 用户消息颜色不舒服 | 深色饱和蓝背景逐行只铺文字宽度，低色彩降级 ANSI blue；与截图相符 | B |
| P06 | 工具全土黄色，长 subagent prompt 横铺 | 所有名称使用 tool.name；统一主参数回退到 prompt；与 Web 分类配色不同 | B/D |
| P07 | auto/permission、session ID 挤在底栏 | 实际为 permission.mode/level 加长 session ID，并拼接 runtimeStatusLabel | B |
| P08 | permission 尚可，希望优化 | 有完整交互基础；内部 intent 标签和模糊 Esc 文案可改，不能顺手改变审批范围 | C |
| P09 | Tasks 尚可，希望适度改善 | 已有状态符号、5 项紧凑列表和 Ctrl+T；需要保护现有行为 | C |
| P10 | 保留历史相关按键 | 用户意图明确，口述 PgUp/PgDn 与代码具体映射不同，需验收核对 | A/C |

已确认隐藏 reasoning、去掉逐段 Thought 的方向尚未落地：当前 completed reasoning 仍返回 Thought，图 6 的空标题并非新需求。

## 2. CLI 现状：七个分析维度

### 2.1 目标与职责

TUI 需要呈现会话、消息、工具、审批和任务；当前持久化消息集合与用户时间线没有完整分开。原生回滚属于终端，但应用通过清屏指令影响它。仅调整 React 组件样式无法解决所有阅读问题。

已有 `session-recovery`、store、stream-coalescer 可复用；权限同步调用 SDK 引擎。问题集中在显示投影、输出边界与刷新触发，不支持“先把所有 hooks 搬进新 controller”的必要性。

### 2.2 架构与终端输出（P01）

[CommittedTranscript](../../../../packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.tsx:65) 默认仅 Windows TTY 使用 Static；macOS 将所有 committed 历史放在动态 Box。安装版本 Ink 6.6.0 的 `build/ink.js:181` 在前一帧高度达到终端行数时写入 `ansiEscapes.clearTerminal`，先于第 194 行的内容变化判断。

[layout/metrics](../../../../packages/ohbaby-cli/src/tui/layout/metrics.ts:10) 预留 10 行只限制 live tail，不包含整个动态历史、Tasks、审批、notice 和多行 prompt。[App](../../../../packages/ohbaby-cli/src/tui/app.tsx:165) 在有 active session 时每秒刷新子代理；[SDK reader](../../../../packages/ohbaby-sdk/src/subagent-reader.ts:24) 每次 publish 新对象并通知，提供任务完成后仍重渲染的路径。尚未用完整 App stub 测得具体每秒清屏次数。

隔离验证使用实际 Ink、80×12 FakeTTY、idle prompt、内容不变重渲染 3 次：

| 场景 | stdout 写入 | 字节 | 清回滚 CSI 3 J |
| --- | --- | --- | --- |
| 3 行动态历史 | 0 | 0 | 0 |
| 40 行动态历史 | 3 | 2202 | 3 |
| 40 行 Static 历史 | 0 | 0 | 0 |

本轮临时探针命令为 `node /tmp/ohbaby-ink-scroll-probe.mjs`，主代理复跑得到相同结果。临时脚本不是仓库测试交付物；后续 04 需将上述条件固化为可维护测试。

Ghostty [ED 文档](https://ghostty.org/docs/vt/csi/ed)说明 CSI 3 J 清回滚区域，CSI 2 J 清当前显示。[配置文档](https://ghostty.org/docs/config/reference#scroll-to-bottom)的默认值为 keystroke,no-output。因此不能称普通输出必然导致 Ghostty 跳底；也未核实用户实际生效配置。

Static 不是已确定方案：[transcript](../../../../packages/ohbaby-cli/src/tui/store/transcript.ts:78) 明确更新整条 committed 消息，Static 会保留旧文本；Ink Static 只输出新增 items。晚到修正、旧页前插、恢复、切会话与 resize 尚需一起验证，不能以冻结错误历史换取稳定。

pi MainScreen 同样有 resize、视口上方旧行变更等全量重绘路径，见本地 `pi/packages/tui/src/tui-main-screen.ts:278`。其 previousViewportTop 是程序推算，不是用户原生上滚反馈；不应规划一个没有真实输入来源的 follow=false 状态。接入 pi 不等于滚动已解决。

### 2.3 数据模型与显示语义（P03/P04/P07）

[UiMessage](../../../../packages/ohbaby-sdk/src/snapshot.ts:114) 已公开 runtimeInputKind：user-steer、subagent-status、subagent-result。无需新增全局来源 schema 就能区分已知内部输入。普通 system notice 不等于内部观察，不能统一删除。

historyStale 表示客户端保留的旧历史页可能失效，不表示模型忘记历史。它的状态有效范围与实际可执行刷新动作目前不一致。auto/default 来自同一 permission 对象的 mode/level，不应擅自解释成两个独立产品模式。

### 2.4 数据流与接口（P03）

[continuation-coordinator](../../../../packages/ohbaby-agent/src/agents/subagents/continuation-coordinator.ts:241) 生成 Runtime subagent observation、observedAt、executions JSON 和 Assess progress 指令，作为带 runtimeInput.kind 的模型输入。经 current-run-inputs、source-session-projection、[persistent-store](../../../../packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts:223)，UI 消息已有 system role 和 runtimeInputKind。

[splitTranscript](../../../../packages/ohbaby-cli/src/tui/store/transcript.ts:309) 未过滤来源，系统消息进入 committed；[message-row](../../../../packages/ohbaby-cli/src/tui/components/message/message-row.tsx:443) 直接输出 system text。直接给 advanceTranscriptCommit 输入 subagent-status system message，返回 committedItems.length=1，正文保留，证明泄漏路径。

[Web ConversationStream](../../../../apps/ohbaby-web/src/ui/conversation/ConversationStream.tsx:79) 已过滤 subagent-status/subagent-result，保留普通 system、user-steer、assistant 引用。TUI 缺的是同一显示契约；仅在 MessageRow 隐藏还不足以阻止内部消息改变 live/committed 分界。未读取截图对应历史记录，不能完全排除截图恰为 assistant 引用；按来源过滤才能正确处理两者。

### 2.5 用户流程与状态（P04/P08/P10）

[session-recovery](../../../../packages/ohbaby-cli/src/tui/session-recovery.ts:340) 收到有效 historyInvalidated 就置 stale，无需实际存在 older；[loadHistory](../../../../packages/ohbaby-cli/src/tui/session-recovery.ts:444) 在 older 为空且 hasMore=false 时直接返回，不清 stale。[App](../../../../packages/ohbaby-cli/src/tui/app.tsx:937) 再将它塞进 Prompt 底栏。

隔离构造 ready 空历史、无旧页、hasMore=false，送入带 historyInvalidated 的有效 revision，调用 loadHistory：

```json
{"phase":"beforePageUp","stale":true,"hasMore":false,"messageCount":0}
{"phase":"afterPageUp","stale":true,"historyQueries":0}
```

用户最新要求是不在 TUI 显示此 stale 提示，替代此前移动提示位置的建议。删除文案仍不足以修复 P04；真正旧页失效时仍须有正确的刷新及失败保留内容行为。

[Prompt 输入分支](../../../../packages/ohbaby-cli/src/tui/components/prompt/index.tsx:629)当前映射：

| 场景 | PgUp | PgDn | ↑/↓ |
| --- | --- | --- | --- |
| 普通输入 | 读取/刷新服务端旧历史 | 没有该分支 | 已提交输入历史与草稿恢复 |
| slash 候选可见 | 上一页候选 | 下一页候选 | 逐项选择候选 |

用户认可现有体验，不能以该差异为由重分配键位。Ghostty 的键盘映射、实际组合键还需核对。

[PermissionDialog](../../../../packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx:140) 已分来源、描述、选项、同步、发送及错误；Esc 在有 deny 时选择 deny，没有时回退第一项。当前 safe default 文案不够明确；Always allow 的范围必须核对后端，不能复制参考项目的期限。

### 2.6 非功能性与视觉（P02/P05/P06/P09）

Spinner 为 80ms，Shimmer 为 55ms，计时器为 1s。[WorkingSpinner](../../../../packages/ohbaby-cli/src/tui/components/working-spinner.tsx:26) 以 running runId 缓存短句，非 running 改用空字符串；权限往返会重新抽词。实际组件探针一秒输出 28 次，动画期间 0 次重选；running → permission → 同 run 恢复，抽词累计 1→2→3。该单次样本不是稳定性能预算，也未测真实后端推送频率。

复跑命令：`OHBABY_TUI_NO_ANIM=0 FORCE_COLOR=1 pnpm exec tsx --tsconfig packages/ohbaby-cli/tsconfig.json /tmp/ohbaby-spinner-probe.mts`。动画频率与词句切换是两个问题；“同一提交内短句固定”目前不是所有状态下成立。

[用户色板](../../../../packages/ohbaby-cli/src/tui/theme/colors.ts:42)为 #2C5D8A；[渲染](../../../../packages/ohbaby-cli/src/tui/components/message/message-row.tsx:294)逐行只铺文字占用宽度，形成选中文本感。竖线源码是 muted 色，不能仅凭截图认定配置为黄色。所有工具名使用 [theme.tool.name](../../../../packages/ohbaby-cli/src/tui/theme/tokens.ts:132)，摘要主参数回退到 prompt，导致子任务描述横铺。

[Web toolAccent](../../../../apps/ohbaby-web/src/ui/conversation/tool-card.tsx:230)按 read→gold、edit/write→green、其他→blue；并非已经全部中性。用户已确认 TUI 借鉴少量分类色、只强调工具名；绿色类别不能被误读为执行成功，具体色值与明确分类映射仍待细化。

[Tasks](../../../../packages/ohbaby-cli/src/tui/components/todo-panel.tsx:13)已有紧凑 5 项、当前优先、符号与 Ctrl+T。它不需要为本轮滚动修复增加负责人、依赖图或新存储。

### 2.7 测试现状与缺口

本轮只读调查运行 6 个相关测试文件，合计 70/70 通过：session-recovery 23、persistent-store 21、Web ConversationStream 11，以及 transcript flicker、working-spinner、committed-transcript 共 15。没有运行全仓测试，也没有修复后验收。

绿灯未覆盖本轮缺陷：flicker 测试强制 OHBABY_TUI_STATIC_TRANSCRIPT=1 并关闭动画，未包含完整底栏/Tasks/审批；history 测试未覆盖无旧页仍 stale；Web 来源过滤测试不能证明 TUI 也过滤。

需要补充的风险场景：macOS 默认路径、整帧超高、内容不变后台通知、跨权限短句稳定性、来源过滤不改变 live tail、无旧页失效、真正旧页刷新失败及成功、Ghostty 真机上滚和复制。测试环境需要可控时间/消息事件，不能调用真实模型或执行实际工具来制造场景。

### 2.8 底栏新增要求与数据缺口（2026-10-02 核对）

用户已确定四组信息：会话项目路径、模型＋effort、上下文占用率、permission；不显示 session ID。SDK `UiSession.projectRoot` 已有但可缺省。Web `ReasoningControl` 根据识别能力、兼容的会话偏好及已确认默认配置呈现 effort，未知会显示 unknown，明确不支持则当前 Web 隐藏控件。TUI 常驻 effort 需要定义 off/on/n/a 的呈现，不能把所有情况都归为未知。

Web `selectContextModel` 从会话 usage.modelId 或 configuredModel 获取模型，缺省文案为 model pending，并非 unknown；本轮 TUI 按用户要求使用 unknown。不能简单复制该选择器而忽略切模型后旧 usage 与新选择的差异。Web `ContextUsageControl` 将缺失与真实 0% 区分。具体路径、符号及布局建议见 [plan/02 §8.3](../plan/02-frontend-review-notes.md#83-prompt-与底栏分组而非长句)。

## 3. 跨模块一致性与影响面

来源字段从 runtime 到 SDK 已存在，优先修 CLI 显示投影；Web 提供契约参考，无需更改模型输入或删除存储。SDK subagent reader 由多个界面共用，如调整通知策略要验证 Web 消费者；不能把所有后台更新停掉。

首轮可能触及 CLI 历史输出/布局、消息投影、恢复提示、动画、语义主题、prompt 状态呈现；是否需要调整 SDK 通知待方案验证。业务提交和队列模块保留现有正确行为，未复现的异步会话竞态继续登记，不混成已证根因。

## 4. SWE 原则审视

复杂度管理：现有恢复/store 可复用，先修真实边界而非新建框架。信息隐藏：模型内部观察不该借原始文本成为用户界面。单一事实来源：显示筛选不修改业务存储，终端安静不以停止同步为代价。可验证性：控制序列测试与 Ghostty 用户操作分别验收，避免受控测试掩盖默认路径。

## 5. 文档与实现对照

| 既有方向/说法 | 代码与证据 | 差距 |
| --- | --- | --- |
| 历史已提交、尽量稳定 | macOS committed 仍动态更新；Ink 超高帧反复清回滚 | 名称不等于输出不可变 |
| 同 run 短句不变 | 权限往返变为空键再变回 runId，会重选 | 需要跨状态稳定性 |
| reasoning 隐藏、结束不留 Thought | 当前仍输出 Thought 标题 | 已确认方向未落地 |
| 先全面拆业务，再改善 UI | 已有独立恢复/store；阅读缺陷可直接定位 | 原阶段依赖过强 |
| 前端统一消息语义 | Web 已过滤内部来源，TUI 未过滤 | 补显示契约即可，不必重做来源协议 |

本文件保留调查基线；2026-10-02 已将范围、布局和验收整理到 02–04。具体输出实现仍须通过 Stage 1 技术验证，不把候选方案当作已实施结果。
