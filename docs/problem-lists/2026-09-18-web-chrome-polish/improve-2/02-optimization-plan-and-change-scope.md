# 2. 优化方案与改动面

> 本轮实施契约。规划会话不写代码。与 00 冲突时先改文档。
> 视觉 token 与状态矩阵按 plan-frontend-design 写在本节，不另开 `docs/frontend/` 系列。

---

## 2.1 方案总览

四刀，数据流不动：

1. **输入卡**：去掉框外 mode/permission 胶囊；mode 映到描边；权限进框内底栏左侧图标；思考芯片和发送圆钮进同一底栏右侧。卡加宽到约 800px、略加高、贴底。框内字 14px / 行高 22px。
2. **侧栏**：始终挂 DOM，用宽度推进做 200ms 过渡。
3. **玻璃 + 字标**：header 与侧栏浅玻璃；header 只留三色小写 `ohbaby`。
4. **权威文档**：components / ui README / test 与 00 对齐。

```
[轨][侧栏 300→0 动画][玻璃顶栏: ohbaby | idle  模型]

              阅读列 720px

     ┌──── composer 800px，贴底 ─────────┐
     │  14px 正文/占位                     │
     │  [手/盾]              [🧠] [○]      │
     └─ 灰边 auto / 黄边 plan ─────────────┘
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| mode 脸 | 只改 `.ohb-composer-input` 描边 | 用户确认无按钮无字 | 极小 plan 点；保留胶囊 | 读屏靠 aria |
| auto 边 | 中性浅灰 `#d9dce2` + 弱灰色外晕 | 默认 auto 无感 | 继续沿用旧蓝光 | 需确认与白色输入卡仍有边界 |
| plan 边 | 浅黄描边 `#e6d6a8`，聚焦用浅黄光环 | 用户确认 | 实心黄底 | 和 Goal/deny 的金要能分开 |
| 权限图标 | default=`Hand` 灰色；full-access=`ShieldAlert` 红色 | 用户 2026-09-19 文字确认 | 绿盾/红底大钮 | 需 title/aria 写全名 |
| hover | 小图标、浅边线、无填充底；focus 有可见焦点环 | 用户要的轻量效果 | 实心色块 | 图形可小，但点击区域建议约 32px |
| 框内布局 | 上：textarea 通栏；下：左权限、右思考+发送 | 用户要加高，且参考图是底栏 | 权限和发送同一行挤在文字旁 | 空框比今天高一截，这是要的 |
| 加宽 | composer / todo-dock / prompt-queue 以 **800px** 为初始目标；`.ohb-stream-inner` **仍 720** | 用户只要输入框 | 正文一起 800 | 框比气泡宽，需在浏览器中确认观感 |
| 字号 | 框内 14px、行高 22px、7 行 max-height 154px | 轻微缩小；盒模型必须一起改 | 只改 font-size 不动行高 | 更新 App.unit 24/72/168 |
| 贴底 | `.ohb-composer` padding 底 10–12px；删除 `.ohb-mode-button` / `.ohb-policy-button` | 胶囊是顶起来的主因 | 贴死 0 | 圆角和系统手势条留一点气 |
| 侧栏 | 常挂 + `flex-basis` 300↔0，200ms ease-out | 用户要推进+动画 | overlay 盖住对话；卸载 | 关着仍占一丁点布局计算 |
| 字标 | 空态同一套 `oh/ba/by` 约 20px；去掉 header 点阵 | 用户确认 | 新艺术字体文件 | 思考波点 CSS 必须保留 |
| 玻璃 | 略带灰度的半透明表面 + 轻微 blur；输入卡实底 | 用户要去呆白，不要展厅 | 高透明+大阴影 | 纯色背景上的 blur 不明显，需靠底色和细边界形成层次 |
| 关键改动清单 | 不写 | 用户确认 | — | — |

不可逆决策：**无。**

## 2.3 本轮视觉系统

原则：专业工具、少边缘、状态能扫一眼；危险（full-access）克制但明确；动效短。

| Token | 值 | 用途 |
|-------|----|------|
| surface-body | `#fafafa` | 会话正文（不动） |
| surface-glass | 建议 `rgba(246, 246, 247, 0.88)` + `backdrop-filter: blur(10px)`；实际色值以浏览器观感微调 | header、sidebar；避免混白后仍近乎纯白 |
| surface-glass-fallback | `#f6f6f7` | 无 backdrop-filter |
| surface-input | `#ffffff` | 输入卡实底 |
| border-auto | `#d9dce2` | auto 输入边 |
| border-plan | `#e6d6a8` | plan 输入边 |
| ring-auto | `0 0 0 3px rgba(64, 72, 88, 0.06)` | auto 弱灰色外晕 |
| ring-plan | `0 0 0 3px rgba(201, 162, 63, 0.16)` | plan 聚焦 |
| perm-ask | 中性灰，建议 `#858a93` | 手 |
| perm-open | 警示红，建议 `#c45151` | 感叹盾；与连接断开状态靠位置和图形区分 |
| wordmark | gold `#c9a23f` / pink `#c97e92` / blue `#5f86c4` | 与空态相同 |
| type-input | 14px / 22px / IBM Plex Mono | textarea、占位、打字机 |
| composer-width | `800px` | 输入卡、todo-dock、queue |
| stream-width | `720px` | 阅读列，禁止改 |
| motion-sidebar | 200ms ease-out；reduced-motion: 0 | 仅 width/flex-basis/opacity |
| header-height | 44px | improve-1，本轮不改数字 |
| sidebar-header-height | 58px | 不齐、不改数字 |

禁止：紫渐变、重阴影、输入卡毛玻璃、侧栏弹跳、把 `.ohb-stream-inner` 改成 800。

## 2.4 状态矩阵（本轮涉及的组件）

### 输入卡

| 状态 | 视觉 | 触发 |
|------|------|------|
| auto + default | 灰边、灰手、无框外胶囊 | 默认 |
| auto + full-access | 灰边、红色感叹盾 | 点图标 |
| plan + default | 黄边、灰手 | Shift+Tab |
| plan + full-access | 黄边、红色感叹盾 | 组合 |
| 权限 hover/focus | hover 浅边线；focus 可见焦点环，宽高不变 | 指针/键盘 |
| 权限 disabled | 透明度沿用全局 disabled | 断线等 |
| 单行空 | 占位 14px 垂直居中在上半；底栏约 32px | idle/running 占位 |
| 多行 | textarea 按 22px 行高长到 154px 内滚；底栏贴卡底 | 输入 |
| 改队列 | hint 改放底栏中部或卡下内侧，不复活外底栏 | queuedEdit |

### 侧栏

| 状态 | 视觉 | 触发 |
|------|------|------|
| 开 | flex-basis 300px，可点 | 默认或点开 |
| 关 | flex-basis 0，overflow hidden，`aria-hidden`/`inert` | 点轨上开关 |
| 切换中 | 200ms 宽度变 | 中间态 |
| reduced-motion | 瞬时 | 系统设置 |

### 顶栏

| 状态 | 视觉 |
|------|------|
| 常驻 | 玻璃底、三色小写、无点阵 |
| 连接态色 | 仍用现有 idle/running/… 字色，略降对比但不加胶囊 |

## 2.5 分阶段实施

全部 Stage 属于 improve-2。

### Stage 1 — 输入卡

- **目标**：无框外 mode/policy 胶囊；mode 只在描边；权限图标在框内底栏左；思考+发送在底栏右；宽约 800；字 14/22；贴底。
- **改动文件**：`App.tsx` Composer；`styles.css` composer 相关；`fitComposerTextarea` 调用改为 `lineHeight: 22`；App.unit / styles.unit。
- **结构**：`.ohb-composer-input` 改为纵向：上 `.ohb-composer-text`+textarea，下 `.ohb-composer-bar`（权限 | 弹性空白或 hint | ReasoningControl | 发送/停止）。slash 错误可进 bar 或卡下方，不要外挂一整行老 tools。
- **删除**：`.ohb-mode-button`、`.ohb-policy-button` 及可见「auto mode」「default」字。`cycleMode` 只留键盘。
- **class**：plan 时输入卡加 `is-plan`（名可改，语义是 plan）。
- **a11y**：权限按钮 `aria-label`/`title` 写全；输入卡或 textarea 的可访问名包含 `auto`/`plan`。
- **空态**：`.ohb-composer-hero` 用同一张卡、同一套底栏，`max-width` 与会话页 composer 同为 800（窄屏仍 88vw）。不要再挂外底栏。
- **DoD**：DOM 无 mode 胶囊；Shift+Tab 仍切 mode 且边变黄；点盾/手只切 permission；1 行高度按 22、3 行 66、超过 7 行 154；`.ohb-stream-inner` 仍 720；圆钮仍 32px 且 overlay 扁钮不变。

### Stage 2 — 侧栏动画

- **目标**：开关 200ms 推进，关着节点还在。
- **改动文件**：`SessionSidebar` 不再 `return <></>`；`styles.css` width/flex-basis transition；修正「sidebar 不存在」的 App.unit。
- **折叠**：`aria-hidden` + `inert`（或等价 tab 不可达）。移动端已有 overlay 的，用 `transform` 滑，不要改成另一种信息架构。
- **DoD**：关着查得到 `.ohb-sidebar` 但不可点会话；开/关有 transition 规则；reduced-motion 无 duration；项目轨不跟着闪。

### Stage 3 — 玻璃与字标

- **目标**：header/sidebar 浅玻璃；header 只有三色小写；无点阵。
- **改动文件**：`StatusBar` JSX；`styles.css`；思考波点选择器不得被误删。
- **字标**：复用空态三段 span 与颜色，header 字号约 20px。`aria-label="ohbaby"`。
- **右侧状态**：保持纯字；可略减对比，不加回胶囊。
- **DoD**：header 无 `.ohb-logo-grid`、无文本 `OHBABY`；有 `oh`/`ba`/`by` 三色；sidebar-header 仍 min-height 58px；statusbar 仍约 44px。

### Stage 4 — 权威文档

- `docs/ohbaby-web/ui/components.md`：Composer 底栏图标+描边；Header 无点阵。
- `docs/ohbaby-web/ui/README.md`：决策 3 改成「Shift+Tab + 描边；权限为框内图标」。
- `docs/ohbaby-web/test.md`：若仍写底部 mode 胶囊，改掉。
- **不回写** improve-1 / density / send-stop 的 00–05。
- **DoD**：components 不再把带字 mode 按钮当规格。

## 2.6 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `apps/ohbaby-web/src/ui/` | 无新包 | `App.tsx`、`styles.css`、unit 测试、composer 高度调用 | mode/policy 胶囊节点 | 展示层 |
| `docs/ohbaby-web/ui/` | 无 | `components.md`、`README.md`、必要时 `test.md` | 「底部带字按钮」句 | 权威规格 |
| `packages/ohbaby-cli/` | 无 | 无 | 无 | 禁止 |
| improve-1 文档 | 无 | 无 | 无 | 不回写 |

## 2.7 API / 协议 / 迁移与兼容

无协议变更。`PATCH /v1/permission` 的 mode/level 不变。键盘：Enter、Shift+Enter、Shift+Tab、双击 Esc、slash 保持。full-access 仍不弹 PermissionModal。

## 2.8 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 7 行常量漂移 | Stage 1 同步 JS+CSS+单测 | 还原 24/168 |
| 阅读列被顺手加宽 | 04 锁 `.ohb-stream-inner` 720 | 还原该规则 |
| 侧栏测例当消失 | 改断言为折叠 class，不要再 expect null | — |
| 卸点阵时弄掉思考三色 | 选择器拆开，04 抽查 thinking 色 | 还原 thinking 规则 |
| 黄边太像警告 | 用浅黄描边不是黄底 | 微调色值，不改回胶囊 |
| 玻璃发脏 | 高不透明 + 小模糊；fallback 实色 | 去掉 backdrop-filter |
| 误加 +/High/麦 | 02/03 明文 reject | 删掉 |

## 2.9 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 无 mode 按钮，Shift+Tab 保留 | Stage 1 |
| auto 灰边、plan 黄边 | Stage 1 token |
| 灰手 / 红色感叹盾 | Stage 1 |
| 只加输入框宽高 | Stage 1；stream 720 |
| 字略小 | 14/22 |
| 贴底 | composer padding |
| 侧栏推进+动画 | Stage 2 |
| 无点、三色字 | Stage 3 |
| 浅玻璃 | Stage 3 |
| 不写关键改动清单 | 未单列该节 |
| 权威文档 | Stage 4 |

## 2.10 不在本轮

- TUI chrome。
- 阅读列 800px；侧栏改 overlay；侧栏顶改 44px。
- `+`、High 下拉、模型切换、麦克风、语音键。
- 改队列协议、PermissionModal、pairing。
- 空态 70px 字标重绘；Ask Lychee 文案。
- 回写 improve-1 / density / send-stop 文档。
- Playwright 截图回归。

无 0.4 分轮候选。不预开 improve-3。
