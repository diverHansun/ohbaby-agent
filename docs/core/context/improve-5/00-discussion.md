# 讨论记录与已确认要点

> 2026-08-21 首次冻结。正式现状分析与实施方案尚未开始。

---

## 1. 背景与动机

在收敛 improve-4 时发现，prompt cache 同时牵涉 context window 占用、服务端缓存命中、LLM client 请求参数、provider usage 扩展字段和差异化计费。若在 improve-4 中直接添加 cache 字段，会在尚未确认各层职责前形成错误抽象。

## 2. 已确认：概念与范围

| 决策项 | 结论 |
|--------|------|
| Compatible 的含义 | Ohbaby 项目层面区分 `anthropic` 与 `openai-compatible` 两种 client 请求接口形状 |
| 服务端差异 | DeepSeek、Gemini 等具体服务的 cache 匹配、TTL、计费与 usage 扩展属于上游服务端机制，不增加第三种 ohbaby compatible 形状 |
| Context window | cache read/write 对应的输入仍占用窗口；是否缓存不能改变 compaction 的容量口径 |
| 后续目标 | 研究可靠观测、合理命中估算、命中率统计及 input/cache/output 差异化成本估算 |
| 关联模块 | 预计需要 context 与 LLM client/interface-provider 配合；职责与依赖方向尚未定稿 |
| 设计姿态 | 不提前冻结 cache 字段、统一语义、价格模型或预测算法 |

## 3. 已确认：与 improve-4 / 4.1 的边界

| 项 | improve-4 | improve-4.1 | improve-5 |
|----|-----------|-------------|-----------|
| 实时 Lifecycle 的 tool schema 占用 | 做 | 不回退 | 不重复 |
| 静态 `getContextUsage` / 手动 compact 的 tool schema 占用 | 不做（messages-only 遗留） | 做 | 不重复、不回退 |
| request-shaped `ContextMeasurementPayload` + 共用 factor | 分母已含实时 tools | static/manual 补齐 tools；subagent 保持 scoped runtime | 不把分母改成「仅 uncached」 |
| cache usage 字段 | 不做 | 不做 | 待设计 |
| 主动启用 cache | 不做 | 不做 | 待设计 |
| cache 命中率/成本统计 | 不做 | 不做 | 待设计 |
| 请求前命中估算 | 不做 | 不做 | 待真实观测与方案讨论 |
| 自动压缩过程 spinner | 做 | 不重复 | 不重复 |
| `/status` 与 tracker 口径 | 未统一 | 做 | 不回退 |

路线顺序在 2026-08-22 进一步确认：

```text
improve-4.1
  → 第一次压缩闭环审查
  → improve-5
  → 第二次压缩闭环复核
  → 主代理占用监测与 UI
  → memory / 长期记忆
```

这只是 improve-5 的相邻批次登记，不代表 cache 已完成现状分析。子代理占用仅用于 scoped runtime 自动压缩，不进入后续用户 UI。

## 4. 待逐项确认

1. 第一阶段优先解决“真实 usage 不丢失”，还是同时主动启用 cache。
2. Context 只负责窗口占用与理论可缓存前缀，还是也拥有 cache 统计 projection。
3. LLM client、interface-provider 与未来 cost projection 各自拥有哪部分数据。
4. 如何处理 compatible 接口下不同服务端的可选 usage 扩展，而不把 vendor 分支泄漏给 ContextManager。
5. 命中率采用 token coverage、请求命中率还是组合指标。
6. 价格数据从配置、内置 profile 还是外部同步；如何处理模型、长上下文、TTL 和时间版本差异。
7. 是否需要持久化 cache 观测，以及按 session/model/provider/cache key 的何种粒度聚合。

## 5. 用户确认记录

- 接受 cache token 属于全部 prompt/window 输入量这一概念，但要求在理解 cache 命中、计费和未来统计需求前，不固定字段与归一化语义。
- 确认 ohbaby 的 compatible 层是 Anthropic / OpenAI-compatible 两种请求形状；其他服务的差异主要体现在服务端机制。
- 确认所有 cache 字段、cache 启用和命中率统计移出 improve-4；improve-4 Task A 只修**实时** Lifecycle 的 tool schema 占用；静态/手动路径由 [improve-4.1](../improve-4.1/README.md) 收口。cache 作为后续独立批次设计。
