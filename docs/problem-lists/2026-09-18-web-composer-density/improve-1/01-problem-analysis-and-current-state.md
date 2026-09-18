# 1. 问题基线与当前实施状态

> 时间口径：规划时分支 `codex/temp-web-composer-send-stop`，HEAD `d0ce7faf`（send-stop 已落地、本议题尚未改代码）。分析对象是当时工作区的 Web UI，不是目标态。

---

## 1.1 问题陈述

1. **发送钮仍是带字扁胶囊。** `.ohb-send-button` / `.ohb-stop-button` 与 `.ohb-button-primary` 共用 `min-height: 36px; padding: 0 13px`，图标旁还有 `<span>Send</span>` / `Stop` / `Save`。窄屏才藏字，桌面看起来大。
2. **空输入框偏高，也不会随视觉行长。** textarea `rows={1}`、`resize: none`、`min-height: 24px`，没有按 `scrollHeight` 增高，也没有封顶后的 `overflow-y: auto`。外框 padding 9/10/16，空着也像一块厚卡片；窄屏自动折行也需要计入 7 行上限。
3. **连接状态是胶囊加点。** `StatusPill` 渲染空 `<span />` 圆点 + 字，`.ohb-status-pill` 圆角 999 + 实底边框。idle 也是绿胶囊。今天 `running`/`resyncing`/`connecting`/`reconnecting` 闪的是圆点，不是字。
4. **工具名再套一层小盒。** 外层已是 `.ohb-tool-panel` 白卡；标题 `button span:first-child` 又有底、边、圆角、padding。用户要的「少一层」指这个内层，不是拆掉整张卡。

## 1.2 已确认的产品/技术分界

引用 00：本轮只改 **ohbaby-web 展示层**。单槽互斥、入队、改队列 lease、`abortSession`、工具 pairing 保持。TUI 零改动。Send 脸上的纸飞机在 queuedEdit 时仍调用 `finishQueuedEdit`，不是改成再发一条。

## 1.3 ohbaby-web 现状

### 1.3.1 goals-duty

`docs/ohbaby-web/goals-duty.md` D3 要「发 prompt、中断 run」。没有规定按钮必须带字、输入必须单行死高、状态必须是胶囊。Non-duty：web 不持有独立事实源。本轮不把连接态或队列语义改进 store。

Gap：职责成立，chrome 的偶然复杂度（扁胶囊、双层工具名、空框偏厚）挡阅读。

### 1.3.2 architecture

composer 仍在 `apps/ohbaby-web/src/ui/App.tsx` 的 `Composer`。主按钮约 L3128–3161；textarea 约 L3092–3114；`showStop` 约 L2449–2450；`send()` 约 L2829–2872。

`StatusPill` 约 L1396–1405，header 与空态各用一次。工具在 `apps/ohbaby-web/src/ui/tool-card.tsx` 的 `ToolPanel`（约 L118–140）。

可逆改动：CSS + 少量 JSX。不抽新组件也能做。`fitComposerTextarea` 是可单测的 DOM 高度调整函数，用于把 7 行封顶规则从 JSX 中独立出来，不算新抽象层；它读取 `scrollHeight` 并设置样式，因此不称纯函数。

不可逆决策：无。

### 1.3.3 data-model

`ComposerModel`（`selectors.ts` L34–44）本轮不改字段。`queuedEdit` 是 Composer 本地 state，不是 ViewModel。主槽变脸仍由 send-stop 的 `showStop` 决定。圆钮缩窄会释放右侧宽度；现有 `.ohb-composer-text { flex: 1; min-width: 0 }` 可让思考控件随布局向右移动，无需固定偏移值。

`HeaderModel.connectionKind`（`selectors.ts` L20–26）六值：`idle | running | connecting | reconnecting | resyncing | disconnected`。`selectConnectionKind`（L214–224）：非 live 直接用 `connectionState`；live 时 running/等权限 → `running`，否则 `idle`。没有单独的「呼吸」字段，呼吸是 CSS 按 kind 挂钩。

工具名颜色来自 `toolAccent`（`tool-card.tsx` L178–187）打在外层 `ohb-tool-{blue|gold|green|red}`，内层 span 再吃背景。拆内层后颜色选择器还在，只是不要再给标题铺底。

### 1.3.4 dfd-interface

```
点纸飞机
  → send()
      queuedEdit? → finishQueuedEdit → client.editQueuedPrompt → 原 promptId 更新并继续调度
      否则 → onSubmit(text) → 空闲发新消息 / running 进队列
空草稿 + isRunning
  → Stop → onStop → abortSession
连接态
  → store.connectionState + run status → HeaderModel.connectionKind → StatusPill
工具
  → pairToolParts → ToolCard/OrphanToolResultCard → ToolPanel
```

本轮不改箭头，只改按钮 DOM 里有没有字、textarea 高度、StatusPill 有没有点、工具名有没有小盒。

### 1.3.5 use-case

| 用户在干什么 | 今天看到 | 问题 |
|--------------|----------|------|
| 空闲、框空 | 一行偏厚的输入 + 灰「Send」胶囊 | 空着不够矮；钮带字 |
| 打很多行 | textarea 不长高，只能看见一行 | 要边打边长，7 行封顶再滚 |
| 运行中再打一条 | 纸飞机旁写 Send，点了进队列 | 脸可以改圆；路径已对 |
| 点 Queue 条目改字 | 主槽写 **Save** | 用户要纸飞机；成功后只是原条目内容更新并继续按队列调度，不新增一条；轮到时可能立即执行 |
| 看顶栏 idle | 绿胶囊 + 绿点 | 收成绿字，不闪 |
| 看 running / 重连 | 胶囊 + 闪的点 | 收成字；running/connecting/reconnecting 闪字；resyncing 今天闪点，目标不闪 |
| 看工具折叠行 | 白卡里再套彩色名胶囊 | 名留下颜色，去掉小盒；白卡留下 |

### 1.3.6 non-functional

发送样式和 overlay 主按钮耦合：`styles.css` L2518–2536 把 `.ohb-send-button` 与 `.ohb-button-primary` 写在同一组。`App.tsx` 里 overlay 仍用 `ohb-button-primary`（约 L3540、L3857、L3929、L4052）。权限弹窗已经用 `.ohb-perm-*`。若只改共享组的圆角和 padding，「允许」类按钮也会变圆。圆钮变窄后的思考控件位移应由 flex 剩余空间承担；固定 margin 或绝对定位容易在 320px 屏幕挤压 textarea。

`button:disabled { opacity: 0.48 }` 全局已有，圆钮灰态可沿用。

`@keyframes ohb-pulse`（`styles.css` L40–48）已经是透明度呼吸，今天打在状态圆点上。本轮把同一动画改挂到指定 kind 的文字，并加 `prefers-reduced-motion: reduce` 关掉。

输入框 `.ohb-composer-input` 当前 `overflow` 未裁切；打字机 overlay `overflow: hidden`。封顶滚动必须设在 textarea 自己身上，不要给整行 `overflow: hidden`，否则 slash 上浮层和档位错误气泡会被切。

窄屏（约 L2986–2993）已经 `align-items: stretch` 并藏 send/stop 的 span。本轮桌面也不再有 span，这条 hide 规则应变成无操作或删掉，避免以为窄屏还有特殊文案策略。

### 1.3.7 test

有自动化、但对着旧 chrome：

| 覆盖 | 文件 | 缺口 |
|------|------|------|
| 单槽互斥、Save title | `App.unit.test.tsx`（约 L1747 断言 `Save queued prompt`） | 断言的是 title，没禁可见「Save」字；实施后 title 可留，可见字必须无 |
| 工具卡存在 | `App.unit.test.tsx` 数 `.ohb-tool-panel`；`tool-card.unit.test.tsx` 配对/展开 | 不锁标题小胶囊 |
| 布局 CSS | `styles.unit.test.ts` | 不锁 send 圆、7 行、status 无 pill padding |
| 连接态 | selectors 测 kind | 不测 DOM 有没有圆点 |
| TUI | cli contract | 本轮必须继续绿、零改 |

仓库无 `test-blueprint.md`，沿用 `docs-test/` + `docs/ohbaby-web/test.md`。`test.md` 写「像素级视觉回归 v0.1.6 不做」，本轮仍不做。

## 1.4 跨模块一致性

- **ohbaby-cli**：无共享 React 组件。Web 去字、去胶囊不得改 TUI 状态行。
- **ohbaby-sdk / server**：队列、lease、abort、工具 part 协议不动。
- **权限按钮文档**写明不要为了统一去改 composer；本轮方向相反：composer 圆钮，权限保持扁的 `.ohb-perm-*`。

## 1.5 改动影响面（现状视角）

| 区域 | 会动到 | 不会动到 |
|------|--------|----------|
| `apps/ohbaby-web/src/ui/App.tsx` | StatusPill 去点；主按钮去 span；textarea autosize 挂钩 | `canSend`/`showStop`/`send()` 分支语义 |
| `apps/ohbaby-web/src/ui/styles.css` | send/stop 独立圆形；composer 高度；status 纯字；tool 名去盒 | `.ohb-perm-*`、`.ohb-tool-panel` 外框、结果 pre |
| `apps/ohbaby-web/src/ui/tool-card.tsx` | 标题 span 可加 class（可选）；默认只改 CSS 即可 | pairing、accent 选择、自动展开 |
| `docs/ohbaby-web/ui/components.md`、`states.md`、`test.md` | 与目标态对齐 | send-stop 那批 00–05 不回写 |
| `packages/ohbaby-cli/` | 无 | 禁止 |

## 1.6 SWE 原则审视摘要

- **偶然复杂度**（哲学 00）：双层工具名、idle 胶囊、带字扁钮都不是队列问题固有的，是 chrome。
- **KISS / YAGNI**（原则 03）：不要为圆钮抽 ActionSlot，不要为状态抽动画组件。增高用 textarea 的 height + 一个独立、可测试的高度调整函数。
- **错误的 DRY**：send 和 overlay 主按钮颜色碰巧一样，不代表尺寸契约该绑死。本轮要拆共享规则，这是在还债，不是新抽象。
- **代码为人读**：`Save` 作为可见字会让「改队列」和「排队新消息」撞名。数据流里它们已经是两条路（`finishQueuedEdit` vs `onSubmit`），脸上却都像发送。

## 1.7 与既有文档关系

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| `components.md`：动作按钮 idle 显示 Send，编辑队列显示 Save；窄屏可藏文字 | 桌面有字；queuedEdit 可见「Save」；窄屏藏 span | 目标改为全程图标；权威文档过时 |
| `components.md`：输入框单行 | `rows={1}` 且不增高 | 文档和代码都是单行死高；目标 1–7 行 |
| `components.md` / `states.md`：连接状态胶囊 + 彩点；resyncing pulse | StatusPill 胶囊 + 点；running/resyncing/connecting/reconnecting 点闪 | 目标纯字；resyncing 不再闪 |
| `components.md`：工具可折叠卡片，名称色彩区分 | 外卡 + 内层名胶囊 | 外卡要对；内层名胶囊是要拆的那层 |
| send-stop 02 §2.8：圆形发送 out of scope | 仍是扁胶囊 | 由本议题接走 |
| permission-button：不要改 `.ohb-button-primary` 连坐 send | send 仍与 `.ohb-button-primary` 写在同一 CSS 组 | 本轮拆组，overlay 保持扁钮 |
