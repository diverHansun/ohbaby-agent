# LLM 契约 · 架构

## 1. Architecture Overview

历史 MessageWithParts → context/message 投影 → 冻结 PreparedModelRequest → llm-client → 独立 provider adapter → SDK。

返回方向：SDK 流 → adapter 校验/归一 → llm-client 累积快照 → lifecycle 既有执行及落库 → 既有传输投影。

估算继续消费同一冻结请求，通过局部旧口径序列化保持数值。它不变成实际 wire 测量，也不能让真实发送重新绕回 Chat。

## 2. Design Pattern & Rationale

沿用 adapter 边界，目标对应 G1/G2；不引入新 provider registry、通用 metadata 总线或统一原生 item 框架。不同协议转换可以保留合理重复，不为 DRY 把三种协议重新绑定。

## 3. Module Structure & File Layout

- `core/message`：既有存储及历史投影。
- `core/context`：组装/估算/分类，算法不改。
- `core/llm-client`：现有 client、streaming、retry；结果快照所属层。
- `services/interface-providers`：既有协议契约及三个 adapter，SDK 类型留在具体实现。
- `core/lifecycle` 与 runtime/adapters：消费新类型，保持执行和传输职责。

已批准将ModelMessage/工具值类型放在既有services/interface-providers/types.ts并向上re-export，结果快照放core/llm-client/types.ts，避免services反向依赖core/llm-client；不新增纯类型文件、包或同形别名链。旧估算映射仅新增core/context/legacy-estimation.ts私有纯helper，已批准的有限等价边界见data-model.md §6。

## 4. Architectural Constraints & Trade-offs

放弃统一 content 数组、顶层 system、全新流事件家族及永久旧公开入口。代价是保留角色/协议差异和局部旧估算序列化。公开 API 是有意破坏性迁移；持久数据和 UI 传输不能未经调查跟着改。原生输出顺序/续接能力仍受限，不可宣称终态架构。
