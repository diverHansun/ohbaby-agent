# 03 · 实现计划

> ohbaby-cli / tui-spinner
> 日期: 2026-06-09

## 1. 新增 / 改动文件一览

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `tui/theme/tokens.ts` | 改动 | `Theme` 增 `workingSpinner: { base, highlight }`（紫色基色/高光） |
| `tui/theme/tokens.unit.test.ts` | 改动 | 补 `workingSpinner` 断言（dark/light/low-color） |
| `tui/components/spinner.tsx` | 改动 | 增可选 `color?: string`，覆盖默认 palette（让点点走紫色） |
| `tui/components/working-phrases.ts` | 新增 | 导出 `WORKING_PHRASES`（英文文案） |
| `tui/components/shimmer-text.tsx` | 新增 | 扫光文本组件 |
| `tui/components/working-spinner.tsx` | 新增 | 容器：可见性 + 选句 + 组合点点与扫光 |
| `tui/components/transcript/transcript-viewport.tsx` | 改动 | props 增 `runtime`；`<LiveTail>` 之后挂 `<WorkingSpinner>` |
| `tui/components/transcript/transcript-viewport.unit.test.tsx` | 改动 | 各 render 传 `runtime={{ kind: "idle" }}` |
| `tui/app.tsx` | 改动 | 渲染 `TranscriptViewport` 的容器（约 487 行）补选 `runtime` 并下传 |
| `tui/app.contract.test.tsx` | 改动 | beforeEach 置 `OHBABY_TUI_NO_ANIM=1`：内容级 contract 测试不校验动画，关闭可避免未卸载的 running 态 app 泄漏 80ms 定时器污染后续用例 |

> 路径前缀：`packages/ohbaby-cli/src/`。

## 2. 步骤

### 步骤 1：文案库
- 新建 `working-phrases.ts`，导出 `WORKING_PHRASES`（见 02-design §5），顶部标注 TODO 占位。

### 步骤 2：ShimmerText
- 新建 `shimmer-text.tsx`：
  - props：`{ text: string }`。
  - 内部：`useState(shimmerIndex)` + `useEffect(setInterval ~80ms)` 自增并对 `graphemes.length + window` 取模；`OHBABY_TUI_NO_ANIM === "1"` 时跳过定时器。
  - 渲染：按字符切分为 before/highlight/after 三段；高光段用 `theme.workingSpinner.highlight`，其余用 `theme.workingSpinner.base`（均取自 `useTheme()`）。
  - reduced-motion：整句单一基色 `<Text>`。

### 步骤 3：useTurnPhrase
- 可放在 `working-spinner.tsx` 内或单独 hook：
  - 入参 `runId: string`；用 `useRef<{ runId: string; phrase: string }>()` 缓存。
  - `runId` 变化时 `WORKING_PHRASES[Math.floor(Math.random()*len)]` 重新取；否则返回缓存。

### 步骤 4：WorkingSpinner
- 新建 `working-spinner.tsx`：
  - 取 `runtime`（来自 props 或 store selector）。
  - `runtime.kind !== "running"` → 返回 `null`。
  - 否则：`const phrase = useTurnPhrase(runtime.runId)`，渲染：
    ```tsx
    <Box>
      <Spinner color={theme.workingSpinner.base} />
      <Text> </Text>
      <ShimmerText text={phrase} />
    </Box>
    ```
  - 注意 hooks 顺序：`useTurnPhrase` 等 hook 不能放在 `null` 早返回之后；用一个稳定 `runId`（idle 时传空串）调用，再决定是否渲染。

### 步骤 5：接线
- `transcript-viewport.tsx`：`TranscriptViewportProps` 增 `runtime: TuiRuntimeStatus`；在 `<LiveTail>` 之后渲染 `<WorkingSpinner runtime={runtime} />`。
- `app.tsx`：渲染 `TranscriptViewport` 的容器（约 487–511 行）目前只选了 `committedMessages` / `liveMessage` / `notices`，需**补选** `runtime`（`useTuiStoreSelector(store, (s) => s.runtime)`）并透传给 `TranscriptViewport`。（顶层 App 在第 87 行已有一处 runtime 选择，但不是同一组件，不能直接复用。）

## 3. 实现注意

- **复用而非复制**：左侧点点直接用现有 `Spinner`，不另写一套帧逻辑。
- **单一时钟**：扫光与点点节奏一致（80ms），避免双定时器互相打架（参考 claude 把多个动画并到一个 frame clock 的做法）。
- **width 安全**：文案为英文 ASCII，grapheme 宽度稳定；不引入双列宽字符。
- **不破坏现有快照**：`WorkingSpinner` 仅在 `running` 时新增一行，`idle` 时不渲染，避免影响既有 idle 态测试。

## 4. 风险与回退

| 风险 | 处理 |
| --- | --- |
| 与工具行点点同时出现显得重复 | 可接受（一个是轮次心跳、一个是工具进度）；若反馈嫌吵，后续可在「有运行中工具行」时隐藏 WorkingSpinner（留作 polish，不在本批次） |
| 扫光在窄终端/慢终端抖动 | reduced-motion 开关已覆盖；节奏与点点对齐降低重绘频率 |
| 颜色 token 未定 | 用 `theme.spinner.palette` 占位，后续替换不影响结构 |
