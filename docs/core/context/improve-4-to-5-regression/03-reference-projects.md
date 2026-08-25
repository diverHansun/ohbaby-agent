# 3. 优秀项目借鉴与取舍

## 3.1 借鉴来源与路径校正

用户提供的 `/Users/hansun025/Projects/code-cli/*` 在本机不存在；本轮使用实际可访问的本地镜像：

| 项目 | 本地路径 | 调研基线 | 主要范围 |
|---|---|---|---|
| DeepSeek Harness | `/Users/hansunwork26/workspace/projects/code-cli/deepseek-harness` | `528c682e06` | compaction transaction、session property、hard crash recovery |
| Claude Code Best | `/Users/hansunwork26/workspace/projects/code-cli/claude-code-best` | `d010f77` | auto compact、session memory、prompt cache break diagnostics |
| Codex | `/Users/hansunwork26/workspace/projects/code-cli/codex` | `e396ef3` | history snapshot/normalize、world state、两阶段 long-term memory |
| Kimi Code | `/Users/hansunwork26/workspace/projects/code-cli/kimi-code` | `cfc335048` | replayable context、tool repair、compaction state、scope |
| OpenCode | `/Users/hansunwork26/workspace/projects/code-cli/opencode` | `b155b15` | preserve budget、instruction claims、snapshot timing race |
| Pi | `/Users/hansunwork26/workspace/projects/code-cli/pi` | `b7bb00b93` | append-only compaction entry、pure projection、named regressions |

`claude-code-best` 是本地参考镜像，不视为 Anthropic 官方 Claude Code 源码；只借鉴可以在该镜像中核实的实现，不把其行为当官方协议。

逐项目长报告收录在 [context-references/README.md](./context-references/README.md)。这些报告是证据附件；本文件负责消歧、划分 production/rewrite/scaffold，并把借鉴结论映射到 02/04。路径与行号以表中调研基线为快照，代码演进后定位以符号为准。

## 3.2 先统一术语，避免错误类比

六个项目对“memory/context”的命名并不一致：

| 本文术语 | 含义 | 典型参考 |
|---|---|---|
| durable transcript/ledger | 持久化的原始消息、事件或 session entry | DeepSeek log、Pi entries、OhBaby MessageStore |
| model view / working context | 当前模型真正可见的 messages/tools 投影 | Kimi `contextMemory`、Pi `buildSessionContext`、OhBaby `PreparedModelRequest` |
| run snapshot | 一个 Agent run 内保持稳定的 system/memory/runtime 基线 | Codex context snapshot、OhBaby `AgentRunPromptSnapshot` |
| long-term memory | 跨 session 的稳定事实与召回管线 | OhBaby `OHBABY.md`、Codex memories pipeline |

因此不能看到 Kimi 的 `contextMemory` 就推断它等价于 OhBaby 的 `OHBABY.md`；前者主要是可重放工作上下文，后者才是长期文件记忆。

## 3.3 DeepSeek Harness

### 可验证做法

- `packages/compaction/compaction-basic/src/region.ts:152-254`：压缩先写 `compaction/start`，异步 summarize 后复核稳定性，再以不 yield 的提交段写 summary/replacement，最后写 `compaction/end`。
- 同文件 `inspectCompactionEntryState()` / `assertCompactionInactive()`：当前 lifecycle 的 unmatched start 是 busy；早于最新 `session/end-seed` 的 unmatched start 才是旧 lifecycle stale evidence。
- `docs/subsystems/compaction.md:88`：压缩边界前后检查 tool-call/result pairing。
- `packages/core/session/tests/properties.spec.ts:96-157`：使用 `fast-check` 验证 log replay、seq、immutability 等属性。
- `packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts:39-65`：父进程预创建空 marker，等待子进程写入精确内容后 `SIGKILL`，避免“文件存在但尚未到故障点”的假阳性。
- 同一 crash suite `:84-108`：请求 dispatch 前事实持久化；tool side effect 后缺失结果恢复成 unknown。

### OhBaby 取舍

| 做法 | 取舍 |
|---|---|
| 属性/模型化状态测试 | **Adopt**：直接用于 R1，不需要先改生产架构 |
| hard-crash failpoint | **Adapt**：R3 至少覆盖一个真实数据库子进程恢复场景 |
| tool pairing 作为压缩不变量 | **Adopt**：进入所有 prune/summary/restart 场景 |
| 全面 session event sourcing | **Reject now**：OhBaby 已有 MessageStore，迁移成本远大于本轮证据需求 |
| durable start/end compaction | **Conditional**：只有窄原子提交无法满足 R3 时才采用；若采用，必须同时借鉴 lifecycle epoch 的 busy/stale 区分 |

关键启发：压缩不是“summary 函数成功返回”，而是一个必须有唯一终态的 durable state transition。

## 3.4 Claude Code Best（本地镜像）

### 可验证做法

- `src/services/compact/autoCompact.ts:28`：为 compaction/output 预留 token。
- `src/services/compact/autoCompact.ts:96-99,286-291`：连续三次自动压缩失败后 circuit breaker，避免每 turn 热循环。
- `src/services/compact/compact.ts:231-299,486-503`：compaction 请求自身 prompt-too-long 时，最多三次按 API round 从头部裁减，并保留 user-first/tool pairing 边界。
- `src/services/SessionMemory/sessionMemory.ts:136-168`：session memory extraction 有 token/tool thresholds，避免过度提取。
- `src/services/api/promptCacheBreakDetection.ts:101,149`：按 query source/agent 跟踪 cache baseline。
- 同文件 `:191-195,264-303`：对 tools/system/cache-relevant input 哈希并限制跟踪来源数量。
- 同文件 `:469-486,684-699`：microcompact/compaction 后重置 baseline，避免把合法 cache read 下降误报为 break。
- `src/services/contextCollapse/index.ts:1` 明确是 auto-generated stub；其函数基本为 no-op。

### OhBaby 取舍

| 做法 | 取舍 |
|---|---|
| 失败熔断/有界尝试 | **Adopt concept**：OhBaby 已有 thrash lock + per-turn cap，联合回归验证而非重做 |
| summary 自身 prompt-too-long 收缩 | **Adapt**：进入 D9/CMP-13；按 OhBaby durable turn/tool 结构实现，不复制镜像内部 message 类型 |
| cache break source/scope 诊断 | **Adapt**：按 session/scope/tool epoch 记录稳定 prefix 差分，不复制其 telemetry 系统 |
| compaction 后 cache baseline reset | **Adopt concept**：加入 `PFX` 系列测试 |
| 自动 session memory extraction | **Reject this round**：超出现有只读 Memory 契约 |
| contextCollapse | **Reject as evidence**：本地代码是 stub，不能作为实现参考 |

关键启发：缓存下降不一定是缺陷，压缩和有意 tool epoch 变化需要可解释的 baseline transition。

## 3.5 Codex

### 可验证做法

- `codex-rs/core/src/context_manager/history.rs:45-64`：实际结构体 `ContextManager` 同时维护 raw items、`history_version` 与 world-state baseline；`ConversationHistorySnapshot` 是另一个消费 trait。
- 同文件 `:101-143`：copy-on-write snapshot 和 world state diff。
- 同文件 `:207-242`：raw/normalized/snapshot 消费边界明确。
- 同文件 `:444-457`：normalize 会补 call outputs、删除 orphan outputs、按模型能力过滤输入。
- `codex-rs/memories/README.md:31-38` 与 `codex-rs/memories/write/src/start.rs`：只有 root、非 ephemeral、memory enabled、DB 可用时启动 long-term memory；subagent 不启动。当前运行实现已迁到 `memories/write/src/`，不能只按 README 的历史布局推断。
- 同文档 `:40-77`：Phase 1 按 thread claim/lease/backoff 并行提取，且 redacts secrets。
- 同文档 `:79-116`：Phase 2 取得全局锁、选 bounded top-N、生成 workspace diff，再启动受限 consolidation subagent。
- `codex-rs/core/src/compact.rs:309-318`：compaction request 自身 `ContextWindowExceeded` 时从最旧历史单元开始移除并重试，以保留近期消息和可复用缓存部分。
- `codex-rs/core/src/context_manager/normalize.rs:18-21,144-148`：synthetic output ID 使用固定 UUIDv5 namespace；源码明确说明 namespace 变化会使 prompt cache 失效。

### OhBaby 取舍

| 做法 | 取舍 |
|---|---|
| raw history 与 normalized model view 分离 | **Adopt/confirm**：OhBaby 已有 active history + serializer/projection；联合回归固化 |
| snapshot version / diffable dynamic context | **Adapt later if needed**：本轮先用 tool epoch 和 request diff 测试，不增加通用 world-state 框架 |
| normalize 修复 tool outputs | **Adopt concept**：重建/abort 后合法 tool pairing 是硬不变量 |
| deterministic synthetic output identity | **Adapt**：进入 D10/INV-04/PFX-12；OhBaby 使用自身 durable call id/status/version，不照搬 UUID namespace |
| 两阶段长期记忆 | **Reject this round**：它证明主动 Memory 是独立产品/架构，不是一个 Context helper |
| root-only Memory | **Adopt current contract**：OhBaby primary 加载、subagent 隔离 |

关键启发：长期记忆需要 provenance、lease、redaction、backoff、删除与 eval；这正说明本轮不应顺便“补一个 memory tool”。

## 3.6 Kimi Code

### 可验证做法

- `packages/agent-core-v2/src/agent/contextMemory/contextOps.ts:80-105`：context state 是 replayable，append/loop/compaction 都折叠进状态。
- `packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts`：定义未记录结果的 tool execution 为 interrupted，禁止假定成功。
- 同文件 `:91-114,316-336`：恢复 pending tool calls 并补 synthetic interrupted tool messages。
- `packages/agent-core-v2/src/agent/fullCompaction/compactionOps.ts:9-40,78-93`：begin/cancel/complete 是 replayable compaction phase。
- `packages/agent-core-v2/src/agent/scopeContext/scopeContext.ts:7-21`：显式 scope key helper。
- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:639-703`：summary 请求 overflow 时有界删除最旧消息并清理前导 tool result；`historySafeToCompact()` 在提交前验证原始前缀只允许追加真实 user input。
- 同文件 `observeContextOverflow()`：以观察值的 85% 收紧 modelAlias 的 effective window；本轮只作为 P2 参考，不直接采用。
- `packages/agent-core-v2/test/harness/agent.ts:1829-1863,2338`：`expectResumeMatches()` 使用 `failOnResumeGenerate` 重建，恢复期任何 LLM generate 都会直接失败，并比较 live/resumed state snapshot。

### OhBaby 取舍

| 做法 | 取舍 |
|---|---|
| replay equivalence 测试 | **Adopt**：即使生产不是事件溯源，也能重建 MessageStore 后比较 model view |
| unfinished tool repair | **Adapt**：与 Lifecycle/Message 当前 abort 语义对齐，不能直接复制文案 |
| compaction phase terminal state | **Adopt as invariant**：每次 attempt 必须完成/取消/失败，不能永久 running |
| summary overflow shrink + commit revalidation | **Adapt**：进入 D8/D9/CMP-13，不复制其 journal/DI 生命周期 |
| resume parity + fail-on-generate | **Adopt**：重建必须零 LLM、零 observable replay event |
| observed model window | **Record only**：P2/out of scope；需要独立定义持久化、衰减和 Provider identity 后再实施 |
| 全部 context 改 replayable state | **Reject now**：先用 Reference Model 测试，不改生产范式 |

关键启发：重放后的“模型看到什么”比内部对象是否相同更重要。

## 3.7 OpenCode

### 可验证做法与实现边界

- 当前 production app 路径是 `packages/opencode/src/*`；`packages/core/src/*` 是并存的 rewrite。以下行为若未特别说明均来自 production app，不能把 rewrite/scaffold 当作已上线能力。
- `packages/opencode/src/session/compaction.ts:115-170`：preserve recent token budget，并可在预算内 split turn。
- 同文件 `:230-259`：按预算从尾部选择保留边界。
- 同文件 `:271-315`：保护最近 tool result，裁剪更旧输出。
- `packages/opencode/src/session/instruction.ts:74,201-204`：动态 instruction 以 message ID 建 claims set，避免重复注入。
- `packages/opencode/test/session/snapshot-tool-race.test.ts:2-12,126`：把真实 timing race 固化为命名回归，而不是依赖事件顺序假设。
- `packages/opencode/src/session/compaction.ts:450-459`：summary 自身再次 overflow 时把 compaction assistant 标记为 `ContextOverflowError/finish=error` 后停止；这是明确的当前限制，不是 OhBaby 应复制的恢复目标。
- `packages/core/src/session/compaction.ts`：存在事件化 pre-flight compaction rewrite；本文只将其作为未来方向参考，不与 production 结论混写。

### OhBaby 取舍

| 做法 | 取舍 |
|---|---|
| 动态注入 provenance + per-message dedupe | **Adapt**：用于 runtime part 幂等，最终应由 durable 写边界保证 |
| snapshot timing race 回归 | **Adopt**：R2/R4 用 barrier 控制 prepare/send 与即时 tool execution |
| preserve budget/split turn | **Reference only**：OhBaby 已有 preserve ratio/cut point，不在本轮调策略 |
| summary 自 overflow 后 stop | **Reject as target**：只把它当已知失败形状；OhBaby 目标是 D9 的有界自救 |
| 全套 Effect 架构 | **Reject**：与测试目标无关 |

关键启发：时序 Bug 要用能控制先后关系的回归测试，不用 `sleep()` 祈祷它出现。

## 3.8 Pi

### 可验证做法

- `packages/coding-agent/docs/compaction.md:43-45`：compaction append entry，保存 `summary + firstKeptEntryId`，随后重建 model context。
- 同文档 `:79`：重复压缩从上一 kept boundary 继续，重新计算真实 pre-compaction context。
- `packages/agent/src/harness/session/context.ts:45-49`：`defaultContextEntryTransform()` 是简单纯投影，从最新 compaction 构建 context entries。
- `packages/coding-agent/test/suite/regressions/7150-rpc-prompt-during-compaction.test.ts:14`：manual compaction 中拒绝新 prompt。
- `packages/coding-agent/test/suite/regressions/7253-manual-compact-during-response.test.ts`：响应进行中手动压缩只产生一次 manual compaction，不与 threshold auto compact 叠加。
- `packages/coding-agent/test/suite/regressions/8328-zero-usage-auto-compaction.test.ts:50,66`：Provider 没有 usage 时用 message estimate，不在低于阈值时误压缩。
- `packages/coding-agent/test/suite/regressions/6647-compaction-retries-transient-stream-drop.test.ts:82-189`：transient summarization retry、不可重试错误、最大重试和 abort backoff 都有命名回归。

### OhBaby 取舍

| 做法 | 取舍 |
|---|---|
| 纯 session→model view 投影 | **Adopt concept**：Reference Model 应简单、可单独测试 |
| append-only compaction entry | **Conditional reference**：可作为 durable marker 候选，不提前迁移 |
| 真实 Bug 命名回归 | **Adopt**：每个联合回归发现应以问题形状命名，不写 `case1` |
| retry/abort 矩阵 | **Adopt**：进入 Lifecycle/summary 流式失败用例 |
| manual/auto 去重与锁释放时机 | **Adapt**：覆盖 manual+auto/manual+manual；锁在 terminal event 前释放，避免监听者续接 prompt 时被旧锁拒绝 |
| tree/branch summarization | **Reject this round**：OhBaby 当前 session 模型不同，且不属于 improve-4～5 |

关键启发：模型视图最好由一个小而纯的 projection 解释；这也是判断 OhBaby 是否应该抽取 CompactionPolicy 的测试探针。

## 3.9 对 02/04 的直接影响

| 参考结论 | 进入的方案/测试 |
|---|---|
| DeepSeek property + crash | R1 Reference Model；R3 failpoint/SIGKILL；`CMP`/`LIF` 与相关 `INV` |
| Claude cache baseline + summary PTL retry + circuit breaker | D9/CMP-13；R5 cache diagnostics；`PFX`；`INV-14` 有界压缩尝试 |
| Codex raw/normalized + deterministic repair + separate Memory | `META-07`、`MEM`、`INV-04/10/12/13`；Memory 保持只读且 root/primary only |
| Kimi replay + shrink/revalidate + interrupted tool repair | `CMP-13`、`LIF-03/04/09`、`INV-04/10/11`；observed window 仅记录 P2 |
| OpenCode production claims/timing race + rewrite 边界 | `RUN`、`REQ-06/07` 的 barrier race；不采用 summary overflow stop |
| Pi pure projection + manual/auto regressions | `CMP-09a～09c`、`META-06`、`LIF-05/08`；每个真实 Bug 独立命名测试 |

## 3.10 明确不借鉴

- 不因参考项目使用 event sourcing/replayable state 就全量重写 OhBaby。
- 不把 Claude 本地镜像的 stub 当完成能力。
- 不把 Codex/Claude 的自动长期记忆塞进本轮。
- 不复制参考项目的固定阈值；只借鉴“预算/安全余量”的决策方式。
- 不复制框架、语言或目录形式；只借鉴与 OhBaby 当前风险有因果关系的机制。
