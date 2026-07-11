# ohbaby-web · UI 设计

> `apps/ohbaby-web` 视图层（`src/ui/`）的设计说明。承接 [`../architecture.md`](../architecture.md) 的三层结构里的「视图层」，把组件、状态可视化、设计 token 落到可实现的细节。
>
> 上层模块设计见 [`../README.md`](../README.md)。本目录只管「长什么样、各状态怎么呈现」，不重复职责/数据流（那在父目录）。

## 设计源（source of truth）

> **导航目标已实施**：OpenCode 风格项目 rail、默认收起且按需展开的项目 session sidebar 与项目管理交互，以 [`../../problem-lists/2026-07-11-opencode-style-web-navigation/`](../../problem-lists/2026-07-11-opencode-style-web-navigation/README.md) 为 Phase 2 权威。下面的 claude.ai 稿继续作为 **ConversationStream / Composer / PermissionModal / 空态视觉**参考，不再定义全局项目导航外壳。

- **会话区视觉参考**：claude.ai 设计项目 `ohbaby-agent Web UI设计`
  （`https://claude.ai/design/p/7a9234b1-1b61-418c-a510-717646f32be8`）。
- **仓库内版本固定副本**（只读设计参考，需配 `support.js` + claude.ai 的 x-dc 运行时才能渲染）：
  - [`design/session-screen.dc.html`](./design/session-screen.dc.html) — 主会话屏（最终选定）
  - [`design/empty-state.dc.html`](./design/empty-state.dc.html) — 空态/就绪屏（最终选定）
- **本地导出来源**：`~/Downloads/ohbaby-agent Web UI设计/`（用户导出目录；上面两份即从此拷入，去掉空格/中文改为 ascii 名）。

> claude.ai 项目里另有探索板（`Directions` / `Empty Directions` / `Empty Explore` / `Spinner Explore`）——它们是 A/B/C 方案、字体与配色的**推敲过程**，非实现目标，仅作设计 provenance 保留在 claude.ai，不拷入仓库。

## 会话区屏幕参考

| 屏幕 | 文件 | 何时出现 |
|------|------|---------|
| 主会话屏 | `design/session-screen.dc.html` | 已建连、有会话——header/状态 + 流 + 输入框；外围导航由 Phase 2 三栏契约覆盖 |
| 空态/就绪屏 | `design/empty-state.dc.html` | 当前项目无会话或首屏未发 prompt——具体全局/项目空态由 Phase 2 契约补充 |

各状态（连接五态、run 态、空态、错误）的可视映射见 [`states.md`](./states.md)；组件细节见 [`components.md`](./components.md)。

## 设计哲学（呼应父目录 G3/G4）

单屏聊天、系统级技术观感、克制。preview 的价值靠**正确性可见**（连接五态、run 态、resync 时流的清空重建），而非堆砌。简洁优先。

## 锁定的 UI 决策（本轮）

1. **不暴露诊断行**：`seqNum / clientId / 端口` 是开发者信息，用户不需要——保持简洁。正确性仍在内部强制执行（seqNum 基线对齐、Last-Event-ID 续传、resync），只通过 **ConnectionState 五态**对用户可见；底层游标供开发者从 devtools/日志查看，不进 UI。
2. **权限用模态**：保留当前 inline bar 的视觉样式，但**实现为模态**——从底部**向上弹出（⏏️ slide-up）**。由 PendingPermission 队列驱动，resync 时自动刷新/关闭（见 [`components.md`](./components.md) PermissionModal、[`../use-case.md`](../use-case.md) UC3）。
3. **mode/policy 切换纳入 v0.1.6**：composer 底部的 **mode（auto/plan，⇧⇥ 切换）** 与 **权限策略（default / full-access）** 进入本期范围（见 [`../goals-duty.md`](../goals-duty.md) D3）。`full-access` 时不弹权限。

## 设计 token

- **字体**：`IBM Plex Sans`（正文）、`IBM Plex Mono`（技术读数：状态、路径、命令、行号）。当前经 Google Fonts 外链——与「轻量同源」略有张力，后续可自托管（记入 [`../non-functional.md`](../non-functional.md) 暂缓项）。
- **品牌三色**（取自 CLI logo 网格点）：gold `#c9a23f`、pink `#c97e92`、blue `#5f86c4`。
- **中性**：底 `#fafafa`、卡片 `#ffffff`、文字 `#26282d`、次要 `#8a8d94`、描边 `#ececec`。
- **语义色**（连接/run 态，见 states.md）：slate(蓝) / green / gold / red 四组，各带 bg/border/dot/txt。
- **动效**：`ohb-caret`（光标闪）、`ohb-pulse`（进行态点呼吸）、`ohb-wave`（三色思考波）；权限模态新增 slide-up。
