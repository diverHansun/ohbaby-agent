# 2. 优化方案与改动面

> 本轮实施契约。用户已授权本会话继续开发；与 00 冲突时先改文档。

---

## 2.1 方案总览

Web composer 输入行改成：

```
[>] [textarea] [ReasoningControl?] [PrimaryAction]
```

`PrimaryAction` 是同一视觉槽位中任一时刻最多一颗 `type="button"`，按状态切换标签、图标、handler、disabled；不要求 Send / Stop / Save 复用同一个 DOM 节点。`ReasoningControl` 从 footer 搬进来，改成无边框透明芯片；模型无思考能力时不渲染。footer 只留 mode、permission，以及改队列时的那句 hint。

Web Thinking 行不再教 Esc。TUI 不改。

主槽规则（实现时写成具名布尔，不要深嵌套三元）：

```
sendHasWork  = draft.trim().length > 0
showStop     = view.composer.isRunning && !sendHasWork && !queuedEdit
```

读出来：

- 编辑队列 → Save（即使草稿为空仍显示禁用的 Save）；Stop 不上场。
- 草稿非空 → Send（running 且可发送时入队；发出后草稿清空，恢复 Stop）。
- 否则若最后已知状态仍在 running / waiting-for-permission → Stop；重连时它因 `canStop=false` 置灰，顶栏显示连接状态，不能据此认定 run 当前仍在执行。
- 否则若 admission → 转圈 Send。
- 否则 → 灰 Send。

`canSend` / `canStop` 只控制 disabled 与 handler 是否生效，不决定动作外观。Send 的转圈反馈只在 Send 占槽时渲染。Stop 占槽时，即使 admission 尚未结束也不额外渲染 busy Send。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 主按钮数量 | 单槽变脸 | 用户硬约束：不能站两个位置 | 有条件双按钮（空态只 Stop、有草稿两颗都活） | running 打 follow-up 时 Stop 从槽里消失 |
| running + 有草稿 | Send 入队 | 队列已是产品能力；文案仍叫 Send | 强制先停再发；或 Send 改名 Queue | 入队时中断靠 Esc / 清空后再点 Stop |
| 思考强度位置 | 主按钮左侧，running 不消失 | 第二槽给配置，不给第二颗主操作 | running 时芯片让位给 Stop | 输入区比现在窄 |
| 芯片外观 | 大脑 + 英文档位 + ▾；透明无边；hover/focus 浅灰细边 | 用户指定；细边用已有 border 换色，避免 box 跳 | 白底小按钮；浅底 hover；中文「高」 | `adaptive` 等长词会比「高」宽 |
| Web Esc 文案 | Thinking 与 footer 都去掉 | 有 Stop 后属常识；用户确认 | 只删 footer、留 Thinking | 有草稿时 Stop 隐藏，只能在 textarea 聚焦时双击 Esc，或清空草稿后点 Stop |
| TUI Esc 文案 | 不动 | TUI 无 Stop 按钮 | 为对称一起删 | 无 |
| `hint` 字段 | 可删 `ComposerModel.hint` 与 `selectComposerHint` | footer 不再读连接/发送说明书 | 留字段不渲染 | 假 ViewModel 要去掉 `hint` |
| 抽象 | 不抽 ActionSlot | KISS；只有这一处 | 新组件/策略表 | 无 |
| Stop title | `Stop run` 可附带 double-click Esc | 空草稿且 Stop 可见时提供补充说明 | 常驻 hint | 有草稿时 Stop 不在 DOM，title 无法帮助发现中断；触屏用户要先清空草稿 |

不可逆决策：**无。** 这是纯 UI chrome，可随时把 Stop 画回去或把芯片搬回 footer。

## 2.3 分阶段实施

全部 Stage 属于 improve-1。

### Stage 1 — 单槽主按钮

- **目标**：`.ohb-composer-input` 里永远只有一颗 `.ohb-send-button` 或 `.ohb-stop-button`，不再并排。
- **改动文件**：`apps/ohbaby-web/src/ui/App.tsx`（`Composer` 按钮块，现约 L3119–3149）；必要时给图标态补 `aria-label`。
- **行为**：按 2.1 规则变脸。`onClick`：Stop → `props.onStop`，其余 → 现有 `send()`。键盘 Enter / 双击 Esc 不改。
- **DoD**：running + 空草稿只有 Stop；running + 有草稿只有 Send，发送后进入队列并恢复 Stop；idle 只有 Send；admission 且尚未 `isRunning` 时 Send 可转圈；重连且最后已知 running、空草稿时只有灰 Stop。主按钮各状态始终有准确的 `aria-label`。现有入队测试在「busy Send 已不存在」时改为断言队列出现且只有 Stop。

### Stage 2 — 思考强度芯片进输入框

- **目标**：`ReasoningControl` 渲染在 textarea 与主按钮之间；无边框芯片样式；打字机留白按「芯片 + 主按钮」重算。
- **改动文件**：`App.tsx`（放置）；`styles.css`（`.ohb-reasoning-control` 去掉白底实边、hover 浅灰细边、键盘 focus 保留清晰焦点标识、高度低于 Send；同时清理 `.ohb-reasoning-control` 与检测中/unknown 使用的 `.ohb-reasoning-status` 的 footer `margin-left: auto`；typewriter 在剩余空间内裁切，不能只改绝对定位的 `right`，因为现有 `white-space: nowrap` 会越界绘制）；`styles.unit.test.ts` 若有 reasoning/typewriter 断言则更新。
- **行为**：检测中只转大脑；unknown 为大脑 + `unknown`；identified 为大脑 + 档位 + chevron。`mode === "none"` 仍 `return null`。错误气泡仍向上，避免被 `.ohb-composer-input` `overflow: hidden` 裁掉（若有则改为可见）。
- **DoD**：断言 identified、detecting、unknown 三态都在 `.ohb-composer-input` 内、不在 `.ohb-composer-tools`。检测中无「推理默认」。最长打字机短语与窄屏下，文字不得覆盖芯片/主按钮或把输入框撑出 composer `max-width`。窄屏隐藏占固定宽度的 slash 补全文案，极窄屏缩小间距并容许长档位在芯片中省略显示；原生 select 的完整选项与 Tab 补全键盘行为保留。

### Stage 3 — Web 文案与权威文档

- **目标**：Web 不再常驻发送/中断说明书；TUI 原句保留；UI 规格与代码一致。
- **改动文件**：
  - `App.tsx` `ThinkingIndicator`：有 `canInterrupt` 时不要渲染 `double click esc to interrupt`（可删该分支，只留 `starting agent` 用于 startup）。
  - `App.tsx`：去掉 `{props.view.composer.hint}`。
  - `selectors.ts`：删除 `hint` / `selectComposerHint`（及 `ComposerModel` 字段）。
  - `slashCommands.unit.test.ts` 等假模型去掉 `hint`。
  - `docs/ohbaby-web/ui/components.md`、`states.md`、`test.md`。
- **DoD**：`App.unit.test.tsx` 不再要求 Thinking 含 esc 句；TUI `app.contract.test.tsx` 仍要求 `Press Esc again to interrupt`。`components.md` / `states.md` 写下表板式与「Web 不教 Esc、TUI 教 Esc」。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `apps/ohbaby-web/src/ui/` | 无新文件（默认） | `App.tsx`、`selectors.ts`、`styles.css`、对应 unit 测试 | `selectComposerHint` 若已无读者 | 展示层 |
| `docs/ohbaby-web/ui/` | 无 | `components.md`、`states.md` | 无 | 权威规格 |
| `docs/ohbaby-web/test.md` | 无 | admission/Send 旋转那行 | 无 | 与单槽规则对齐 |
| `packages/ohbaby-cli/` | 无 | 无 | 无 | 禁止本轮改动 |

## 2.5 API / 协议 / 迁移与兼容

无协议变更。无持久化迁移。`ComposerModel.hint` 若删除，只影响本包 TypeScript；不是 SDK 合同。

键盘兼容：Enter 发送、Shift+Enter 换行、双击 Esc 中断、队列编辑时 Esc 放弃编辑——全部保持。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 有草稿时用户找不到 Stop | 键盘焦点在 textarea 时仍可双击 Esc；清空草稿 Stop 回来。Stop 隐藏时其 title 无法提供帮助；触屏用户须清空草稿 | 若此已确认取舍无法接受，重新讨论动作优先级，不能在本轮悄悄加第二颗按钮 |
| 芯片变宽导致输入区跳 | 细边用 transparent→gray 的 border，不新增 outline 厚度；把 textarea 和 typewriter 放在可收缩文本容器内，裁切超出文字；窄屏隐藏 slash 补全文案以保留输入宽度 | 芯片搬回 footer |
| 错误气泡被裁切 | 检查 overflow；必要时允许气泡溢出输入框 | 恢复 footer 定位 |
| 删 `hint` 漏改假 ViewModel | 编译 + `slashCommands.unit.test.ts` | 字段可先留着不渲染（若删除引发面过大，允许 Stage 3 只停渲染、字段下轮再删——须在 05 记录） |
| 误改 TUI | 04 回归清单含 TUI 契约测 | 不碰 cli 则无回滚 |

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 单槽、不两颗并排 | Stage 1 规则 `showStop` 与互斥渲染分支 |
| 思考强度在 Send 左、running 不让位 | Stage 2 放置 |
| 大脑 + 细框透明底 | Stage 2 CSS |
| Send 不改名 Queue，Stop 不改名暂停 | Stage 1 标签 |
| Web 去 hint / Thinking esc | Stage 3 |
| TUI 不去 Esc 提示 | 2.4 cli 禁止修改 |
| 改队列 hint 保留 | Stage 3 不删 `.ohb-queued-edit-hint` |
| 不抽 ActionSlot、不改 canSend 含义 | 2.2 |
| 档位语义沿用 2026-09-17 | Stage 2 只搬家 |

## 2.8 不在本轮

- TUI chrome 与 Esc 文案。
- Thinking 可点击。
- mode/permission 进输入框、圆形实心发送钮、整卡式 composer。
- 档位中文简称、检测中文案、无能力占位。
- `canSend` 在 running 时改为 false（会破坏入队）。
- 统一 Web/TUI 的 Esc 时间窗口（650 vs 1500）。
- 为防跳动预留芯片宽度空位、窄屏第二套纯图标（除非 Stage 2 验收时输入框被撑破，再做最小收窄，不单开一轮）。

无 0.4 分轮候选。不预开 improve-2。
