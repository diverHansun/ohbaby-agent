# 04 — 测试与验收方案

日期: 2026-06-05

测试栈：`vitest 2` + `ink-testing-library 4`。命名沿用项目规范：
`*.unit.test.ts`（纯函数）/ `*.contract.test.tsx`（组件契约）/ `*.integration.test.ts`。
分类跑：`pnpm test:unit` / `test:contract` / `test:integration`（`scripts/run-vitest-by-type.mjs`）。

测试金字塔：**纯函数单测为主**（render 层 + editor reducer），组件契约测试覆盖渲染/交互不变量，少量端到端验收靠 `/run`。

---

## 1. 单元测试（TDD，纯函数）

### theme
- `detect.unit.test.ts`：
  - 无法探测背景 → 回退暗色。
  - `COLORFGBG` / 环境覆盖 → 选对主题。
  - 暗色为默认。
- `tokens.unit.test.ts`：暗/亮两套 token 完整（无 undefined）；按 `chalk.level` 降级到 ansi 名。

### render/wrap
- `wrap.unit.test.ts`：
  - `visibleWidth` 忽略 ANSI 转义、正确处理 CJK 宽字符（中文占 2）。
  - `wrapAnsi` 按可见宽度折行且不切断 ANSI 序列。
  - `truncateAnsi` 超宽加 `…`，保留已开样式的复位。

### render/markdown
- `markdown.unit.test.ts`：「输入文本 → 期望行」：
  - 标题/加粗/斜体/行内码/列表/引用/链接/分隔线各一例。
  - 代码块：围栏 + 缩进 2 + 调用 highlight；无边框/背景。
  - 宽度折行：长段落按 width 折行；CJK 正确。

### render/highlight
- `highlight.unit.test.ts`：已知语言高亮非空；未知语言回退 `text.normal`；空代码不崩。

### 工具渲染器
- `tool/renderers/*.unit.test.ts`：每工具 header：
  - read/write/edit → 显示 `file_path`；bash → `command` 截断；grep/glob → `pattern`；default → 键摘要。
  - 状态图标随 `status` 变（pending/running `▸`、completed `✓`、failed `✗`）。
  - **不泄漏** 输出/diff/参数全文。

### editor reducer
- `editor-reducer.unit.test.ts`（重点）：
  - 光标 ←/→/Home/End 边界。
  - `Shift+Enter` 插入换行；`Enter` 返回 submit 意图并清空。
  - `Backspace` 跨行合并；`Ctrl+U` 清行。
  - 批量插入（粘贴）一次性进入，不逐字。
  - **历史草稿**：输入未发送 → ↑ 进历史 → ↓ 回末尾 → 草稿原样恢复（核心回归点）。
  - 多次 ↑/↓ 在历史与草稿间稳定切换。

---

## 2. 组件契约测试（ink-testing-library）

### message-block.contract.test.tsx
- 助手 text part → markdown 渲染（含加粗/代码块标记），**不出现** `ohbaby` 文字角色头。
- 用户 part：暗色出现左竖线 `▎`、**不出现** `you`。
- reasoning part → `theme.reasoning`（灰 textMuted）渲染，相对正文克制。
- tool part → 单行 header（图标+名+主参），不含输出体。
- **回归守卫**：任何 part 渲染输出中**不得**出现 `you` / `ohbaby` / `assistant` / `tool` 角色文字标签（断言不包含）。

### prompt/editor.contract.test.tsx
- 输入字符 → 显示；Shift+Enter → 多行显示；光标可见。
- slash 输入 `/` → completion 显示；↑/↓ 切候选（不触发历史）；Tab 补全；Enter 提交。

### status-bar.contract.test.tsx
- 显示 mode·permission·session；无 token 数据时右侧不出现占位文本。

### app.contract.test.tsx（扩展现有）
- 保持现有不变量：快照渲染、catalog 刷新、`app.exit` 退出。
- `Shift+Tab` 触发权限模式切换命令；运行中 `Ctrl+C` abort。
- 空会话显示 Logo。

### dialogs（按风险覆盖，非随机抽样）
现有 6 个 dialog 组件，按复杂度/频率定向覆盖，避免抽样遗漏：
- **manager.contract.test.tsx**（最复杂）：permission/interaction 队列路由逻辑——多个请求排队、依次弹出、响应后出队。
- **permission-dialog.contract.test.tsx**（最复杂交互）：渲染 choices、选中态主题色、allow/deny/abort intent 正确回传、remember 选项。
- **confirm.contract.test.tsx**（最高频）：确认/取消渲染与回调。
- **select-one** 系（model/session/select-one 三个 wrapper）：抽 **一个** 代表测渲染 + 选中切换即可，逻辑同构。

---

## 3. 验收场景（`/run`，真实 PowerShell）

在 Windows PowerShell（黑底）实际启动 `ohbaby`，逐项目测：

| # | 场景 | 期望 |
|---|---|---|
| 1 | 空会话启动 | 显示 Logo（OHBABY 紫金标题，金主紫辅）+ 暗色主题，无报错 |
| 2 | 发送中文消息 | 用户消息带左竖线，无 `you` 字样，CJK 不错位 |
| 3 | AI 返回 markdown（标题/列表/加粗/代码块） | 正确渲染，代码块高亮、缩进、无边框 |
| 4 | AI 调用工具（read/edit/bash） | 每个工具单行折叠：图标+名+主参，无输出刷屏 |
| 5 | reasoning | 灰（theme.reasoning / textMuted），相对正文克制、不喧宾夺主 |
| 6 | 多行输入 Shift+Enter | 正确换行，Enter 才提交 |
| 7 | 粘贴多行文本 | 一次性插入，不逐字、不卡顿 |
| 8 | 历史 ↑/↓ + 未发送草稿 | 翻历史再回来草稿不丢 |
| 9 | slash 命令 `/` | 补全列表正常，↑/↓ 选候选 |
| 10 | 运行中 spinner | 金紫交替动画（呼应 logo）；Ctrl+C 能中断 |
| 11 | 权限弹窗 | dialog 主题统一，可选择 |
| 12 | 窄/宽终端 resize | 折行自适应，不溢出 |
| 13 | 状态行 | 左 mode·permission·session，右侧 token 槽位留空 |

记录每项截图/结果。任何项失败回到对应模块修复并补测。

---

## 4. 子代理测试审核（实施完成后）

实施完成后派**子代理**做独立审核（用户触发），范围：

1. **跑全量测试**：`pnpm -F ohbaby-cli test`（unit + contract），报告通过/失败与覆盖。
2. **代码审查**：对照本 specs 检查
   - 组件是否只引语义 token、无硬编码颜色残留；
   - `render/` 是否纯函数、无 React 依赖；
   - 工具渲染是否泄漏内部详情（应只单行）；
   - 不变量（app 行为、slash 补全）是否保持。
3. **验收对照**：按第 3 节场景表逐项确认或指出差距。
4. 输出问题清单，回归到对应模块。

> 注：`/code-review` 与 `ultrareview` 为用户触发、计费操作，子代理审核由维护者发起，不在实施代理内自动运行。

---

## 退出标准（Definition of Done）

- 第一版范围（02 文档第 4 节"做"）全部实现。
- 所有单测/契约测试通过。
- 验收场景 1–13 通过（或差距已记录并经维护者接受）。
- 无硬编码颜色残留（全部走 theme token）。
- `store / slash-commands / ohbaby-sdk` 零改动。
- 延后项（diff、token 统计、展开等）已在文档/problem-lists 标注，未偷偷半实现。
