# 1. 现状与问题

> 2026-09-13，代码 a18290f3；本轮没有实施。以下路径默认相对仓库根。

## 1.1 承重问题

| ID | 现状证据 | 风险 | 对应方案 |
| --- | --- | --- | --- |
| P1 | `packages/ohbaby-agent/src/core/llm-client/types.ts:29` 直接别名 ChatCompletionMessageParam；provider types.ts:90 同样依赖 | SDK 输入面大于主流程；换成文本子集会静默收窄 | A、U1 |
| P2 | `core/llm-client/streaming.ts` buildCompleteMessage；types.ts:155 completeMessage | 未完成快照被误称完整消息，工具片段不等于请求调用 | B、U3 |
| P3 | `core/context/token-estimation.ts:43,60` JSON stringify、重建等值和七桶序列化 | 仅改字段也可能改变压缩触发和 composition 是否存在 | A/C、U5 |
| P4 | `core/lifecycle/types.ts:167`、`core/agents/types.ts:53`、根 index.ts 的 re-export | 间接公开契约，单查 Chat import 会漏 | B/C、01a |
| P5 | prompt-cache-wire.contract.test.ts:234；context/serializer.ts:151 | nested cache_control 与活动 reasoning 回传已有合同 | A、U2 |

## 1.2 职责、架构与数据模型

llm-client 创建绑定 provider 的 client、累积事件和执行现有重试；adapter 原生调用独立，但输入仍是 Chat-shaped。context serializer 从已有 MessageWithParts 生成 Chat 消息；持久 Message/Part 不是 Chat SDK 对象。`core/message/database-store.ts:62` 分别 stringify Message 和 Part，故无 SQL 改动不等于 JSON 格式可随意改变。

`services/interface-providers/openai-compatible.ts:57` 直接透传 messages。Anthropic 的 convertMessages 重建内容并聚合 system/developer；Responses 严格字段 allowlist，字符串以外内容仍受限。不能把三者说成同一支持矩阵。

## 1.3 用例与非功能

主/子代理、context summary、session title 都消费 LLM 类型。取消、重试、流失败和最终工具授权不能因新名字改变；streaming.ts 取消结果也会 isComplete=true。历史空文本过滤、无文本工具 assistant 的 null、空回复占位 `(Empty response)` 和取消占位 `(Interrupted)` 均为现状，不在本轮清理。

## 1.4 文档与实现差异

| 文档说 | 当前实现 | 本轮处理 |
| --- | --- | --- |
| `docs/core/llm-client/goals-duty.md` 不做 retry | streaming.ts 已有 retry 通知/重试路径 | 同步真实职责，不新增策略 |
| improve-2 接入独立 adapter，canonical 留后续 | 与代码一致 | 本轮只做受限契约，不加入 continuation |
| context improve-5/07 同一冻结 request，估算公式不变 | estimator/composition 耦合 Chat JSON | 保留同源和旧数值，兼容序列化待明确 |
| context improve-6 composition 与 cache 分家 | 已有独立路径 | 不改七类、统计或 UI |

## 1.5 测试与跨模块风险

已有 provider unit/wire contract、Responses integration、message database reopen、context scope、token roundtrip 测试可复用；尚没有针对本轮新契约的发布包消费者、旧新估算等价和桥接快照缺失测试。完整暴露链见 01a。

## 1.6 SWE 审视

主问题是边界耦合，不是所有名称不好。沿用 adapter、保留历史模型、避免万能扩展与新管理器符合复杂度控制。公开 API 删除是有意不兼容；未知输入收窄必须另行确认。不要用新类型掩盖桥接缺失数据，也不要为保持数字复制整套供应商框架。
