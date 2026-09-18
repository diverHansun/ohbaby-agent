# ohbaby-web · UI 组件

> `src/ui/` 各组件的呈现规格。对齐 [`../architecture.md`](../architecture.md) §3 的组件清单；状态可视化见 [`states.md`](./states.md)。[`design/session-screen.dc.html`](./design/session-screen.dc.html) 是历史视觉参考，header、composer 与 sidebar 以本规格和 improve-2 决策为准。

---

## 1. Header / StatusBar（顶栏，常驻）

一行浅灰玻璃质感顶栏，左右分布；不支持模糊时使用实色浅灰：

会话顶栏约 44px 高，优先收紧上下留白；侧栏项目顶仍约 58px，两者底边不要求对齐。窄屏允许右侧状态换行并相应长高。

- **左**：与空态同一套黄、粉、蓝三段小写 `oh/ba/by` 字标；不显示旧点阵与大写字标。
- **右**（从左到右，竖线分隔）：
  - **连接状态文字**：只显示带颜色的状态文字，不加圆点和内层胶囊；running/connecting/reconnecting 轻微呼吸，其余静止（见 states.md）。
  - **模型名**：只读文字（如 `glm-5.1`）——**仅展示，非切换器**（模型切换是 ND5，延后）。
  - **上下文用量**：细进度条 + `32k / 200k` 读数。

**不含诊断行**：`seqNum / clientId / 端口` 不在 UI 呈现（决策 1）。状态文字是用户能看到的唯一连接真相。

---

## 2. ConversationStream（会话流，居中阅读列）

最大宽约 720px 居中列，纵向滚动。消息类型：

- **You（用户）**：小号大写标签 + 正文；行内代码用 Plex Mono + 浅底 chip。
- **ohbaby（assistant）**：三色点 + 标签 + 正文；**流式期**等宽纯文本追加，**定稿**（`message.updated`）后 markdown+消毒渲染（见 [`../architecture.md`](../architecture.md) §4、[`../non-functional.md`](../non-functional.md)）。
- **工具调用卡片**（可折叠）：三类，色彩区分——
  - `SEARCH`（蓝）：query + 匹配数；展开列命中文件:行。
  - `READ`（gold）：路径 + 行数；展开列带行号的片段，命中行高亮。
  - `EDIT`（green）：文件 + `+N/−M`；展开列删改行（红/绿底）。
  - 折叠态一行摘要，点击展开（chevron 旋转）。
  - 所有工具调用及孤立结果使用同一 14px chevron，长摘要只能自身省略，不得挤缩箭头。
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
  - **权限策略**：底栏左侧用灰色手形图标表示 `default`（ask before protected actions），红色盾牌叹号表示 `full-access`（run without approval prompts）；单击循环切换，无菜单。图标小、点击区约 32px，hover 出现浅边线，键盘焦点可见；按钮的可访问名称和 tooltip 写明当前策略含义及点击后的切换效果。`full-access` 时**不弹权限模态**。
  - **提示**：不常驻展示 Enter、Esc 或连接状态说明；编辑队列时保留 `Editing queued prompt · Enter save · Esc keep original`。连接状态由顶栏文字展示。

---

## 4. PermissionModal（权限模态）

> 决策 2：保留 inline bar 的视觉样式（蓝调卡片：标题"Allow ohbaby to …?" + `操作 · 路径` + Deny/Approve 按钮），但**实现为模态**，从底部 **slide-up（⏏️）** 弹出，浮于 composer 之上。

- **由 PendingPermission 队列驱动**：只渲染队首；多于一个时显示"还有 N 个待处理"。模态不持有独立状态，纯投影。
- **resync 时**：ViewState 整体重建 → 队列重算 → 模态自动刷新/关闭（该请求可能已被它端处置）。见 [`../use-case.md`](../use-case.md) UC3。
- **错主 403**：提示"该审批属于另一连接"，不误标为已处置。
- **断连**（`reconnecting`/`disconnected`）：按钮置灰，避免向死链路发应答。
- **策略联动**：仅当权限策略为 `default` 且有待决请求时出现；`full-access` 下不出现。
