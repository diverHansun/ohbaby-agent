# 主对话 Working Spinner

> ohbaby-cli / tui-spinner
> 日期: 2026-06-09
> 范围: 前端 TUI 主对话区的「运行中」心跳指示器

## 一句话目标

在主对话区给「agent 正在工作」这件事一个有人格、有价值观的视觉表达：旋转点点 + 每轮一句固定的英文幽默文案 + 文字从左到右扫光。工具行的 spinner 不动。

## 文档职责（各司其职，相互配合）

| 文档 | 职责 | 读者 |
| --- | --- | --- |
| [01-problem-and-goals.md](01-problem-and-goals.md) | 问题、现状、目标、范围、关键决策记录 | 想知道「为什么做、做到哪」 |
| [02-design.md](02-design.md) | 组件结构、动画机制、文案系统、可见性、待定项 | 想知道「设计成什么样」 |
| [03-implementation-plan.md](03-implementation-plan.md) | 落地步骤、新增/改动文件、接线点 | 想知道「怎么写」 |
| [04-testing-and-acceptance.md](04-testing-and-acceptance.md) | 测试用例、验收标准 | 想知道「怎么算做完」 |

## 关键决策速查

- **文案节奏**：每轮一句、本轮固定（以 `runId` 为 key），不在一轮内轮换。
- **glyph**：复用工具行的旋转 braille 点点（`theme.spinner`），**不做**星形呼吸。
- **文字**：每轮固定的英文幽默文案，从左到右单向扫光（shimmer）。
- **颜色**：淡紫色系、亮度偏高 —— 基色 `purple`、高光 `purpleBright`（非金色）。
- **元信息**：计时器 / token / esc 提示 **全部不做**（依赖后端，留待后端接入后再议）。
- **可见性**：仅当 `runtime.kind === "running"` 时显示，idle/error/permission 卸载。
- **语言**：讨论用中文，spinner 文案用英文。

## 待定项（不阻塞落地）

1. 旋转点点替换为何种（非 emoji）图标动效：射手座 ♐ 为双列宽字符（会抖）不可用；当前无单列安全的贴合字符，**先复用点点**，后续单独评估替换方案。
2. 文案最终内容由用户持续维护（占位见 02）。
