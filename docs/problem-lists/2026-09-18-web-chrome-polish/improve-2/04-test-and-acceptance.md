# 4. 测试与验收标准

> 仓库无项目级 `test-blueprint.md`。沿用 colocated vitest。不引入视觉截图框架，不改 TUI 契约测。

---

## 4.1 测试范围

| 类型 | 覆盖什么 | 不覆盖什么 |
|------|----------|------------|
| App.unit | 无 mode 胶囊；Shift+Tab 仍切 mode；权限按钮 aria 与点击循环；header 无 `OHBABY`/点阵、有三色字标；侧栏关闭后节点仍在且不可点；1–7 行按 22px | 黄边好不好看 |
| styles.unit | composer max-width 800；stream-inner 720；auto/plan 边；输入 14px/22px/max-height 154；statusbar 44；sidebar-header 58；侧栏 transition；无 `.ohb-mode-button` 规则 | 全 CSS 快照 |
| TUI contract | **原样跑** | 不改断言 |
| 手工/浏览器 | 灰/黄边、手/盾、贴底、侧栏 200ms、玻璃、字标 | 全机型 QA |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | Stage |
|----|------|------|--------|-------|
| T1 | 无 mode 胶囊 | App.unit | 无 `.ohb-mode-button`，文案不出现可见「auto mode」「plan mode」 | 1 |
| T2 | Shift+Tab | App.unit | 仍调用 `onSetPermission({ mode })` 在 auto/plan 间切；输入卡带 plan class；可访问名（`aria-label` 或等价）含当前 `auto`/`plan` | 1 |
| T3 | 权限图标 | App.unit | 有灰手/红色感叹盾权限按钮；default 与 full-access 切换仍走 `onSetPermission({ level })`；`aria-label` 含 default/full-access；无可见「default」胶囊字 | 1 |
| T4 | 7 行盒模型 | App.unit + styles.unit | 1 行 height 22；3 行 66；>7 行 154 且 overflow auto；CSS line-height 22、max-height 154、padding 0 | 1 |
| T5 | 阅读列未加宽 | styles.unit | `.ohb-stream-inner` 仍 `max-width: 720px` | 1 |
| T6 | 输入卡加宽 | styles.unit | `.ohb-composer-input` `max-width: 800px` | 1 |
| T7 | overlay 圆钮隔离 | 已有 styles.unit | send/stop 32px 圆；`.ohb-button-primary` 非 50% | 1 回归 |
| T8 | 侧栏折叠 | App.unit | 关闭后 `.ohb-sidebar` 仍存在；会话按钮不可点或 inert；打开后可点 | 2 |
| T9 | 侧栏动画规则 | styles.unit | sidebar 规则含 transition（width 或 flex-basis）；reduced-motion 覆盖为近 0 | 2 |
| T10 | 无点阵大写 | App.unit | `.ohb-statusbar` 内无 `.ohb-logo-grid`、无文本 `OHBABY`；有 oh/ba/by | 3 |
| T11 | 高度契约 | styles.unit | statusbar min-height 44px；sidebar-header min-height 58px | 3 回归 improve-1 |
| T12 | 思考三色还在 | styles.unit | `.ohb-thinking` 子点仍有金/粉/蓝（或现有 nth-child 色） | 3 |
| T13 | 手工：mode 边 | 浏览器 | auto 浅灰边；Shift+Tab 后浅黄边，无 mode 字 | 1 |
| T14 | 手工：权限 | 浏览器 | 灰手 ↔ 红色感叹盾；hover 浅边线、键盘 focus 可见焦点环；点了仍两态；full-access 不弹权限框（沿用） | 1 |
| T15 | 手工：贴底加高 | 浏览器 | 框下没有胶囊；底空隙约 10px 量级；空框因底栏略高于 improve-1 | 1 |
| T16 | 手工：侧栏 | 浏览器 | 开关推进约 200ms；reduced-motion 瞬时 | 2 |
| T17 | 手工：玻璃字标 | 浏览器 | header/侧栏不那么死白；彩色小写；状态仍是纯字 | 3 |
| T18 | TUI | cli contract | 不因本轮变红 | 回归 |
| T19 | 权威文档 | 对照 | components/README 不再规定底部带字 mode 按钮 | 4 |
| T20 | 单槽发送 | 已有 App.unit | 互斥、无 Send 字、改队列纸飞机 | 1 回归 |

改现有测试：凡 `querySelector(".ohb-sidebar")` 为 null 表示收起的，改为断言折叠。凡高度 24/72/168 改为 22/66/154。

## 4.3 集成边界

- **脸 vs 协议**：T2/T3 失败先看有没有误删 `cycleMode` / `onSetPermission`，不要改 PATCH。
- **宽度**：T5 失败就是动了阅读列。T6 失败才是输入卡没加宽。
- **侧栏**：T8 失败可能是又写回 `return <></>`，动画会再次失效。
- **思考色**：T12 失败多半是删 `.ohb-logo-grid` 时误伤共享选择器。

## 4.4 回归清单

- improve-1：箭头 14px、无 `>`、顶栏 44、侧栏顶 58。
- density/send-stop：圆钮无字、单槽、思考芯片仍在输入卡内、1–7 行内滚、状态纯字、工具名无内层胶囊。
- Enter / Shift+Enter / IME / slash / 双击 Esc。
- PermissionModal 仅 default 策略出现。
- Goal 芯片、mode 的数据值、TUI Esc 提示。
- slash 解析错误、改队列 hint 仍可见，只是不再占用框外那行老 tools。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 无胶囊 | 框外没有 auto mode / default 按钮 | T1、T15 |
| mode | 只有描边差；Shift+Tab 有效 | T2、T13 |
| 权限 | 灰手/红色感叹盾，协议不变 | T3、T14 |
| 宽高字 | 输入 800、字 14/22、7 行 154；正文 720 | T4–T6 |
| 贴底 | 无外底栏，底 padding 小 | T15 |
| 侧栏 | 推进动画，节点常在 | T8、T9、T16 |
| 字标玻璃 | 无点阵、三色小写、浅玻璃 | T10、T17 |
| 高度不齐 | 44 vs 58 | T11 |
| TUI | 零功能 diff | T18 |
| 文档 | 与 00 一致 | T19 |

```bash
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx \
  apps/ohbaby-web/src/ui/styles.unit.test.ts \
  apps/ohbaby-web/src/ui/tool-card.unit.test.tsx

pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm typecheck
```

## 4.6 对抗性审查要点

| 攻击面 | 最可能怎么坏 | 防御 | 残余风险 |
|--------|----------------|------|----------|
| 7 行 | 只改了 CSS 或只改了 JS | T4 | 再改字号仍要两处一起动 |
| 正文被加宽 | 「一起好看」顺手改 stream | T5 | 用户以后若改口另开轮 |
| 侧栏卸载 | 图省事 `return null` | T8 | 动画没了 |
| 颜色当唯一 mode | 没有 aria | Stage 1 a11y；T2 class | 色弱用户主要靠黄/灰差，可接受但 aria 仍要 |
| 抄参考图 | 加上 +/High/麦 | 03 reject；审查 diff | — |
| 思考配色消失 | 删 logo-grid 共享规则 | T12 | — |

对应 01 高风险：7 行常量、阅读列宽度、侧栏卸载、thinking 色。T4/T5/T8/T12 接住。
