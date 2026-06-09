# 04 · 测试与验收

> ohbaby-cli / tui-spinner
> 日期: 2026-06-09

## 1. 测试策略

沿用现有 TUI 单测风格（`*.unit.test.tsx`，ink 渲染断言），新增组件配套单测。动画类断言通过控制 `OHBABY_TUI_NO_ANIM` 或步进定时器（fake timers）来稳定。

## 2. 单元测试用例

### 2.1 WorkingSpinner 可见性
- `runtime.kind === "idle"` → 不渲染任何内容（`null`）。
- `runtime.kind === "error"` → 不渲染。
- `runtime.kind === "waiting-for-permission"` → 不渲染。
- `runtime.kind === "running"` → 渲染点点 + 文案文本。

### 2.2 每轮一句、本轮固定
- 同一 `runId` 多次重渲染：渲染出的文案文本不变。
- `runId` 由 `run_1` 变为 `run_2`：允许（且预期）换新句；为可断言，可注入/打桩随机源或断言「属于 `WORKING_PHRASES`」。
- 文案始终 ∈ `WORKING_PHRASES`。

### 2.3 reduced-motion
- `OHBABY_TUI_NO_ANIM = "1"`：
  - 不启动扫光/点点定时器。
  - 仍渲染出完整字形与整句文案（静态基色）。

### 2.4 ShimmerText 扫光推进
- 默认（动画开）：步进定时器若干次后，高光所在字符位置发生位移（断言渲染输出随时间变化）。
- 关闭动画：多次步进后输出不变。

### 2.5 文案库
- `WORKING_PHRASES` 非空、均为非空字符串。

## 3. 接线 / 回归

- `transcript-viewport` 既有单测：补充「传入 `runtime.kind==="running"` 时多出 WorkingSpinner 行」「`idle` 时无新增行」。
- `app.contract.test.tsx`：确认 `running` 状态快照里出现文案、`idle` 不出现；避免破坏既有 idle 快照。

## 4. 验收标准

1. agent 运行中（`runtime.kind==="running"`），主对话区底部出现：旋转点点 + 一句英文文案 + 扫光。
2. 同一轮内文案不变；下一轮换句。
3. agent 回到 idle，指示器立即消失。
4. `OHBABY_TUI_NO_ANIM=1` 下：静态字形 + 静态整句文案，无动画、无报错。
5. 工具行原有 spinner 行为完全不变。
6. 不出现任何计时器 / token / esc 文案。
7. 全量 `pnpm test`（或仓库既定命令）通过，无新增 lint/type 报错。

## 5. 手动验证清单

- [ ] 发一条会触发较长思考的消息，确认运行中可见、idle 后消失。
- [ ] 连续多轮对话，确认每轮文案会变、轮内不变。
- [ ] 窄终端宽度下文案不抖动、不溢出折行异常。
- [ ] `OHBABY_TUI_NO_ANIM=1` 启动，确认静态渲染正常。
