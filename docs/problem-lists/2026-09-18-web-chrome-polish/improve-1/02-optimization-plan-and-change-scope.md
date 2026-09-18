# 2. 优化方案与改动面

> 本轮实施契约。用户确认后按本契约实施；与 00 冲突时先改文档。暂不提交，待用户检查 Web 页面。

---

## 2.1 方案总览

Web chrome 三刀，数据流不动：

1. 工具折叠行把标题、状态、箭头锁死，摘要用 `flex: 1` 自己省略。箭头 Lucide `size={14}` + CSS 宽高 14px + `flex: none`。
2. 删掉 composer 的 `>`。输入行仍 `align-items: flex-end`。`.ohb-composer-text` `min-height: 32px`，把 24px textarea / 打字机垂直居中在这条轨道上，与 32px 圆钮对齐。textarea **继续** `padding: 0`、`line-height: 24px`。
3. `.ohb-statusbar` 收到约 44px（上下 padding 14→8）。**不改** `.ohb-sidebar-header`。

```
工具: [名][摘要…………][running][▾ 14px]
单行输入: [    居中文字    ][🧠][○]
多行输入: 框变高，○ 仍在右下
顶栏: 44px 会话栏 | 58px 侧栏顶   ← 允许不齐
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 箭头尺寸 | 14px 锁死 | 用户确认；贴近 11–12px 工具名 | 锁 16（等于现在没被挤的 search）；随行缩放 | 现在「宽松行」上的箭头会略缩小 |
| 防挤扁 | CSS `flex: none` + 宽高，不只靠 SVG 属性 | 浏览器可把 SVG min-width 当 0 | 只改 Lucide `size` | 多几行 CSS |
| 摘要 | `flex: 1; min-width: 0` | 长文案自己省略，不抢箭头 | 让整行换行 | 极窄时摘要更短，这是要的 |
| `>` | 删除节点和 `.ohb-prompt` 规则 | 用户确认；也消掉顶/底对齐打架 | 留着再微调 line-height | 少一层终端隐喻 |
| 单行居中 | composer-text 最小 32px + 内部居中 | 不破坏 24×7 盒模型 | textarea 加 padding；整行 `align-items: center`（多行钮会漂在中间）；`stretch`（测试禁止） | 实施时要对齐打字机绝对定位（已是 inset 0 + flex 居中） |
| 多行 | 保持输入行 `flex-end` | density 已验证圆钮贴右下 | 多行钮垂直居中 | 无 |
| 顶栏 | min-height 44px，padding 约 8px 20px | 用户要变矮；圆环 26px 仍放得下 | 40px（太贴圆环）；连字标一起大幅缩小 | 侧栏顶仍 58px，顶部分割线不齐 |
| 侧栏 | 不动 | 用户明确不要对齐 | 一起改成 44px | 视觉上左右顶栏错一层，已接受 |
| 窄屏顶栏 | 垂直 padding 一并收紧，保留换行 | 避免 720px 媒体查询把变矮抵消 | 只改桌面 | 换行后栏仍可变高，这是要的 |

不可逆决策：**无。**

## 2.3 分阶段实施

全部 Stage 属于 improve-1。

### Stage 1 — 三处 chrome（一次可验证）

三处改的是同一批 CSS/JSX，拆开反而容易漏回归。一次做完，按 04 分条验收。

**目标**

1. 任意工具折叠行箭头都是 14px，长摘要也挤不动。
2. composer 没有 `>`；单行文字在框的垂直正中；多行圆钮贴右下；1–7 行高度算法不变。
3. 会话顶栏约 44px；侧栏顶仍约 58px。

**改动文件**

- `apps/ohbaby-web/src/ui/tool-card.tsx`：`ChevronDown` 改为 `size={14}`，加稳定 class（如 `ohb-tool-chevron`），`aria-hidden`。
- `apps/ohbaby-web/src/ui/styles.css`：
  - 工具行：标题与 meta `flex: none`；summary `flex: 1; min-width: 0`；chevron `flex: none; width: 14px; height: 14px`。打开仍用现有 `.ohb-chevron-open` 旋转。
  - 删除**精确选择器** `.ohb-prompt`（输入框左侧那个 `>`）。**不要**用「包含 `ohb-prompt` 的规则全删」——`.ohb-prompt-queue` 及其子规则必须留下。`.ohb-composer-text` 增加 `min-height: 32px`（已有 `align-items: center`）。输入行保持 `flex-end`，**不要** `stretch`，**不要** `overflow: hidden`。textarea 规则保持 `padding: 0`、`line-height: 24px`、`min-height: 24px`、`max-height: 168px`。
  - `.ohb-statusbar`：`min-height: 44px`；桌面 padding 约 `8px 20px` 或 `8px 24px`。窄屏覆盖里的垂直 padding 收到同一量级，可保留 `align-items: flex-start` 和换行。
  - **禁止**改 `.ohb-sidebar-header` 的 min-height / padding。
- `apps/ohbaby-web/src/ui/App.tsx`：删 `<span className="ohb-prompt">&gt;</span>`。
- 测试见 04。不改 `fitComposerTextarea` 签名和 24/7 常量。

**行为**

- `ToolCard` / `OrphanToolResultCard` 一起变好，不必按工具名分支。
- 空项目页的 Composer 同样没有 `>`（同一组件）。
- 去掉 `>` 后左边仍用现有 16px padding；不要借机重做整张输入卡。
- 字标 `OHBABY` 可以保持 17px；高度下降主要来自 padding。若 44px 里行盒溢出，只允许略减 brand 字号，不改侧栏。

**DoD**

- CSS 单测：工具箭头 14px + `flex: none`（或等价 `flex-shrink: 0`）；summary 含 `flex: 1`；**没有**选择器恰好为 `.ohb-prompt` 的规则，且 `.ohb-prompt-queue` 仍在；statusbar `min-height: 44px`；sidebar-header 仍 `min-height: 58px`；textarea 仍 `padding: 0`；composer-input 仍不是 `stretch`。
- App.unit：`.ohb-composer-input` 内没有 `.ohb-prompt`；既有 1–7 行高度用例仍绿；打字机仍只在空闲空草稿未聚焦时出现。
- 浏览器：长摘要工具卡与短摘要工具卡箭头一样大；单行占位和输入视觉居中；多行圆钮在右下；会话顶栏明显变矮；侧栏顶高度看起来没变。
- 本地 E2E：启动 Web 页面，使用可重复数据在真实浏览器核验上述几何及工具卡展开/收起、输入与窄屏；记录结果供用户检查。

### Stage 2 — 权威文档

- **目标**：`components.md` / `test.md` 与 00 板式一致。
- **改动文件**：`docs/ohbaby-web/ui/components.md`（Composer 去掉 `>`；Header 写约 44px、不与侧栏对齐；工具折叠箭头 14px 不可被挤）；`docs/ohbaby-web/test.md` 的 composer density 行补「无 prompt 符、单行垂直居中、会话顶栏 44px」。
- **DoD**：不再把 `>` 写成输入框规格。不回写 density / send-stop 的 00–05。不改 `session-screen.dc.html`（非本轮权威）。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `apps/ohbaby-web/src/ui/` | 无新模块 | `tool-card.tsx`、`App.tsx`、`styles.css`、`styles.unit.test.ts`、必要时 `App.unit.test.tsx` | `.ohb-prompt` 节点与 CSS | 展示层 |
| `docs/ohbaby-web/ui/components.md` | 无 | Header / Composer / 工具 chevron | 「`>` 提示符」句 | 权威规格 |
| `docs/ohbaby-web/test.md` | 无 | composer density 行 | 无 | |
| `packages/ohbaby-cli/` | 无 | 无 | 无 | 禁止本轮改动 |
| `docs/problem-lists/2026-09-18-web-composer-density/` | 无 | 无 | 无 | 历史文档，不回写 |

## 2.5 API / 协议 / 迁移与兼容

无协议变更。无持久化迁移。键盘 Enter / Shift+Enter / slash / 双击 Esc 保持。

`.ohb-prompt` class 删除后，没有外部依赖。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 给 textarea 加 padding 弄坏 7 行 | 02 禁止；04 锁 `padding: 0` 与现有 T5–T7 | 去掉 textarea padding |
| 输入行改 stretch / center 导致多行钮漂中间 | 保持 `flex-end`；只垫 composer-text | 还原 align-items |
| 只改 Lucide size、忘了 CSS，长摘要仍挤扁 | Stage 1 同时锁 class 宽高 | 补 `flex: none` |
| 顺手改了侧栏顶 | 04 断言 sidebar-header 仍 58px | 还原该规则 |
| 窄屏媒体查询仍 13px 垂直 padding | Stage 1 同步收紧 | 微调 padding |
| 44px 里 Goal 芯片或圆环溢出 | 先减 padding 不减圆环；浏览器看一眼 | padding 加回 1–2px，不要回到 58 |
| 去掉 `>` 后左边太空/太挤 | 先保持 16px；仅允许 ±2px | 还原 padding |

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 箭头锁 14px | Stage 1 工具行 |
| 所有 ToolPanel 一起好 | 不按工具名分支 |
| 去掉 `>` | Stage 1 删节点和 CSS |
| 单行垂直居中 | Stage 1 composer-text 32px |
| 多行钮贴右下 | 保留 flex-end |
| 顶栏约 44px | Stage 1 statusbar |
| 侧栏顶不改、不对齐 | 禁止改 sidebar-header；04 反断言 |
| 不改 1–7 行算法 | 不改 `fitComposerTextarea` 常量 |
| 权威文档 | Stage 2 |
| TUI 不动 | 2.4 |
| 不回写 density 00–05 | 2.4 / 2.8 |

## 2.8 不在本轮

- TUI chrome 与 TUI 的 prompt `>`。
- `.ohb-sidebar-header`、项目轨、空项目页 `.ohb-empty-status`。
- Tasks / reasoning / 目录选择器箭头。
- 打字机文案 "Ask Lychee"。
- 会话流 `.ohb-stream` 的 32px 顶 padding。
- 改 `canSend` / 队列 / abort / 工具 pairing。
- 回写 density / send-stop 的 00–05。
- 像素截图回归、真实模型/搜索服务链路；改 `session-screen.dc.html`。本地浏览器端到端检查仍属于本轮。

无 0.4 分轮候选。不预开 improve-2。侧栏顶若验收时仍觉得「错一层」刺眼，记入 05 为候选，本轮不切——用户已经否决对齐。
