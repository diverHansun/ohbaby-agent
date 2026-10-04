# pi-tui 引入与 ohbaby TUI 重构

2026-10-01 开启，2026-10-03 更新。当前状态：**保留 React/Ink、按需复用 pi-tui；improve-1/2 为待实施计划，用户明确要求提前编写 improve-3，产品尚未实施、尚未验收**。

## 当前轮次地图

| 轮次 | 开启日期与依据 | 范围与状态 |
| --- | --- | --- |
| improve-1 | 2026-10-01，首轮主动切窄到 A/B | 阅读稳定、内容正确、基础视觉；00–04 齐备，05 未创建 |
| [improve-2](improve-2/README.md) | 2026-10-02，用户明确要求提前规划被切出的 C | 输入、草稿、审批与 Tasks 小修；00–04＋frontend/00–08 方案草案，待实施 |
| [improve-3](improve-3/README.md) | 2026-10-03，用户明确要求提前规划 D，并修订恢复交互 | 工具内联输出、Ctrl+O、pi Markdown/文本能力、取消 Ctrl+R 并自动恢复；00–04＋frontend/00–08，待实施 |

本次用户要求优先于此前“前轮 05 后才建下一轮”的规划时机约定；只提前写方案，不代表前轮已通过。当前阅读入口为 [improve-3](improve-3/README.md)；它取代本文件早期未定的独立详情入口和 improve-2 的 Ctrl+R 保留要求。improve-2 的 Stage 0 必须核对 improve-1 实际交付的输出和布局契约。下文“本轮”未另指时仍指 improve-1 的历史整理口径；当前新增范围以 improve-3 入口为准。

目标是降低终端基础设施的维护成本，改善输入、阅读和任务交互体验，同时保留 ohbaby 已有的提交、排队、恢复及权限语义。采用 `plan-code-improvement` 管理改造边界，采用 `plan-frontend-design` 讨论用户任务、布局、状态及交互。

## 已确认方向

用户原话与来源见 [00-discussion.md](plan/00-discussion.md)。

- pi 系列只引入官方 `@earendil-works/pi-tui`，不引入 pi 的 AI、agent 或 coding-agent 包；包自身的普通传递依赖不属于引入其他 pi 业务包。
- 默认 MainScreen 体验方向；当前保留 Ink，不等于已经选择 pi 的 `TuiMainScreen` 实现。
- 先保留 React/Ink，拆清现有组件中的业务逻辑，再按需要复用 pi-tui 能力并优化界面；不预设全量重写或最终删除 React/Ink。
- TUI 与 Web 保持同一套视觉语言；工具已确认少量分类色、只强调工具名，路径与命令保持中性色。
- 用户消息采用 OpenCode 式低对比中性底色与细侧线，正文保持正常文字色；具体色值与留白待终端验证。
- 六个区域的设计方向已确认：输入区轻边界，Permission 保留纵向选择，Tasks 保留结构并补计数/当前项/换行对齐。
- 底栏采用两行，只显示会话项目路径、模型与 effort 值、上下文百分比及当前 token/窗口总量、模式/权限值；省略 effort/Permission/Context 标签及 session ID，模型/effort 获取不到显示 unknown。
- Earlier history may be stale 不在 TUI 中提示；内部历史失效判断与刷新仍需修正。
- reasoning 正文默认隐藏，运行中只显示统一状态，完成后不保留逐段 Thought 标题/耗时。统一运行状态使用现有 working phrases 保留 ohbaby 特色，动画和状态切换规则待细化。
- Read/Glob/Grep 等默认简短摘要；Edit/Write/Bash 等呈现真实 diff 或相应输入/输出细节，具体预览规则已进入 improve-3。
- 对需要展示的 diff/输出等，短内容直接展示完整，长内容保留有意义的预览，Ctrl+O 原位切换紧凑／展开；不新增阅读页或工具浏览器，细节见 improve-3。
- 后续确认：Ctrl+O 展开详情，再按恢复正常紧凑 TUI；主动切换允许 Pi 式必要的一次清屏重印及原生回滚替换，普通后台刷新仍须稳定，不能删除会话事实。
- 优先适配 macOS，Windows 不作为当前同等优先级的专项验收对象。
- 后续可以跟随官方升级 pi-tui；当前未选择具体依赖版本。
- 用户已要求在 `plan/` 下列出 improve-x 的阶段职责、任务和注意事项；当前是阶段草案，具体范围讨论完成后再逐轮推进。

## 阶段与文档框架

用户已确认结束 improve-1 设计讨论。按此前建议，本轮聚焦 A/B：阅读稳定、内容正确与基础视觉；C/D 作为后续议题保留。正式契约见 improve-1/02，验收见 04。一个 improve-N 可有多个 Stage，不把五个主题直接绑定五轮，也不据此授权产品实施。

| 文档 | 职责 | 状态 |
| --- | --- | --- |
| [plan/README.md](plan/README.md) | 阶段地图与阅读入口 | 已建 |
| [plan/00-discussion.md](plan/00-discussion.md) | 用户原话、确认项与路线演进 | 已更新 |
| [plan/01-stage-roadmap.md](plan/01-stage-roadmap.md) | 候选实施批次 A–E 的任务、边界、完成判断与待讨论项 | 已审查修订，待讨论 |
| [plan/02-frontend-review-notes.md](plan/02-frontend-review-notes.md) | 布局、组件、样式及状态的审查补充 | 建议，具体设计待逐批确认 |
| [improve-1/00-discussion.md](improve-1/00-discussion.md) | 本轮用户输入、约束及讨论边界 | 已建立 |
| [improve-1/01-problem-analysis-and-current-state.md](improve-1/01-problem-analysis-and-current-state.md) | 问题基线、代码路径、隔离证据与测试缺口 | 调查基线 |
| [improve-1/02-optimization-plan-and-change-scope.md](improve-1/02-optimization-plan-and-change-scope.md) | 本轮范围、Stage、关键文件/符号、布局与数据约束 | 实施契约 |
| [improve-1/03-reference-projects.md](improve-1/03-reference-projects.md) | 本轮参考来源及采用/调整/不采用的理由 | 已整理 |
| [improve-1/04-test-and-acceptance.md](improve-1/04-test-and-acceptance.md) | T01–T16 与 Ghostty 真机验收 | 待实施执行 |
| improve-1/05-implementation-acceptance.md | 实施后的独立验收结论 | 尚未创建，实施完成后编写 |

修订后的候选批次 A–E：阅读稳定与内容可信 → 基础视觉降噪 → 输入/审批/Tasks → 工具内联预览与展开 → 整体验收。建议 improve-1 聚焦前两项；pi-tui 验证按实际能力穿插，业务拆分限于解决问题所需的范围，不预设完整渲染器迁移。

本轮从 00/01 进入 02–04 实施交接；02 包含用户要求的关键文件和符号。用户已经确认视觉方向与两行底栏。滚动输出实现仍需按 02 Stage 1 验证，再选择满足条件的最小方案；这不是已经证明 Static 或 pi 可修复的结论。05 仅在实施完成后创建。

涉及 UI 的轮次，结合 plan-frontend-design 依次讨论目标与用户任务、架构、线框、状态、组件、数据和验收。前端文档与改造文档互相引用，不重复定义；纯业务拆分不强行增加全套界面文档。终端尺寸用行列，状态包含焦点和终端生命周期，视觉验收使用真实终端，不机械套用 Web DOM/CSS 和浏览器要求。

## 总体依据与后续方向

以下保留议题级背景；各轮执行以各自 02 和 04 为准；旧建议与最新确认冲突时，以 improve-3 的明确修订为准。

### 1. 保留业务事实，按需复用终端基础能力

推荐沿用现有 `ohbaby-sdk`、会话同步及状态逻辑。只从 App、Prompt 和相关 hooks 中提取跨渲染器需要的应用行为：草稿、提交、排队编辑、恢复、审批生命周期等。

controller 接收“提交、停止、切换会话”等语义动作，不承担字素编辑、终端按键解析或每个列表的选中位置。编辑器、Markdown、字符宽度等是 pi-tui 复用候选，不预先指定全部采用。当前 React/Ink 继续负责界面，实际接入项再明确输入、焦点和刷新责任；ohbaby 始终负责消息/工具/权限等产品呈现。

保留真实的依赖边界即可，不为每个组件建 controller，不新增通用事件总线、依赖注入框架或第二份业务状态源。现有纯逻辑能用就用。

### 2. 按 MainScreen 的约束设计阅读体验

建议区分稳定历史、流式尾部和当前交互区。保持历史输出尽量稳定，模型、上下文、Todo、子代理等辅助信息按优先级显示；不预设常驻多栏或永久固定高度 dock。

当前保留 Ink，应先按其实际路径验证：macOS 默认动态 Box 历史，Windows TTY 默认 Static；固定预留 10 行和裁剪 live tail 不保证整个动态帧低于终端高度。Static 已输出内容不能靠普通 props 原地更新；重印历史与动态重绘的副作用均需验证。

作为未来选型参考，本地 pi 在宽度变化、高度变化（Termux 特例除外）及修改视口上方旧行时会走清屏重绘；这不是当前 Ink 的行为说明。两种方案都需验收 Markdown 排版变化、历史补载及恢复修正。当前 Ink 的源码事实与空间预算风险见 [前端审查补充](plan/02-frontend-review-notes.md#2-以当前-ink-为验证对象)。

用户已确认分类呈现：读取与搜索工具保留简短摘要，文件修改及命令执行在主时间线显示必要详情；不再将所有工具一律压成摘要。短 diff/输出直接完整展示，长内容保留有意义的预览。2026-10-03 已确认采用 Ctrl+O 原位展开，不采用 overlay、替换输入区或独立阅读页；见 improve-3 前端 03/04。不能为了输出稳定而丢弃后端的晚到修正或恢复后的真实数据。

依据：[pi MainScreen](../../../../pi/packages/tui/src/tui-main-screen.ts:277)、[旧行变化触发重绘](../../../../pi/packages/tui/src/tui-main-screen.ts:451)、[现有 transcript 投影](../../../packages/ohbaby-cli/src/tui/store/transcript.ts:40)。

### 3. 对齐 Web 的信息层级与语义

建议沿用低噪声呈现、用户输入可识别、最终回复易读、过程详情按需披露、待审批状态明确等原则。状态不只靠颜色区分；终端明暗背景和低色彩能力需要单独映射。

对齐视觉语言不意味着共享 React 组件、照搬 Web 气泡/侧栏，或立即抽取跨端主题包。先复用现有 TUI 语义 token；采用 pi-tui 组件时才映射到其主题接口。共享代码是否必要，等实际重复出现再判断。

### 4. 将定制限制在可维护的范围

用户已确认先保留 React/Ink，拆清业务逻辑，必要的组件再复用 pi-tui。删除现有依赖不是优化目标；后续逐项验证复用收益与适配成本。若发现完整接管才有价值，需另行讨论范围与回退；只有接管完成且旧入口退役，才核对不再需要的 CLI 依赖。Web 的 React 不在此范围。

本地 pi-tui 使用自己的 Component/render(width)/handleInput 协议，公开包未提供 React 适配层。单独借用纯工具函数可行，但将 Editor、焦点、输入和渲染调度嵌入 Ink 需要额外适配，不能把它当作即插即用的 Ink 组件库。长期让两个渲染器同时控制同一终端，或自建 React→pi-tui renderer，均不作为默认建议。迁移期间依赖共存、由独立入口择一启动，与同屏混合渲染是不同问题。

推荐直接依赖官方包并锁定所选版本，升级时核对对应源码、变更记录和终端回归结果。使用公开组件、主题接口和回调；不把访问私有成员、深层路径导入、修改 node_modules 或维护深度 fork 作为默认方案。

可集中管理启动/退出、主题转换及确有必要的兼容处理，但不要重新包装整个 pi-tui API。单纯统一 re-export 不能消除行为变化，也不能让升级天然安全。

当前只需要 MainScreen，不为假想的多渲染器支持建立运行时 Proxy 或切换协议。迁移时旧 Ink 入口是否暂留及如何退出，由后续范围和回退设计决定。

### 5. 以真实用户行为验证

建议分别验证不依赖 UI 的业务行为、模拟终端的输出/焦点，以及真实 macOS 终端的中文输入法、粘贴、缩放、回滚和复制。模拟终端不能证明真实 IME 或触控板体验。

pi 仓库的 `VirtualTerminal` 在测试目录，不能假定它属于发布包的公共 API。沿用现有测试中有价值的行为断言，等渲染层迁移时再替换相应 harness，不因测试文件长而整批删除重写。具体终端组合、基准场景和通过标准后续确定。

### 6. 工具按信息价值区分呈现（2026-10-01 继续讨论）

用户已确认默认隐藏 reasoning 正文，以及读类简短、修改/执行类展示细节的方向。以下是该方向下的细化建议，尚不是线框或验收定稿：

| 类型 | 建议默认呈现 | 需要保留的区别 |
| --- | --- | --- |
| Reasoning | 正文默认隐藏；运行中统一状态使用 working phrases，完成后不留下逐段 Thought/耗时（已确认） | 默认隐藏不等于删除；如何主动查看、是否展示整轮耗时待定 |
| Read | 工具名、路径，必要时显示读取范围 | 不默认打印文件正文；相对路径优先，项目外路径保留可辨识信息 |
| Glob / Grep | 工具名、pattern/query、搜索范围和可信的结果数量 | 0 个结果也可见；不完整扫描不能称为完整总数，截断不能伪装成全部结果 |
| Edit | 路径和带行号、增删符号、少量上下文的单列 diff | 待执行预览与实际成功修改区分；失败不能呈现成已修改 |
| Write | 新建文件展示新增内容预览；覆盖文件展示真实前后 diff | 没有旧内容时不能伪造删除部分，详情缺失需如实表达 |
| Bash / Shell | 命令、必要的工作目录、有限的输出预览和失败状态 | 不猜文件 diff；工具返回不代表后台作业结束，未知输出不标为 no output，不预设实时日志通道 |
| 其他工具 | 工具名、简短调用信息与结果/错误摘要 | 使用通用后备呈现，不为所有工具预建专用渲染器 |

建议使用很少几类呈现函数/组件与明确映射，不新增工具插件框架。展示分类不改变工具执行或权限分类；Bash 可能读也可能写，不将它整体视为文件写入工具。失败、待审批和被截断的信息应保持可见，但不自动倾倒整份输出。

MainScreen 下建议在当前调用位置生成最终摘要/预览，完成后尽量保持高度稳定；避免先打印数百行、完成后再缩成一行。仍需验收长任务、并行调用与流式更新，不承诺仅靠这种策略即可杜绝重绘。

代码核对：

- OpenCode 的 [Read/Glob/Grep](../../../../opencode/packages/tui/src/routes/session/index.tsx:2137) 使用紧凑行；[Edit](../../../../opencode/packages/tui/src/routes/session/index.tsx:2390) 展示 diff；[Shell](../../../../opencode/packages/tui/src/routes/session/index.tsx:2047) 展示命令和有界输出；[Write](../../../../opencode/packages/tui/src/routes/session/index.tsx:2105) 也有带行号内容块。借鉴其信息区别，不照搬全屏点击展开行为或阈值。
- pi 的 [Edit renderer](../../../../pi/packages/coding-agent/src/core/tools/renderers/edit.ts)、[Write renderer](../../../../pi/packages/coding-agent/src/core/tools/renderers/write.ts)、[Bash renderer](../../../../pi/packages/coding-agent/src/core/tools/renderers/bash.ts) 位于 coding-agent 包，不属于 pi-tui 公共组件。只能借鉴行为，以 ohbaby 数据和 pi-tui 基础组件实现，不扩大依赖。
- ohbaby [Edit](../../../packages/ohbaby-agent/src/tools/edit.ts) 已生成有预算限制的 diff，并写入 output/metadata；[Write](../../../packages/ohbaby-agent/src/tools/write.ts) 的 diff 目前仅出现在 dry-run 分支，实际写入后的结果不包含 diff。真实覆盖 diff 需要后续设计必要的执行结果数据，不能靠 TUI 事后读当前文件还原旧内容。
- [Glob](../../../packages/ohbaby-agent/src/tools/glob.ts:63) / [Grep](../../../packages/ohbaby-agent/src/tools/grep.ts:144) 已有数量和完整性 metadata，但当前 [流式结果投影](../../../packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts:193) 没有直接传递这些结果 metadata；[持久化结果投影](../../../packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts:85) 也不是通用透传。后续核对 SDK 的实时、恢复与历史读取链路，只补所需展示事实，不因 UI 需要直接泄露所有内部 metadata。

### 7. 保留 working phrases，明确运行状态的含义

用户已确认统一运行状态并指定沿用 [working phrases](../../../packages/ohbaby-cli/src/tui/components/working-phrases.ts:10)。短句是 ohbaby 自身的内容，可以保留；后续按实际选定的组件方案优化呈现，不以 pi-tui 重做作为前提，也不扩大 pi 包依赖。

当前 [WorkingSpinner](../../../packages/ohbaby-cli/src/tui/components/working-spinner.tsx:20) 在连续 running 且 runId 不变时保持短句不变；本轮探针确认 permission 往返使缓存键清空，恢复同一 run 也会重选。它仅在匹配当前 run 的 agent-step 模型请求运行中、尚未 firstTextAt 时显示；有 runtime.title 时优先显示 title。它并不覆盖整轮所有运行阶段。当前组件同时使用 spinner 与 [ShimmerText](../../../packages/ohbaby-cli/src/tui/components/shimmer-text.tsx:52)，两者各有动画计时器，并支持 OHBABY_TUI_NO_ANIM。上述为源码事实，不表示迁移后照搬这些实现。

细化建议，待讨论：

- 继续每轮选一句，轮内不轮播文案；短句表达产品个性，不作为真实 reasoning 内容。
- 模型等待和隐藏推理时展示短句；工具执行由工具行明确状态，审批、重试等待及错误优先展示真实情况。正文流式输出时避免重复的 Thinking 提示。并行模型/工具活动的优先级后续结合真实事件细化，不新增第二份业务状态。
- 只保留一种轻量活动效果，优先短句扫光；不默认叠加多个动画。保留关闭动画的能力，宽度不足时按终端显示宽度省略，避免状态区因长句不断换行。
- 统一状态只占当前活动区域，完成后撤下，不写入每段 Thought 历史。是否保留整轮耗时另定。

## 参考项目：本地源码调研摘要

调研日期为 2026-10-01。未运行这些参考产品，以下是源码事实和借鉴判断，不是视觉或性能验收结果。

| 项目与快照 | 已核实做法 | 建议借鉴及限制 |
| --- | --- | --- |
| pi `5fd446ca1`，本地 tui package 标记 `0.87.1` | 自有终端渲染器；公开 Editor、Markdown、theme 与 focus/overlay API | 复用官方基础能力；本地版本不等于后续要安装的版本 |
| OpenCode `16c56fe5`，tui `1.18.32` | OpenTUI + Solid；独立滚动区；弹层保存/恢复焦点；按状态控制工具详情 | 学习单列优先、焦点归属、摘要/详情；不照搬全屏布局、侧栏或渲染框架 |
| Kimi `be7d5f5f` | 使用仓库内 `@moonshot-ai/pi-tui` fork；主题适配；自有 controller/消息组件；部分编辑器定制访问私有方法 | 学习主题映射和组合组件；不能假定 fork 的能力在官方包中都有，也不复制其私有 API 耦合 |
| Gemini CLI `bedef96e` | React/Ink；普通模式区分 Static 历史与 pending 内容；Dialog/Composer 互斥；待确认工具不走紧凑呈现 | 学习稳定历史/当前交互区、空间优先级和确认状态；不移植多种 buffer 与虚拟列表系统 |
| 本地 claude-code / CCB `77a7934e` | README 表明是 Claude Code Best 恢复工程；有 Dialog 按键作用域、长粘贴预览、显示投影 | 仅作本地 CCB 行为参考，不声称是官方 Claude Code 源码；学习输入上下文保持与“展示不改事实” |

源码入口：

- OpenCode：[Dialog 焦点与生命周期](../../../../opencode/packages/tui/src/ui/dialog.tsx:81)、[会话区域](../../../../opencode/packages/tui/src/routes/session/index.tsx:1180)。
- Kimi：[fork 来源](../../../../kimi-code/packages/pi-tui/UPSTREAM.md:9)、[编辑器定制](../../../../kimi-code/apps/kimi-code/src/tui/components/editor/custom-editor.ts:197)、[主题映射](../../../../kimi-code/apps/kimi-code/src/tui/theme/pi-tui-theme.ts:30)。
- Gemini：[MainContent](../../../../gemini-cli/packages/cli/src/ui/components/MainContent.tsx:308)、[Dialog 与 Composer](../../../../gemini-cli/packages/cli/src/ui/layouts/DefaultAppLayout.tsx:61)、[工具确认](../../../../gemini-cli/packages/cli/src/ui/components/messages/ToolGroupMessage.tsx:47)。
- CCB：[仓库来源声明](../../../../claude-code/README_EN.md:12)、[Dialog](../../../../claude-code/packages/@ant/ink/src/theme/Dialog.tsx:21)、[展示历史与上下文区分](../../../../claude-code/src/components/Messages.tsx:534)。

以上外部源码链接依赖本机并列检出的参考仓库，不是项目运行依赖。

## 对分享讨论的核对与修正

[OpenCode 分享讨论](https://opncd.ai/share/am3ZATON) 已读取用户与 assistant 的正文。用户的选择承接为约束，其他 assistant 的分析和计划只作为待核实参考。

- “先拆再重写”有依据，但迁移不是简单替换组件：[`use-permission-sync.ts`](../../../packages/ohbaby-cli/src/tui/use-permission-sync.ts:1) 当前依赖 React hooks，包含订阅、超时和清理，需保留这些行为；可复用的是其 SDK 引擎及应用逻辑。
- 现有 transcript 有封存片段的设计，但也会更新已提交整条消息；不能把“所有 committed 内容永不变化”当成现有代码已经保证的事实。
- MainScreen 的重绘条件不仅包括宽度变化，还包括高度变化等条件；接入 pi-tui 不意味着可以跳过回滚、缩放和复制验收。
- 分享中将 `highlight.ts` 列为死代码，当前并不成立：[`markdown.ts`](../../../packages/ohbaby-cli/src/tui/render/markdown.ts:1) 仍然调用它。删除范围必须另查调用链。
- 分享中的 npm 最新版本和“五轮分工”不直接写入约束。当前不安装依赖、不切换参考仓库分支、不确定升级版本。

## 已有设计与后续讨论

旧 [TUI improve-3](../../ohbaby-cli/tui-improve-3/README.md)、[improve-4](../../ohbaby-cli/tui-improve-4/README.md) 是历史输入。用户本次已选择 pi-tui，旧文档“不迁移 pi-tui”的当轮范围不再限制本议题；它们的具体布局和阶段并未自动成为新方案。

Web 对齐参考：[UI 设计入口](../../ohbaby-web/ui/README.md)、[整轮过程折叠](../2026-09-29-web-run-process-collapse/improve-1/02-optimization-plan-and-change-scope.md)。其中直接修改历史高度的交互，需要按 MainScreen 约束重新讨论。

前一版已完成子代理与 Opus 规划审查。本轮再次根据实际截图和 Ghostty 反馈调研，新增控制序列、短句切换及历史提示隔离证据，详见 [improve-1/01](improve-1/01-problem-analysis-and-current-state.md)。设计讨论现已结束，首轮实施契约和验收要求见 improve-1/02–04。

本次只修改规划文档；没有实施产品代码或安装依赖。其他任务的工作区改动不属于本轮交付。


## 2026-10-01：本轮新证据与路线调整

主验收终端为 Ghostty；用户要求后续方案列关键文件和符号。当前已隔离复现：Ink 长动态帧在文字不变时反复清回滚；权限往返重新选 working phrase；无旧页时 stale 提示仍可常驻且 PageUp 无法清除。内部 subagent 消息已有 runtimeInputKind，Web 已筛选，TUI 显示投影未跟进。

因此首轮建议从阅读和内容可信切入，替代全面业务拆分先行的依赖顺序。真实 Ghostty 滚动、版本/配置、最终输出策略仍需验证，不把 Static 开关或采用 pi 当作已证实修复。图片的样式仅供借鉴，默认隐藏 reasoning、不保留逐段 Thought 的既有决定不变。
