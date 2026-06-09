# 02 · 设计

> ohbaby-cli / tui-spinner
> 日期: 2026-06-09

## 1. 设计原则

1. **轮次级心跳，与工具行解耦**：`WorkingSpinner` 表达「这一轮 agent 在工作」，工具行 spinner 表达「这个工具在跑」，两者独立、互不替换。
2. **纯前端、零后端依赖**：只读现成的 `runtime` 信号，不新增 RPC、不展示任何依赖后端数据的元信息。
3. **与现有 Spinner 同构**：同样从 `theme.spinner` 取帧/配色，同样受 `OHBABY_TUI_NO_ANIM` 控制动画。
4. **内容与机制分离**：文案是可替换的数据（独立常量文件），动画是稳定的机制。

## 2. 组件结构

```
WorkingSpinner            // 容器：决定是否显示、选定本轮文案
├── <Spinner/> 复用        // 旋转 braille 点点（theme.spinner.frames，80ms）
└── ShimmerText           // 英文文案 + 从左到右扫光
```

- `WorkingSpinner`：从 store 选 `runtime`；`runtime.kind !== "running"` 时返回 `null`；否则按 `runtime.runId` 取本轮文案，渲染 `<Spinner/>` + `<ShimmerText text=...>`。
- 直接复用现有 [spinner.tsx](../../../packages/ohbaby-cli/src/tui/components/spinner.tsx) 作为左侧点点（不传 `label`，文字交给 `ShimmerText`）。
- `ShimmerText`：新增组件，承载扫光逻辑（见 §4）。

## 3. 可见性与文案选择

### 3.1 可见性

| `runtime.kind` | 行为 |
| --- | --- |
| `running` | 显示（点点转 + 文案 + 扫光） |
| `idle` / `error` | 卸载（消失） |
| `waiting-for-permission` | 卸载（权限有独立对话框，不抢占） |

### 3.2 每轮一句、本轮固定

- 以 `runId` 为 key：进入某个 `runId` 时随机抽一句，**整轮不变**；`runId` 变化（新一轮）才换新句。
- 实现：`useTurnPhrase(runId)` —— 用一个 ref 记住 `lastRunId → phrase`；`runId` 改变时重新随机。
- 同一 `runId` 多次重渲染必须返回同一句（保证测试可断言、视觉稳定）。

## 4. 扫光机制（ShimmerText）

- 把文案按 grapheme 切分；维护一个 `shimmerIndex`，每 ~80ms 右移一格（与点点同节奏，单一时钟即可）。
- 渲染时：落在 `[shimmerIndex-1, shimmerIndex+1]` 窗口内的字符用**高光色**，其余用**基色**；窗口走到末尾后回到起点循环。
- 高光色、基色取自 `theme`（具体色值待定，先用 `theme.spinner.palette` / 文本基色占位）。
- **reduced-motion**（`OHBABY_TUI_NO_ANIM === "1"`）：不扫光、不转点（沿用现有 Spinner 行为），整句静态基色，仍完整渲染字形与文案。
- 单向：只从左到右，不来回。

## 5. 文案库

- 新增 [working-phrases.ts](../../../packages/ohbaby-cli/src/tui/components/) 常量文件，导出 `WORKING_PHRASES: readonly string[]`。
- 先维护 **10 条英文占位文案**，清楚标注「待用户替换」。占位示例（贴合 燃烧小宇宙 / raise-a-baby / 意识体）：

```ts
// 文案为产品人格表达，可随时增删；数量不必恰好 10。
export const WORKING_PHRASES = [
  "I was thinking about the name of this project when I travelled to Shenzhen...",
  "I still remember the time I couldn't walk and just crawled...",
  "Looking back on the path of raising a baby, I mean, an agent...",
  "The awakening of individual consciousness...",
  "Guess where the \"ohbaby-agent\" name comes from...",
  "Actually, I watched Saint Seiya during my Java course in my sophomore year...",
  "What's your favorite programming language?...",
  "I do nearly everything with the help of Codex and Claude Code these days...",
  "How did you find your internships?...",
  "Using parallel agents to complete tasks actually distracts my attention...",
] as const;
```

- 文案由用户提供；已做轻量语法校正（仅修语法、不改语气）：① "thinking about"；② 去掉行尾多余空格；⑥ "in my sophomore year"；⑧ "do nearly everything" + 专有名词 "Codex / Claude Code"。
- 维护方式：直接增删该数组即可。

## 6. 颜色（淡紫色系）

- 走**淡紫色系、亮度偏高**（非金色）。
- 点点 + 文案基色 = `theme` 的 `purple`（深色 `#B9A3E3` / 浅色 `#7C5BC4`）。
- 扫光高光色 = `purpleShimmer`（接近白的亮薰衣草，深色 `#F3ECFF` / 浅色 `#C9B2F5`）。
  - 注意：`purpleBright`（`#C9B8EC`）与基色太接近、扫光肉眼几乎不可见，故高光单独引入 `purpleShimmer` 以拉开明度对比。
- 扫光光带宽度 5 字符（head ± 2）、步进 55ms，确保可感知。
- 为让点点也走紫色：给 `Spinner` 增加可选 `color` prop，覆盖其默认（金色）palette；工具行不传该 prop，行为不变。

## 7. 明确不做（依赖后端）

计时器、token 计数、esc 取消提示、stall 变红。这些需要后端输出/取消链路信号，留待后端接入后另开批次。

## 8. 待定项

1. 专属品牌 glyph 字符 / 旋转点点替换为何种（非 emoji）图标动效 —— 后续单独评估。
2. 文案最终内容由用户持续维护。
