# ohbaby-web · UI 组件

> `src/ui/` 各组件的呈现规格。对齐 [`../architecture.md`](../architecture.md) §3 的组件清单；状态可视化见 [`states.md`](./states.md)。[`design/session-screen.dc.html`](./design/session-screen.dc.html) 是历史视觉参考，header、composer 与 sidebar 以本规格和 improve-2 决策为准。

---

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

- **用户消息**：不显示角色图标或可见标签；使用低饱和浅天蓝气泡，位于阅读列右侧，桌面最大宽度约 76%，窄屏约 92%。消息 article 保留 `User message` 可访问名称；行内代码仍用 Plex Mono + 浅底 chip。
- **Agent 回复**：暂不显示 Lychee 名称或荔枝图标；不使用气泡，保持阅读列内左对齐正文。消息 article 保留 `Assistant message` 可访问名称。**流式期**等宽纯文本追加，**定稿**（`message.updated`）后 markdown+消毒渲染（见 [`../architecture.md`](../architecture.md) §4、[`../non-functional.md`](../non-functional.md)）。
- **工具调用披露行**：一次调用一行，透明无描边，整行点击展开。所有状态默认收起。工具名称保留语义色：read 金色、edit/write 绿色、其他蓝色；失败时仅名称变红。摘要不显示 `failed` 或错误文本，也不自动展开。
  - 连续工具行使用上下 2px 外边距，按钮上下内边距为 3px；hover 浅底、7px 圆角和左右内边距保持不变，让背景贴近文字且避免相邻 hover 块粘连。
  - 收起时箭头默认隐藏，hover 或 focus-visible 时显示向右 14px chevron；展开后持续显示并旋转向下。
  - 展开区分别显示 Input 和 Output。失败调用被主动展开时仍显示原始错误输出。
  - 长摘要只能自身省略，不得挤缩箭头。原生 button 保留 Enter/Space 可访问性，不增加全局快捷键。
- **思考指示器**（running 时）：三色波点 + `Thinking · {elapsed}s`；startup 时可显示 `starting agent`。Web 不常驻 Esc 教学文案；TUI 保留自己的中断提示。
- **定稿行**（idle 时）：如"Run stopped. 待审批的编辑已暂存"。
- **命令结果**：web-safe slash 命令的 running/error 以轻量 notice 出现在流内；只读成功结果（`/status`、`/help`、`/mcps`、`/skills`）优先用结构化 modal 呈现，不进入消息历史。无法识别的数据回退为安全文本/markdown notice。

---

## 3. Composer（输入区，底部 dock）

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

- **由 PendingPermission 队列驱动**：只渲染队首；多于一个时显示"还有 N 个待处理"。模态不持有独立状态，纯投影。
- **resync 时**：ViewState 整体重建 → 队列重算 → 模态自动刷新/关闭（该请求可能已被它端处置）。见 [`../use-case.md`](../use-case.md) UC3。
- **错主 403**：提示"该审批属于另一连接"，不误标为已处置。
- **断连**（`reconnecting`/`disconnected`）：按钮置灰，避免向死链路发应答。
- **策略联动**：仅当权限策略为 `default` 且有待决请求时出现；`full-access` 下不出现。
