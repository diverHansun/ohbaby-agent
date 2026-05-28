# context improve-2 文档集

本目录是 `core/context/` 模块第二轮架构优化的完整文档集。在 improve-1 修复了算法层与契约层问题、agents improve-2 完成 primary/subagent 底层统一之后，context improve-2 聚焦**长会话韧性**和**上下文可观测性**。

> 状态：规划文档。本文档只描述待实施范围，不代表代码已经完成。

---

## 文档构成

| 文档 | 职责 | 回答的问题 |
|------|------|----------|
| [problem-analysis.md](./problem-analysis.md) | 问题分析 | improve-1 完成后还有哪些设计空间？kimi-code / pi / 三层记忆架构能借鉴什么？ |
| [implementation-plan.md](./implementation-plan.md) | 实施计划 | 分几个阶段改造？与 lifecycle / message / agents 模块如何协调？ |
| [acceptance.md](./acceptance.md) | 成果验收 | 改完之后用什么标准判断已经达成目标？ |
| [tool-metadata-whitelist.md](./tool-metadata-whitelist.md) | 白名单契约 | 哪些 tool metadata 可以进入模型上下文？哪些只能留作审计/UI 内部状态？ |

---

## 阅读顺序

1. 先读 `problem-analysis.md`，理解：三层记忆架构的正确性确认 → ohbaby-agent 当前优势（S1–S8）→ kimi-code/pi 对比 → 12 个关键问题 → 优先级矩阵 → 优化目标
2. 再读 `implementation-plan.md`，理解分阶段路径与依赖关系
3. 用 `acceptance.md` 在每个阶段交付时核对验收

---

## 与 improve-1 的关系

| 维度 | improve-1 | improve-2 |
|------|-----------|-----------|
| **聚焦** | 算法层质量（切点、token 估算、摘要结构）与契约层完整性（prepareTurn 对外契约） | 工程深度（事件溯源、per-step 压缩、注入系统、origin 追踪）与生产韧性（溢出恢复、并发安全） |
| **对比对象** | 主要借鉴 pi 的 compaction 设计 | 主要借鉴 kimi-code 的 context projection/overflow recovery 思路 + pi 的文件操作累积 |
| **依赖** | — | improve-1 的 prepareTurn 契约 + 算法改进 |
| **破坏性** | 零 API 破坏 | 零 API 破坏 |

improve-1 解决了"内部做得对不对"的问题（切点、摘要、token 估算、`prepareTurn` 契约）。improve-2 解决"长 tool 链和故障场景挡不挡得住"的问题（per-step 压缩、溢出恢复、origin/事件可观测性）。

---

## 核心观点

ohbaby-agent 的三层记忆架构骨架已完整且方向正确：

```
短期记忆 (MessageManager + Part) ✅
中期记忆 (ContextManager + Lifecycle) ✅ improve-1 加固
长期记忆 (MemoryManager + OHBABY.md) ✅

工程深度缺口：
├── 事件溯源 (Record/Replay) ❌ → P1
├── Per-step 压缩 ❌ → P0
├── 溢出自动恢复 ❌ → P0
├── Tool metadata 白名单投影 ❌ → P0
├── Origin 追踪 ❌ → P1
├── 注入系统 ❌ → P2
├── 动态 completion budget ❌ → P2
├── 文件操作跨压缩累积 ❌ → P2
├── 后台异步通知 ❌ → P2
└── 压缩资产跨会话复用 ❌ → P3
```

improve-2 不质疑架构方向，而是在正确方向上的**"最后一公里"工程工作**。

---

## 已确认设计决议

- `turn` 表示用户一轮任务；`step` 表示一次模型推理循环。
- `context:prepared` 表示每个 step 前的上下文工程结果，必须在 `llm:start` 前发出。
- tool metadata 采用“raw metadata 持久化 + serializer 中央白名单投影”。
- raw metadata 用于 UI、审计、恢复；模型只看到 `serializeForLlm` 投影出的最小执行事实。
- 首批白名单向 kimi-code / opencode 的做法靠拢：把模型下一步必需的事实放进 tool result，而不是把所有 metadata 直接暴露给模型。

---

## 跨模块协作面

context 模块在本轮改造中需要与以下模块协作。首批开发建议只做 P0，后续 P1/P2 分批进入，避免把 hooks、事件溯源、后台通知一次性塞进核心路径。

| 协作模块 | 角色 | 本轮是否修改 API |
|---------|------|:---:|
| `core/lifecycle` | Per-step 压缩触发点；溢出恢复重试；LLM 调用时动态传递 completion budget | 是（内部流程，非破坏性 API） |
| `core/message` | tool part 持久化 raw metadata；`MessageWithParts.info` 或 `PartMetadata` 增加 origin/来源信息 | 是（向后兼容字段新增） |
| `core/memory` | 不变（memory 模块保持现有 API） | 否 |
| `core/system-prompt` | 不变 | 否 |
| `services/llm-model` | 不变（tokenCounter 现有 API 已足够） | 否 |
| `services/session` | 不变 | 否 |
| `agents/service` | 后台任务异步通知的事件消费（P2，可后置） | 是（新增事件，非破坏性 API） |

---

## 参考材料

| 材料 | 路径 |
|------|------|
| Agent 三层记忆架构 | 外部参考：`agent-harness/memory/2026-02-11-agent-memory-architecture.md`（不依赖本仓库绝对路径） |
| kimi-code agent 模块 | 外部参考：`kimi-code/packages/agent-core/src/agent/`（本地对照项目，不作为仓库链接） |
| pi compaction | [pi/packages/agent/src/harness/compaction/compaction.ts](../../../../pi/packages/agent/src/harness/compaction/compaction.ts) |
| improve-1 问题分析 | [docs/core/context/improve-1/problem-analysis.md](../improve-1/problem-analysis.md) |
| context architecture | [docs/core/context/architecture.md](../architecture.md) |

---

## 范围声明

本轮（improve-2）只覆盖以下内容：

- Per-step 压缩（P0）
- 上下文溢出自动恢复（P0）
- Tool metadata 白名单投影（P0）
- 事件溯源基础（P1）
- 消息 Origin 追踪（P1）
- 文件操作跨压缩累积（P2）
- 注入系统骨架（P2）
- 动态 completion budget（P2）
- 后台任务异步通知（P2）

**不在本轮范围**：

- 向量检索 / RAG 集成
- 长期记忆自动遗忘策略
- Branch / fork / session tree 模型
- 压缩摘要跨会话复用
- Memory 模块公共 API 扩展
- 异步压缩

上述能力在 context improve-3 / memory improve-1 中按需立项。
