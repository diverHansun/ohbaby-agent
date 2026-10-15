# 3. 参考项目与取舍

> 定点核查三处（2026-10-15，与 [plan/03](../plan/03-reference-projects.md) 同期），不扩大调研范围：Codex `turn_input`、DSH `competingQueued`、ZCode `guideFallbackPreservesIntent`。
> 路径按符号查找；未找到的能力不代表所有版本都没有。

## 3.1 来源

| 简称 | 项目根（相对 `code-cli/`） | 定点文件 |
| --- | --- | --- |
| Codex | `codex/` | `codex-rs/core/src/session/turn_input.rs` |
| DSH | `deepseek-harness/` | `packages/goal/goal-round-driver/src/index.ts` |
| ZCode | `ZCode/` | `docs/conversation-protocol-declaration.md`（队列行为条目） |

## 3.2 借鉴点与取舍

| 项目 | 做法 | 与本批的相关性 | ohbaby 取舍 |
| --- | --- | --- | --- |
| Codex `turn_input.rs` | 一个入口决定 start / steer / 拒绝；`NotSubmittedReason` 类型化原因（`NoActiveTurn`、`ExpectedTurnMismatch`、`ActiveTurnNotSteerable`、`EmptyInput` 等）；"无活动轮"时同一输入改为启动新 turn；用户输入带 `acceptance_order` 保留接受顺序 | 自动分流需要"结果可分型、不抛泛化错误"的单一决策点（S2/S3/S4） | **采用**：分型结果 + 单一挂点。**适配**：ohbaby 自动 steer 只进 goal run，不新起 run；reason 集合按本项目收窄。**拒绝**：照搬 Rust 锁结构与全部 reason 枚举 |
| DSH `goal-round-driver` | `competingQueued`：任何非本轮的用户入队都挡住 goal 下一轮启动；agent 回 idle 时撤回仍 queued 的 goal 轮，避免用户输入被搁置 | "用户工作优先"的先例（plan 决议 8.5） | **采用意图**；实现由批 2 门禁承担，本批不复制 inbox / armed 激活机制 |
| ZCode 协议声明 | `guideFallbackPreservesIntent`：guide 不适用 / 被拒时同一 intent 原地回退普通 queue，payload、client、IDs、admissionSeq 与 FIFO 不变 | 预期竞争下"原项保留、身份与顺序不变"的直接对照（S2/S5） | **采用**：预期竞争不改身份 / 顺序。**适配**：不新增 admissionSeq 字段，用现成的 `accepted_at` + `admission_order` 表达同一语义 |

## 3.3 明确不借鉴

- ZCode `incompleteGoalBlocksQueueDrain`：目标未完成时阻塞 text / goal / compact 全部 queue drain，与本项目"当前 goal 轮结束后用户先跑"相反，绝不搬入。
- DSH 的持久 revision 与 armed 激活层、Codex 的独立 goals 数据库与子代理预算归集：plan/03 已排除，本批不重开。
- 不把 Codex 的 `acceptance_order` 当成新增字段需求：ohbaby 的单调 `accepted_at` 已覆盖同毫秒问题；字段名与含义不同，仅借意图。

## 3.4 对 02 的影响

- D4（分型结果、真错不吞）的形状来自 Codex 的 `NotSubmittedReason`。
- D3（顺序判定）与 ZCode admissionSeq 意图一致，但复用既有单调字段、不新增列。
- 用户队列优先的边界不依赖本批 steer；本批只保证分流不破坏批 2 已定的用户优先语义。
