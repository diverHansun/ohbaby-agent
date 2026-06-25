# context improve-3 · 投影层（storage → inference）

> 本轮目标：把"存储态 `MessageWithParts[]` → 推理态 `ChatCompletionMessage[]`"的转换收成一条**有名字、可测、可插阶段**的投影链；并新增"工具结果可逆遮罩"阶段（路线图 2.2），作为永久 prune 之外的第一道、可逆、不写库的削减防线。
>
> 依赖编排层：投影层的输入归口是 `runCompaction` 产出的工作集（同为 `MessageWithParts[]`）。建议在编排层去三重落地后推进本轮。

---

## 核心判断

投影层**在 ohbaby 中已实质存在**——`getActiveHistory`（选择）+ `partitionSummary`（排序）+ `serializeForLlm`（序列化）+ `projectToolMetadataForModel`（白名单）已经在做"存储留全量、推理给子集"。路线图 2.5（存储/推理分离）**实质已达成**。

本轮缺的不是分离本身，而是：

1. 投影逻辑**散在 3 处**（assemble 里的 S1/S2，serializer 里的 S3/S4），中间夹着 compaction，"发什么给模型"的真相被劈成两半（reasoning 因此成了隐藏输入）。
2. **缺一道"摘要前的可逆削减"**——路线图 2.2 想要 gemini/kimi 式的"构建时遮罩老工具输出"，与 ohbaby 现有的"永久 prune"是不同层的不同机制（见 01 文档"概念混淆"一节）。

---

## 关键设计决策（讨论已定）

- **D1：mask 采用"投影时可逆遮罩 + 占位符"**，作为投影层新阶段，与编排层的永久 prune **互补、不替换**（对齐 kimi micro/full 两道防线）。
- **D2：投影层拆为"削减"与"渲染"两半**。削减（mask）在压缩门限**之前**跑、操作 domain 类型、影响 usage 测量；渲染（serialize/白名单/summary→tag）在压缩**之后**跑、落到 wire 格式。
- **D3：mask 的 cutoff 游标用 session 内单调内存状态**，不写库；跨进程恢复重置为 0、按 usage 重探测。单进程下不持久化（YAGNI）。
- **D4：保留并复用现有白名单投影**（`tool-metadata-projection.ts`），不重写。
- **D5（缺口评审新增）：mask 默认关闭 + dark ship**。`maskEnabled` 默认 false——跑逻辑、算统计、发事件，但不替换占位符。dark ship 数据验证经济性后再翻开关（[G2](../gaps-and-decisions.md#g2mask-缺-kill-switch)）。
- **D6（缺口评审新增）：mask 事件 mandatory + 全列表**。每次 `reduceForModel` 都发 `context.masked` 事件，dark ship 期也发（带 `enabled: false`），包含被遮罩 part 的全列表（[G3](../gaps-and-decisions.md#g3mask-事件-mandatory)）。
- **D7（缺口评审新增）：豁免清单语义反转——默认可遮罩 + 豁免黑名单**。未知工具（含 MCP）默认可遮罩；仅 `write`/`edit`/`task`/`skill`/`agent_*` 豁免（[G5](../gaps-and-decisions.md#g5mask-豁免清单语义)）。
- **D8（缺口评审新增）：mask 只动 ToolPart**，SubtaskPart/TextPart/ReasoningPart 永不扫描（[G6](../gaps-and-decisions.md#g6mask-只动-toolpart)）。
- **D9（缺口评审新增）：借鉴四项目——占位符带原大小、小结果不遮、prune-summary 后 cutoff 重置、不加缓存冷触发**（[G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)）。

---

## 本目录文档

| 文档 | 内容 |
|------|------|
| [01-problem-analysis.md](./01-problem-analysis.md) | 投影层现状（4 阶段散落 3 处）+ prune/mask 概念混淆 + 缓存抖动陷阱 |
| [02-implementation-plan.md](./02-implementation-plan.md) | 投影链形状（削减/渲染两半）+ mask 阶段设计 + 影响代码点 |
| [03-acceptance-and-testing.md](./03-acceptance-and-testing.md) | 验收口径与测试标准（含遮罩豁免、协议配对、缓存单调性） |
