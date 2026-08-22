# context improve-5 · prompt cache 观测与优化（规划入口）

> 状态：已预留独立批次；仅完成范围登记，尚未进入现状分析与方案设计
> 日期：2026-08-21
> 来源：从 [improve-4](../improve-4/README.md) 剥离。**前序实施含 [improve-4.1](../improve-4.1/README.md)**（占用信封 `RequestPayload` + 全路径 tools 计量）。本批不回退那套占用模型。
>
> 本目录使用 `plan-code-improvement` 推进。当前 README 与 00 只冻结已确认边界，不构成实施契约；01–04 必须在后续逐项讨论后按顺序产出。

---

## 1. 为什么独立成批

Ohbaby 对外只需要面对 `anthropic` 与 `openai-compatible` 两种 client 请求接口形状，但 cache 匹配、TTL、cache read/write usage、计费与可诊断能力由具体上游服务端决定。该议题同时涉及 interface provider、LLM client、context 占用和未来 cost projection，不能塞进 improve-4 的实时 tool schema 修复，也不能塞进 improve-4.1 的静态/手动占用收口，更不能先用几个可选字段固定未来模型。

## 2. 已确认的目标边界

- cache 命中的输入仍占用 context window；cache 主要改变延迟与计费。
- 后续需要研究并支持合理的 cache 观测；在有真实观测之后，才讨论命中估算。
- 未来很可能需要 cache 命中率与差异化 input/cache/output 计费统计。
- 需要讨论 context 与 LLM client 的协作边界，但不预设最终数据结构。
- 本批与 improve-4 / **improve-4.1** 独立：不新增 cache 字段、不启用 cache、不做命中率/成本统计或预测；**不回退** 4.1 的 `RequestPayload` 与全路径 tools 计量。占用分母以 4.1 之后的 `measureUsage({ messages, tools })` 为准；cache 只叠加观测/计费，不把启发式改成「仅 uncached」。

## 3. 当前不冻结的事项

- cache usage 字段名称、层级与跨 provider 归一化语义
- cache policy、breakpoint、cache key 与 TTL 配置
- 命中率定义（请求级、token coverage 或其他）
- 价格目录来源、版本化与成本计算归属
- 请求前命中估算模型及是否持久化历史统计
- 首批支持哪些上游服务端扩展字段

## 4. 文档地图

| 文档 | 状态 | 作用 |
|------|------|------|
| [00-discussion.md](./00-discussion.md) | 已建立 | 冻结当前已确认结论与未决项 |
| `01-problem-analysis-and-current-state.md` | 待讨论后创建 | 现状、真实 usage 能力、代码锚点与问题分类 |
| `02-optimization-plan-and-change-scope.md` | 待 01 确认 | 分阶段方案、职责边界、数据流与改动面 |
| `03-reference-projects.md` | 可选，待调研 | 官方 provider 与优秀项目对照 |
| `04-test-and-acceptance.md` | 待方案确认 | 观测、计费与缓存策略的风险导向验收 |
| `05-implementation-acceptance.md` | 实施后 | 由验收模式写入 |

后续必须按 README → 00 → 01 → 02 → 03（可选）→ 04 的顺序讨论和定稿。本目录当前不可直接交给实施会话。
