# 2. 优化方案与改动面

> 本轮实施契约。规划会话不写代码。与 00 冲突时先改文档。

---

## 2.1 方案总览

Web chrome 三刀，数据流不动：

1. 单槽主按钮改成固定尺寸圆。Send / 转圈 / 改队列都是蓝圆，通常显示纸飞机，admission 时显示转圈；Stop 是浅圆 + 方块。可见字删掉，`aria-label` 保留。圆钮缩窄后，思考控件借文本区的 flex 伸缩自然向右靠近主按钮。
2. textarea 按内容设高度，最小 1 行、最多显示 7 个视觉行（包括自动折行），超出内部 `overflow-y: auto`。
3. `StatusPill` 去圆点去胶囊；工具名去内层小盒。呼吸只挂在 running / connecting / reconnecting 的字上。

板式仍是 send-stop 的：

```
[>] [textarea] [ReasoningControl?] [圆形主按钮]
```

`showStop` 公式不改：

```
showStop = view.composer.isRunning && !queuedEdit && draft.trim().length === 0
```

点纸飞机仍走今天的 `send()`：`queuedEdit` → `finishQueuedEdit` → `editQueuedPrompt`，成功后**同一 promptId** 的条目更新并继续按队列调度（轮到时可能立即执行），UI 退出编辑并恢复原草稿；仍在队列时列表反映新文本。这是保存成功的界面反馈，不加永久 `Saved` 标签。否则 `onSubmit`（running 时新消息进入队列）。失败时留在编辑态并显示错误，不宣称已保存。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 发送脸 | 圆 + 纸飞机，无字 | 用户硬约束 | 小胶囊仍留 Send；对勾当 Save | 改队列靠 footer hint 和 aria-label 说明 |
| Stop 脸 | 同尺寸浅圆 + 方块，无字 | 单槽；和蓝发送对照 | Stop 也做成蓝圆；留「Stop」 | 重连灰圆可能不如扁钮「这是停止」那么字面 |
| 改队列点击 | 仍 `finishQueuedEdit` | 成功表示原 queued 条目内容已保存，继续按队列调度；不能新增一条 | 改队列也走 onSubmit | 脸上都是纸飞机，编辑含义靠 footer hint 和读屏名 |
| 增高 | JS 读 `scrollHeight` 设 height | textarea 没有纯 CSS 按内容长高且封顶内滚的可靠方案 | 只改 min-height；contenteditable | 要在 restore draft / 清空 / 贴上时重算 |
| 7 行 | `line-height: 24px`、可见高度上限 `24px × 7 = 168px`；实测按折行后的 `scrollHeight` | 用户指定 7 个视觉行 | 只数换行符 | 字号变化时要同步常量；textarea 内边距或边框若非零，须计入盒模型 |
| 封顶滚动 | textarea `overflow-y: auto`；未封顶 `hidden`；封顶后优先用 `overscroll-behavior: contain` 阻止滚动传给对话流 | 用户要内部滚 | 整页长、外框滚 | 仍需浏览器验滚轮和触控板边界 |
| 长高对齐 | 输入行 `align-items: flex-end`；`>` `align-self: flex-start`；`.ohb-composer-text` 保持 `flex: 1; min-width: 0`，思考控件贴圆钮左侧；沿用输入行桌面 12px、极窄屏 6px 的 gap，可在浏览器中小幅调整 | 圆钮贴右下；圆钮变窄后思考控件自然右移 | 给思考控件写固定右偏移 | 320px 下需检查 textarea 仍可用 |
| 状态 | 纯字 + kind 颜色；去点 | 用户：idle 不要胶囊不要点 | 留点去胶囊；idle 也呼吸 | 点击热区变小（本就不可点） |
| 呼吸范围 | 仅 running/connecting/reconnecting 的 **字** | 用户确认；idle 闪会像在干活。resyncing 今天闪点，本轮改为静字 | 全状态闪；resyncing 继续闪 | resyncing 比现在更静，靠颜色和文案 |
| 工具 | 只去掉名 span 的 bg/border/radius/padding | 用户：外卡和结果卡留下 | 折叠成纯一行无白卡 | 白卡还在，只是少一层盒 |
| CSS 隔离 | send/stop 单独规则，不再和 `.ohb-button-primary` 共用尺寸 | overlay 仍用扁主按钮 | 改共享组 | 蓝色要在 send 规则里写一份 |

不可逆决策：**无。**

## 2.3 分阶段实施

全部 Stage 属于 improve-1。

### Stage 1 — 圆形图标主按钮

- **目标**：`.ohb-composer-input` 里那颗主按钮是圆的、没有可见 Send/Stop/Save 字。
- **改动文件**：`App.tsx`（去掉两个 `<span>…</span>`，保留 svg + `aria-label`/`title`）；`styles.css`（把 `.ohb-send-button`/`.ohb-stop-button` 从与 `.ohb-button`/`.ohb-button-primary` 的共享块拆出：固定宽高、`border-radius: 50%`、`padding: 0`、`flex: none`）。窄屏藏 span 的规则删掉或确认已无 span。
- **行为**：互斥和 handler 不动。queuedEdit 的 `aria-label`/`title` 仍是 `Save queued prompt`；成功才退出编辑，原条目继续按队列调度，失败保留编辑和错误。admission 转圈仍只在 Send 占槽时出现，画在圆里，不要字。现有 `.ohb-composer-text` 弹性占满剩余空间，思考控件随圆钮缩窄自然右移；不添加固定偏移。
- **DoD**：idle 有草稿时按钮可点、无「Send」文本节点；running 空草稿无「Stop」文本；queuedEdit 仍是纸飞机且无「Save」文本、title/读屏名为 Save queued prompt；保存后原 `promptId` 更新、队列条目数不增加；失败不出现已保存状态；admission 且尚未 `showStop` 时圆里是 `LoaderCircle` 且 `aria-busy=true`。`.ohb-button-primary` 仍是扁的（overlay 抽样）。图标按钮始终有 `aria-label`；桌面与 320/375px 宽度下思考控件位于圆钮左侧并与其保持间距，textarea 不被挤没。

### Stage 2 — 1 到 7 行增高并内部滚

- **目标**：空草稿一行；内容按视觉行增高；容纳 7 行后 textarea 内部滚。
- **改动文件**：`App.tsx`（draft 变化、restore、queuedEdit 载入、清空后重算高度；监听容器宽度变化，如 `ResizeObserver`，以覆盖自动折行；重算前先解除旧高度再读取 `scrollHeight`，保证清空后收回）。抽出可单测的高度调整函数 `fitComposerTextarea(el, { lineHeight: 24, maxLines: 7 })`（它读写 DOM，**不是纯函数**；同目录小文件或紧挨 Composer），04 的 T5–T7 钉它。`styles.css`：textarea `line-height: 24px`、`min-height: 24px`、`max-height: 168px`，并明确 textarea 自身 `padding: 0`、`border: 0`，以免 7 行高度混入盒模型；`.ohb-composer-input` 改为 `align-items: flex-end`，`.ohb-prompt` `align-self: flex-start`。不要给 `.ohb-composer-input` 加 `overflow: hidden`。
- **行为**：Shift+Enter 换行照旧。textarea 聚焦且 slash 菜单关闭时，封顶后滚轮/PageUp/PageDown 动 textarea；slash 菜单打开时 PageUp/PageDown 仍优先操作菜单。发送清空后回到一行。打字机仍只在空闲空草稿未聚焦时出现，且落在单行高度里。
- **DoD**：单测用模拟 `scrollHeight` 锁 1、3、超过 7 个视觉行的高度和 overflow；浏览器实测窄屏长句自动折行，7 行后不再撑高，第 8 行只在框内滚；滚到 textarea 顶部/底部继续滚也不带动对话流。发送清空、恢复草稿、编辑队列载入、窗口或容器变窄后都重新计算。slash 上浮层和档位错误气泡不被裁。

### Stage 3 — 状态纯字 + 工具名去胶囊

- **目标**：顶栏/空态连接状态无胶囊无点；指定三态字呼吸；工具名无内层盒，外卡还在。
- **改动文件**：`App.tsx` `StatusPill` 去掉装饰圆点 span；`styles.css` 去掉 pill 的 padding/圆角/实底/边框，颜色留在文字；pulse 从 `> span` 改到 `.ohb-status-running` / `-connecting` / `-reconnecting` 自身，**不要**挂在 idle/resyncing/disconnected。`prefers-reduced-motion: reduce` 时 animation 为 none。工具：`.ohb-tool-panel button span:first-child` 去掉 background/border/radius/padding，保留 color；`.ohb-tool-blue` 等选择器跟着改。不改 `.ohb-tool-panel` 外框、不改 `pre`、不改 `.ohb-command-label`。
- **DoD**：idle 节点没有装饰圆点；running 有呼吸 class/规则；resyncing 无 pulse 规则。工具卡仍是 `.ohb-tool-panel`；标题 computed 无 chip 底（CSS 单测锁「没有 background + border 那套」）。Goal 芯片、命令 notice 胶囊保持原样。

### Stage 4 — 权威文档

- **目标**：`components.md` / `states.md` / `test.md` 与 00 板式一致。
- **改动文件**：上述三篇。不回写 send-stop 的 00–05。
- **DoD**：文档不再写「状态胶囊」「单行输入」「编辑队列显示 Save 字」「窄屏才藏发送文字」。写明纯字状态、7 行封顶、图标圆钮、改队列仍是纸飞机。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `apps/ohbaby-web/src/ui/` | `fitComposerTextarea` 小文件（若与 App 同文件导出亦可） | `App.tsx`、`styles.css`、对应 unit 测试；工具若只改 CSS 则 `tool-card.tsx` 可不改 | 主按钮内可见字 span；StatusPill 装饰点 | 展示层 |
| `docs/ohbaby-web/ui/` | 无 | `components.md`、`states.md` | 无 | 权威规格 |
| `docs/ohbaby-web/test.md` | 无 | composer 高度 / 图标钮 | 无 | |
| `packages/ohbaby-cli/` | 无 | 无 | 无 | 禁止本轮改动 |
| `docs/ohbaby-web/ui/permission-button/` | 无 | 无 | 无 | 不改权限文档除非发现冲突句；send 拆 CSS 正是遵守它 |

## 2.5 API / 协议 / 迁移与兼容

无协议变更。无持久化迁移。键盘：Enter 发送、Shift+Enter 换行、双击 Esc 中断、改队列 Esc 放弃——全部保持。改队列 Enter 仍保存。

CSS class `.ohb-status-pill` 名字可保留（历史名），避免无意义重命名；视觉上它不再是 pill。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 改共享按钮 CSS 把 overlay 主按钮变圆 | Stage 1 先拆选择器；04 抽查 `.ohb-button-primary` 仍是 8px 圆角 | 只回 send/stop 规则 |
| 7 行计算含 padding 导致「看起来只有 6 行」 | max-height 只按 line-height×7，padding 放在外框不放进 textarea 行盒 | 微调两个常量 |
| 内部滚把对话流一起滚走 | 封顶后 overflow 与 `overscroll-behavior: contain` 都在 textarea；手工验滚轮/触控板及顶部、底部边界 | 检查焦点、滚动容器与事件传递；若浏览器仍漏，再针对该浏览器处理 |
| `.ohb-composer-input { overflow: hidden }` 切掉 slash | 02 明确禁止给输入行加 hidden | 去掉该 hidden |
| 纸飞机当改队列提交，用户以为发出去了 | footer hint 保留；aria-label 仍 Save queued prompt | 不把可见字加回来，除非产品改口 |
| 呼吸让人晕 | `prefers-reduced-motion`；idle 不闪 | 去掉 animation |
| 工具名去盒后对比不够 | 保留原色；外卡还在 | 只加回 padding，不加底（须再讨论，本轮不要擅自加回胶囊） |

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 圆 + 纸飞机不要字 | Stage 1 |
| Stop 圆坑方块不要字 | Stage 1 |
| 运行中新草稿点纸飞机 = queued | 不改 `send()`；Stage 1 只改脸 |
| 改队列仍纸飞机，语义仍保存 | Stage 1 去「Save」字，handler 不动 |
| 空着矮、7 行内滚 | Stage 2 |
| 钮贴右下 | Stage 2 `flex-end` |
| idle 纯字无点无胶囊 | Stage 3 |
| 仅 running/connecting/reconnecting 呼吸 | Stage 3 |
| 只拆工具名一层 | Stage 3 |
| 不拆外卡/结果卡 | Stage 3 不碰 panel/pre |
| send CSS 隔离 | Stage 1 |
| TUI 不动 | 2.4 |
| 权威文档 | Stage 4 |

## 2.8 不在本轮

- TUI chrome。
- 拆 `.ohb-tool-panel` 外框、结果 `<pre>`、`.ohb-command-label` 胶囊、`.ohb-goal-chip`。
- 改 `canSend` / 队列 / abort / 工具 pairing。
- 把 queuedEdit 点纸飞机改成 `onSubmit`。
- mode/permission 进输入框。
- 给 idle 加呼吸、给 resyncing 留圆点闪。
- 回写 send-stop 的 00–05。
- Playwright 视觉回归。

无 0.4 分轮候选。不预开 improve-2。命令 notice 小胶囊若验收时显得和工具名仍成套，记入 05 为下一轮候选，本轮不切。
