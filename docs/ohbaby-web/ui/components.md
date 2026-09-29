# ohbaby-web · UI 组件

> `src/ui/` 各组件的呈现规格。对齐 [`../architecture.md`](../architecture.md) §3 的组件清单；状态可视化见 [`states.md`](./states.md)。[`design/session-screen.dc.html`](./design/session-screen.dc.html) 是历史视觉参考，header、composer 与 sidebar 以本规格和 improve-2 决策为准。

---

当前实现入口为 `App.tsx → session/SessionScreen.tsx`。App 负责挂载及空工作区切换；SessionScreen 负责 store 订阅、提交投影、Stop/恢复和跨功能组合。组件职责与产品呈现规格分开：下面的外观/交互不因文件迁移改变。

| 功能 | 当前实现落点 | 状态边界 |
| --- | --- | --- |
| 项目轨 / 目录选择 | `workspace/ProjectRail.tsx`、`workspace/directory-picker/DirectoryPickerDialog.tsx` | workspace 数据与导航由 runtime 提供 |
| 会话侧栏 / 状态 | `session/SessionSidebar.tsx`、`session/SessionStatus.tsx` | 接收会话/状态数据及动作 |
| 消息 / 工具 / 计时 / TodoDock | `conversation/ConversationStream.tsx`、`MessageRow.tsx`、`tool-card.tsx`、`ExecutionProgress.tsx`、`TodoDock.tsx` | 消息事实只读；根消息局部状态留在 conversation，子会话阅读缓存由根会话持有 |
| 输入 / 队列编辑 / reasoning | `composer/Composer.tsx`、`draft-storage.ts`、`ReasoningControl.tsx` | 唯一草稿、租约生命周期和键盘链 |
| slash / 结果 / 表单 | `commands/slashCommands.ts`、`SlashPalette.tsx`、`CommandResultModal.tsx`、`StructuredCommandOverlay.tsx` | 规则/展示/表单不复制 Composer draft；结果状态使用 commands 自己的窄类型 |
| 审批 / 策略确认 | `permissions/PermissionModal.tsx`、`PermissionPolicyControl.tsx` | 独立审批同步与局部确认/焦点 |
| 跨功能基础展示 | `shared/MarkdownBlock.tsx`、`ContextUsage.tsx` | 只读展示，不持有业务状态 |

Composer 通过 `topContent` 接收 SessionScreen 装配的 TodoDock，通过 `permissionControl` 接收权限策略控件。TodoDock 仍位于 Composer section 顶部、消息滚动容器之外，保留原身份 key、展开状态与 DOM 顺序。组件接收具体 model/数据/能力，不接整个 runtime 或 ViewModel。样式由 `ui/styles.css` 按原顺序导入 14 个连续块，功能规则随所属目录放置。

结构规格见 [Web improve-3](../improve-3/02-change-spec.md)，阶段行为与验收归[中央 improve-2.1](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/README.md)。

## 0. ProjectRail / SessionSidebar（项目轨与会话侧栏）

- 会话侧栏以宽度动画展开和收起，内容在动画中不重排。
- `New session` 使用 `SquarePen` 方笔图标和英文文案；默认透明、无描边，hover/focus 时整块显示浅灰底。按钮左右完整留白，不得贴住或裁到侧栏右边缘。

---

## 1. Header / StatusBar（顶栏，常驻）

一行浅灰玻璃质感顶栏，左右分布；不支持模糊时使用实色浅灰：

会话顶栏约 44px 高，优先收紧上下留白；侧栏项目顶仍约 58px，两者底边不要求对齐。窄屏允许右侧状态换行并相应长高。

- **左**：与空态同一套黄、粉、蓝三段小写 `oh/ba/by` 字标；不显示旧点阵与大写字标。
- **右**（从左到右，竖线分隔）：
  - **连接状态文字**：只显示带颜色的状态文字，不加圆点和内层胶囊；running/connecting/reconnecting 轻微呼吸，其余静止（见 states.md）。
  - **模型名**：只读文字（如 `glm-5.1`）——**仅展示，非切换器**（模型切换是 ND5，延后）。
  - **上下文用量**：16px 圆环。已有 usage 时显示蓝色进度弧，hover 提示百分比与 token，点击打开明细；尚无 usage 时仍显示诚实的灰色空环，提示数据暂不可用，不编造 0% 或 token 数。

**不含诊断行**：`seqNum / clientId / 端口` 不在 UI 呈现（决策 1）。状态文字是用户能看到的唯一连接真相。

---

## 2. ConversationStream（会话流，居中阅读列）

最大宽约 720px 居中列，纵向滚动。消息类型：

- **根会话用户消息**：不显示角色图标或可见标签；使用低饱和浅天蓝气泡，位于阅读列右侧，桌面最大宽度约 76%，窄屏约 92%。消息 article 保留 `User message` 可访问名称；行内代码仍用 Plex Mono + 浅底 chip。
- **Agent 回复**：暂不显示 Lychee 名称或荔枝图标；不使用气泡，保持阅读列内左对齐正文。消息 article 保留 `Assistant message` 可访问名称。**流式期**等宽纯文本追加，**定稿**（`message.updated`）后 markdown+消毒渲染（见 [`../architecture.md`](../architecture.md) §4、[`../non-functional.md`](../non-functional.md)）。
- **普通工具调用披露行**：一次调用一行，透明无描边，整行点击展开。所有状态默认收起。工具名称保留语义色：read 金色、edit/write 绿色、其他蓝色；失败时仅名称变红。摘要不显示 `failed` 或错误文本，也不自动展开。
  - 连续工具行使用上下 2px 外边距，按钮上下内边距为 3px；hover 浅底、7px 圆角和左右内边距保持不变，让背景贴近文字且避免相邻 hover 块粘连。
  - 收起时箭头默认隐藏，hover 或 focus-visible 时显示向右 14px chevron；展开后持续显示并旋转向下。
  - 展开区分别显示 Input 和 Output。失败调用被主动展开时仍显示原始错误输出。
  - 长摘要只能自身省略，不得挤缩箭头。原生 button 保留 Enter/Space 可访问性，不增加全局快捷键。
- **思考指示器**（running 时）：三色波点 + `Thinking · {elapsed}s`；startup 时可显示 `starting agent`。Web 不常驻 Esc 教学文案；TUI 保留自己的中断提示。
- **定稿行**（idle 时）：如"Run stopped. 待审批的编辑已暂存"。
- **命令结果**：web-safe slash 命令的 running/error 以轻量 notice 出现在流内；只读成功结果（`/status`、`/help`、`/mcps`、`/skills`）优先用结构化 modal 呈现，不进入消息历史。无法识别的数据回退为安全文本/markdown notice。

---

### 2.0 运行过程与 Thought 披露

正常成功、输出已定稿、有最终正文、没有 steer、且确有过程可折叠时，前端自动收起该 run 的过程。运行中和最终回复仍在流式输出时保持显示；失败、停止、中断、有中途补充或没有最终正文时正常展示。只归入明确关联 runId 的消息，用户消息与最终正文始终可见。最终消息自身的 reasoning 也由过程入口控制。

`Total {time}` 是整轮过程顶部的固定入口，时间和箭头组成同一个按钮。收起时正文在入口下方；展开时过程向下显示，顺序为 Total → 过程 → 最终正文。入口不随过程被推到底部，手动切换不触发底部跟随，保留入口在视口中的位置。没有过程时仅在正文前显示耗时。既有失败文案、acceptedAt/createdAt 口径和恢复时的未知耗时保持不变。手动展开在当前挂载期间保留，刷新页面可恢复默认收起。

Thought 使用 12px 线条箭头并常显，整轮使用 16px，均与文字间隔 8px。耗时箭头在 hover/focus-visible 时显示，无 hover 设备常显；隐藏时保留空间。原生 summary/button 支持键盘操作，按钮通过 aria-expanded/aria-controls 描述状态。隐藏过程不卸载工具卡，保留局部展开状态；显式定位先展开，过程中的焦点和阅读锚点迁移到可见入口。

方案与验收：[Web 运行过程折叠 improve-1](../../problem-lists/2026-09-29-web-run-process-collapse/README.md)。

### 2.1 子代理委派与只读子会话

已接受的 `subagent_run` 在主会话中显示为紧凑单行任务入口，包含省略长文的标题、短状态、耗时和进入箭头；状态使用可读英文，例如 `Timed out`。接受前失败且没有 execution 时保留普通失败工具卡，Input / Output 和错误仍可展开。普通工具维持原有披露方式。新状态行用留白分隔信息，不追加顶部 Subagents 栏。

一次只打开一个子会话。默认浮层位于主内容列内、真实输入框上方 10px，最大宽度约 800px；按真实输入框边界对齐并限制在主列内，高度随可用阅读空间变化。根输入框仅在主会话中锚定主内容列，避免被侧栏遮挡；空态输入框继续参与文流布局。白底、浅边、12px 圆角和阴影区分浮层与背景，桌面标题栏约 44px。首次打开用约 180ms 的 18px 上滑淡入，切换子任务或放大/收起不重播，减少动态效果设置下禁用动画。没有遮罩，点击外部不关闭，露出的其他委派行仍可切换子会话。标题栏的放大、收起、关闭按钮使用图标并保留可访问名称。放大页显示父会话到子会话的路径；切换尺寸不卸载消息流、不重新播放内容。浮层不重复显示 Read-only 底栏，放大页保留该说明；跳转最新使用轻量箭头按钮。

子会话复用主会话的文字、思考和工具组件。每条父代理输入使用蓝色用户气泡和 `From parent` 标记，已接受但未开跑的委派显示 `Queued`。同一逻辑子代理的多次委派属于连续时间线；点击任务行优先定位对应父消息，缺少可靠锚点时显示说明，不猜测。只有正文为空且后端提供存档结果时，才显示一次 `Stored result`。

工具展开和阅读位置按逻辑子代理保存于根会话的小型缓存中，切换子会话及关闭重开均可复用；显式委派定位优先于缓存位置。打开时焦点进入标题，Tab 在子会话内循环；Escape 先从放大页收回浮层，再关闭浮层，IME 组合输入不触发关闭。关闭后将焦点还给触发任务行，失效时回到根阅读区。

---

## 3. Composer（输入区，底部 dock）

Composer 保留唯一键盘链：先过滤 IME；候选打开时方向/Page、Tab、Enter、Esc 处理后当次结束；其后才处理发送、退出队列编辑、Shift+Tab 切 mode 和双 Esc Stop。鼠标和键盘走同一命令动作。同步补全直接更新本地 draft；异步清空及 skills 回填必须匹配发起 scope 与编辑 revision，失败保留草稿；prefill nonce 不能代替这两个校验。

子会话浮层打开时，根输入框保持原形状和草稿，显示 `Read-only subagent`；Todo、队列和输入控件暂时隐藏并禁止操作。放大子会话时整个根输入区隐藏，关闭后恢复原有内容。子会话不提供独立输入框，Send、Steer、Stop 仍需回根操作。

- **输入框**：最大宽约 800px，阅读列仍 720px；无装饰性 `>` 提示符。输入文字与占位约 14px / 22px 行高，1–7 个视觉行自适应，第 7 行后只在 textarea 内滚动；`↵` 发送、`⇧↵` 换行。输入框下缘距窗口底约 10–12px。
- **slash 输入**：以 `/` 开头时不作为普通 prompt，而是走 `UiSlashCommand` 解析/执行。v0.1.6 做 web-safe 候选面板、分组、`↑/↓` 选择、`Tab` 补全、`Enter` 执行、`Esc` 关闭；解析失败要保留草稿并显示错误。详细规格见 [`slash-commands/`](./slash-commands/README.md)。
- **动作按钮**：输入框内底栏右侧始终只有一个主操作位，使用固定尺寸圆形图标按钮，不显示 Send/Stop/Save 文字。idle 或有草稿时显示纸飞机；发送请求待确认时圆内显示转圈；running / waiting-for-permission 且草稿为空时显示方块 Stop；running 且草稿有字时纸飞机进入队列；编辑已有队列条目时仍显示纸飞机，点击成功更新原条目并继续调度，不新增消息。`aria-label`/`title` 仍按语义区分 Send、Stop、Save queued prompt。重连或重同步期间依最后已知 run 状态保留按钮外观，但按钮不可点，顶栏显示连接状态。
- **思考强度**：有思考能力的模型在输入框内、圆形主按钮左侧显示大脑和英文档位；主按钮缩窄后控件随弹性布局向右靠近，并保留输入宽度。平时透明无边，hover 有浅灰细边，键盘焦点清晰可见。检测中只转大脑、unknown 显示 `unknown`；无思考能力时不留空位。
- **框内底栏**（决策 3）：
  - **mode 切换**：默认 auto，无可见 mode 按钮或文字；`⇧⇥` 循环 auto/plan。auto 保持浅灰输入框描边，plan 使用浅黄描边；输入框可访问说明包含当前 mode。
  - **权限策略**：底栏左侧用灰色手形图标表示 `default`（ask before protected actions），红色盾牌叹号表示 `full-access`（run without approval prompts）。图标小、点击区约 32px，hover 出现浅边线，键盘焦点可见；按钮的可访问名称和 tooltip 写明当前策略含义及点击后的切换效果。
    - 从 `default` 点击进入 `full-access` 时，先显示简约英文确认卡；主按钮是「Use full access」并获得初始焦点，Enter 立即确认。Not now、Esc 或点击浅遮罩均不改权限，并把焦点还给权限图标。
    - 从 `full-access` 点击回 `default` 时立即降级，不显示确认卡。
    - 此确认卡只确认策略升级，不复用工具审批 `PermissionModal`；`full-access` 时仍不弹工具审批模态。
  - **提示**：不常驻展示 Enter、Esc 或连接状态说明；编辑队列时保留 `Editing queued prompt · Enter save · Esc keep original`。连接状态由顶栏文字展示。

---

## 4. PermissionModal（权限模态）

> 决策 2：保留 inline bar 的视觉样式（蓝调卡片：标题"Allow ohbaby to …?" + `操作 · 路径` + Deny/Approve 按钮），但**实现为模态**，从底部 **slide-up（⏏️）** 弹出，浮于 composer 之上。

- **子会话阅读期间**：审批同步继续更新，但审批操作仅在根会话提供；子会话只显示 `Approval required` 短提示，关闭子会话后回根审批，不另加返回按钮。
- **由独立审批列表驱动**：按 createdAt/id 稳定排序，单卡显示；多于一个时提供 Previous/Next，可以处理非首项。卡片简短显示 Main agent 或真实来源名称，缺名称回退 sessionId。
- **独立就绪**：只有 permissionSync=ready 时允许回答；审批基线和增量不等待聊天/model，整页旧 permissions 不能覆盖卡片。每次 hello、切范围和显式恢复都使用同一有界恢复器。
- **应答结果**：同根多页任一处可答；PERMISSION_NOT_PENDING 触发同步，PERMISSION_SCOPE_CHANGED 拒绝旧绑定，PERMISSION_UNAVAILABLE 停用审批且不自动重试。
- **断连**（`reconnecting`/`disconnected`）：按钮置灰，避免向死链路发应答。
- **选项**：Allow once、可记忆时的 Always allow、Reject；无 Cancel run。拒绝只结束该请求，always 只记住真实来源 session 的规则，不切换 permission level。full-access 的新调用不再产生人工 ask；显示依据仍是实际 pending。

实际根审批卡显示时，Composer 连同 TodoDock、输入队列隐藏但保持挂载；卡片底部留 12px，消息流按卡片实测高度留白。审批同步错误没有实际请求时仍保留输入区。审批标题接收焦点，停止图标调用原根停止逻辑。
