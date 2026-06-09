# 01 · 问题分析与目标

> ohbaby-cli / tui-spinner
> 日期: 2026-06-09

## 1. 问题

主对话区当前没有「轮次级别」的工作指示器。当 agent 正在运行时，用户能看到的反馈只有两处：

1. live message 内部、处于 `running`/`pending` 的**工具行**上的 braille 点点 spinner（[spinner.tsx](../../../packages/ohbaby-cli/src/tui/components/spinner.tsx)）。
2. 输入框页脚在 `error` 时显示的 `runtimeStatusLabel`（[app.tsx](../../../packages/ohbaby-cli/src/tui/app.tsx)）。

也就是说：**当 agent 在思考、还没产出工具调用时，主对话区没有任何「我在工作」的心跳**。这段空窗体验差，也浪费了一个表达产品人格 / 价值观的位置。

## 2. 现状盘点

- 运行状态信号已存在：`runtime: UiRunStatus`，形如 `{ kind: "running"; runId: string; title? }`，另有 `idle` / `waiting-for-permission` / `error`（[snapshot.ts](../../../packages/ohbaby-sdk/src/snapshot.ts)）。
- `splitTranscript` 已把「正在流式 / 有运行中工具」的尾部消息拆成 `liveMessage`（[transcript.ts](../../../packages/ohbaby-cli/src/tui/store/transcript.ts)）。
- `TranscriptViewport` 已渲染 `<LiveTail>`，是天然的挂载点（[transcript-viewport.tsx](../../../packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.tsx)）。
- 现有 `Spinner` 组件从 `theme.spinner.{frames,palette}` 取帧与配色，受 `OHBABY_TUI_NO_ANIM` 控制动画开关。

结论：所需的状态信号与挂载结构都已具备，本特性是**纯前端增量**，不需要新增任何后端能力。

## 3. 调研结论（gemini-cli / kimi-code / claude-code）

| 项目 | 「活着」来自 | 幽默来自 | 节奏 |
| --- | --- | --- | --- |
| gemini | 字形**颜色**渐变 | 次要轮换文案 | 每 5s 换 |
| kimi | 独特**字形**（月相） | 字形 + 状态标签 | 按状态 |
| claude | 字形脉冲 + 文字扫光 | 动词本身 | 每轮一句 |

借鉴取舍：

- 采纳 claude 的「**每轮一句、本轮固定**」文本模型 —— 不在一轮内频繁换字分散注意。
- 采纳「**文字扫光**」作为活着的精致感来源（通用手法，非 claude 专有）。
- **不**采纳 claude 的星形脉冲呼吸机制及其字符集。
- **不**采纳 gemini 的「次要轮换文案 + 计时 + esc + token」那一整套元信息（依赖后端数据，且信息过密）。

## 4. 目标

1. 主对话区出现一个轮次级别的「运行中」心跳，仅在 `runtime.kind === "running"` 时可见。
2. 视觉上区别于工具行：靠**每轮一句的英文幽默文案** + **扫光**，而非更花的字形。
3. 文案承载 ohbaby 的价值观（星矢「燃烧小宇宙」/「raise a baby、agent 是意识体」意象），可被维护者轻松替换。
4. 纯前端交付，零后端依赖；不引入任何依赖后端数据的元信息。

## 5. 范围

**做**：新增 `WorkingSpinner` 组件、英文文案库、按 `runId` 选句、扫光、可见性接线、reduced-motion 兼容、单测。

**不做（本批次）**：

- 计时器、token 计数、esc 取消提示、stall 变红 —— 依赖后端输出/取消链路，待后端接入后再单开批次。
- 专属品牌 glyph 字符（无单列安全的贴合字符，先复用点点）。
- 颜色最终值（先用 `theme.spinner.palette` 占位）。

## 6. 关键决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 文本节奏 | 每轮一句、本轮固定 | 稳，不分散注意；以 `runId` 为天然 key |
| glyph | 复用工具行旋转点点 | 无单列安全品牌字符；星形呼吸被否 |
| 文字效果 | 保留扫光 | 区别于工具行、体现「活着」的精致感 |
| 元信息 | 全部不做 | 依赖后端，避免「前端跑在后端前面」 |
| 语言 | 英文文案 / 中文讨论 | 用户指定 |
| 文案数量 | 先 10 条 | 用户后续提供最终内容 |
