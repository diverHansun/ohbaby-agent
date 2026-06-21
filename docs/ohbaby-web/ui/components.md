# ohbaby-web · UI 组件

> `src/ui/` 各组件的呈现规格。对齐 [`../architecture.md`](../architecture.md) §3 的组件清单；状态可视化见 [`states.md`](./states.md)。参考实现：[`design/session-screen.dc.html`](./design/session-screen.dc.html)。

---

## 1. Header / StatusBar（顶栏，常驻）

一行白底栏，左右分布：

- **左**：品牌——2×2 三色网格点（gold/pink/blue/blue）+ `OHBABY` 字标（Plex Mono）。
- **右**（从左到右，竖线分隔）：
  - **连接状态胶囊**：彩点 + 文字，颜色/动效随 ConnectionState 五态变化（见 states.md）。
  - **模型名**：只读文字（如 `glm-5.1`）——**仅展示，非切换器**（模型切换是 ND5，延后）。
  - **上下文用量**：细进度条 + `32k / 200k` 读数。

**不含诊断行**：`seqNum / clientId / 端口` 不在 UI 呈现（决策 1）。状态胶囊是用户能看到的唯一连接真相。

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
- **思考指示器**（running 时）：三色波点 + `Thinking · {elapsed}s · double click esc to interrupt`——与 CLI 的 double-esc 中断一致（落 G3）。
- **定稿行**（idle 时）：如"Run stopped. 待审批的编辑已暂存"。

---

## 3. Composer（输入区，底部 dock）

- **输入框**：`>` 提示符 + 单行输入，聚焦环 + 轻阴影；`↵` 发送、`⇧↵` 换行。
- **动作按钮**：running 时显示 **Stop**（红方块图标）；idle 时显示 **Send ↵**（蓝）。
- **底部控件行**（本期纳入，决策 3）：
  - **mode 切换**：`auto mode` / `plan mode`，`⇧⇥` 循环；auto=green 点、plan=blue 点。
  - **权限策略**：`default`（ask before each action）/ `full-access`（run without prompts），向上弹出的小菜单选择。`full-access` 时**不弹权限模态**。
  - **右侧提示**：随状态变化（`↵ · send` / `double click esc to stop` / `press esc again to stop`，armed 时变红）。

---

## 4. PermissionModal（权限模态）

> 决策 2：保留 inline bar 的视觉样式（蓝调卡片：标题"Allow ohbaby to …?" + `操作 · 路径` + Deny/Approve 按钮），但**实现为模态**，从底部 **slide-up（⏏️）** 弹出，浮于 composer 之上。

- **由 PendingPermission 队列驱动**：只渲染队首；多于一个时显示"还有 N 个待处理"。模态不持有独立状态，纯投影。
- **resync 时**：ViewState 整体重建 → 队列重算 → 模态自动刷新/关闭（该请求可能已被它端处置）。见 [`../use-case.md`](../use-case.md) UC3。
- **错主 403**：提示"该审批属于另一连接"，不误标为已处置。
- **断连**（`reconnecting`/`disconnected`）：按钮置灰，避免向死链路发应答。
- **策略联动**：仅当权限策略为 `default` 且有待决请求时出现；`full-access` 下不出现。
