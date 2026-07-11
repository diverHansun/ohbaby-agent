# Goal 模式 Subagent 机制审查（讨论记录）

> 2026-07-11 实施前最终确认（覆盖下文早期讨论中的冲突结论）：用户不直接传结构化预算，也不提供 `/goal budget`；main 只把用户、system 或 developer 明确给出的自然语言限制翻译为 `SetGoalBudget(value, unit)`，支持 turns/tokens/milliseconds/seconds/minutes/hours，禁止自行发明。time 只累计 active pursuit，并在 continuation 边界判定。未声明预算时不创建产品级限制；系统仅保留始终生效、不可配置、不进入预算报告的 1000-turn 绝对安全阀。任何 main run 在向用户输出最终回答前，本轮所有 subagent executions 都必须非 running（instance 可保留）；goal complete 的顺序是 subagents 收敛、目标与验证完成、main 调 complete、main 输出最终回答。当前多路径多 daemon 部署不实现跨 daemon 远程 cancellation。

正式文档见 [README.md](./README.md) 及 01–05 编号文件。

## User

我们需要接着检查分析goal 模式下mainagent调用subagent的机制和subagent较长时间运行的机制。1.目前你在之前的对话中也提出了：1.goal模式的数据流清晰度+对抗性韧性+测试覆盖都需要完善 2.主要分析的点，可使用子代理：1.数据结构清晰？2.数据流清晰？ 3.是否基于swe原则（learn-swe skills有写）4.对抗性审查 提出你的建议和改进推荐，来和我详细讨论！

## User

goals模式的subagent优化不在本分支范围内，后续会使用新分支进行优化，我不是让把 master/subagent 正式收进 goals，goals属于任务编排层，main/subagent是执行层。我是希望检查goal目标模式（对应）长任务下，在我们优化了mainagent调用subagent的机制，subagent的context/sandbox做的更好后，goal模式这样的长任务的完成度/鲁棒性。能懂我意思吗？？

## User

1./goal停止，主代理和子代理一起停止，子但代理不close 2.   3.resume goal主要依靠用户resume goal，如果goal暂停但用户发送消息那么就可以先不按照goal的目标执行（例如处理一些琐碎问题）子代理的resume由main agent主agent自行控制 3.token预算显示仅main agent ，subagent预算不显示，我认为仍然需要计数token，不是计数一共用了多少，而是由context模块自行管理subagent实例的上下文长度，由context模块自行控制上下文（之前的实现已经优化了subagent的context和sandbox）4.什么是background subagent 是否允许跨 goal 续跑轮存活？

## Assistant

懂，而且这四点把之前「交叉面缺契约」里最需要拍板的部分都定下来了。我按你的决策逐条对齐，并专门回答 **background subagent 是什么、能不能跨 goal 续跑轮存活**。

---

## 先确认：你的分层意图

```
goal 层：任务是否继续、预算展示、用户 resume
main agent 层：是否委托、如何恢复 subagent（subagent_run / status）
context 层：subagent 实例上下文长度与 compact（与 goal token 预算分离）
执行层：interrupt / 不 close / queue 保留
```

这和「goals 不拥有 subagent 编排」完全一致；缺的是把 **goal 停 ⇒ interrupt 全家、但不 close** 写进契约并测到。

---

## 1. `/goal` 停止：主 + 子一起停，子不 close

**你的决策**：stop = **interrupt 整棵树**，subagent **保留实例**（`subagent_id`、`pendingQueue`、child context 都还在），只有显式 `subagent_close` 才 terminal。

| 停止方式 | 当前行为 | 与你的契约 |
|----------|----------|------------|
| 用户插话 / Esc | `interruptRunTree` → 主 run cancel + `interruptByParent` | ✅ 接近（interrupt，不 close） |
| `/goal pause` / `cancel` / complete / 预算 pause | 只改 `GoalStore`，**不**触达 subagent | ❌ 需未来分支补 |

**未来分支最小改动**（goals 仍不 import subagent）：

- adapter 在 goal 进入 **paused / cancelled / complete（瞬态前）** 时，调用与 Esc 同级的 **`interruptRunTree` 或等价 `interruptByParent`**。
- **禁止**在这些路径上调用 `subagent_close`。
- 写一条 ADR：`goal 可见停止 ⇒ execution interrupt；subagent 生命周期由 main agent 通过 tools 续接`。

---

## 2. Resume：用户 resume goal；暂停时用户发消息可处理琐事；subagent 由 main agent 自行恢复

**与现有 goals 设计高度一致**：

- goal `paused` → 只有 `/goal resume` 才再进 `GoalDriver` 续跑。
- 用户 paused 期间发普通消息 → 走 user prompt，**不**自动按 goal objective 干活（light note 仅提示「可 `/goal resume`」）。
- subagent 恢复 → main agent 用 `subagent_run(subagent_id=..., prompt=...)` 或 `subagent_status` 后再决定；**goal resume 不自动 drain subagent queue**。

这点我建议写进 `goals-duty` 的 **Non-Duty 补充**：「goal resume 不恢复 subagent；subagent 恢复是 execution 层、由 main agent 工具驱动。」

---

## 3. Token 预算：goal 只展示 main agent；subagent 由 context 管

澄清了之前讨论里的歧义，我认同这个拆法：

| 维度 | 归属 | 说明 |
|------|------|------|
| **Goal `tokensUsed` / UI 预算** | 仅 primary 续跑 run | `goalOutcomeFromRunCompletion` 只取 parent completion 的 token |
| **Subagent 上下文/token** | `core/context` 按 `contextScopeId` 管理 | per-step compact、overflow 压缩；与 goal 预算 **解耦** |
| **Goal token 预算语义** | 约束「编排层续跑成本」 | 不含委托出去的 subagent LLM 消耗 |

**文档化即可**，不必做 subagent→goal 的 rollup。
若以后要在 goal 提醒里写「本轮 primary 用了 X tokens」，也 **不要**混成「总消耗」。

---

## 4. 什么是 background subagent？能否跨 goal 续跑轮存活？

### 是什么

`subagent_run` 有两种 **mode**（`tools/subagent.ts`）：

| mode | 行为 | 典型用途 |
|------|------|----------|
| **foreground** | 当前 **primary turn 阻塞等待** subagent 跑完，返回 output | 小任务、需要立刻用结果 |
| **background** | **立即返回** `subagent_id`，subagent 在 `SessionSubagentHost` 后台 **drain queue** 异步跑 | 长调研、可并行、主 agent 先干别的 |

代码上（`subagent-host.ts:203-216`）：background 调 `enqueueOrSchedule` 后马上 return item，不 await turn 结束。

主 agent prompt 里也写了（`base.md:52`）：长任务用 background，再用 `subagent_status` / `subagent_close` 管理。

### 能否跨 goal **续跑轮**存活？

要分两种「跨」：

#### A. Goal 仍为 **active**，只是 GoalDriver 进入 **下一轮 continuation**

**当前：允许，且是 background 的设计目的。**

时间线示例：

```
Turn 1: main 调 subagent_run(mode=background) → 立刻拿到 id，Turn 1 succeeded
Turn 2: GoalDriver 马上开下一轮续跑（background 可能还在跑）
Turn 3: …
```

主 agent 可在 Turn 2 用 `subagent_status` 看进度，或在 Turn 3 用同一 `subagent_id` 继续喂 prompt。**这是合理且有用的**，不必禁止。

#### B. Goal 已 **pause / cancel / complete**（你定义的「/goal 停止」）

**按你的契约：不应继续跑。**

停止时应 `interruptByParent` → subagent 变 `interrupted`（或等价 paused），**queue 保留、不 close**。
Resume goal **不会**自动帮 subagent 跑 queue；main agent 之后自行 `subagent_run` 续接。

### 建议写死的规则（供未来分支 ADR）

| 状态 | background subagent |
|------|---------------------|
| goal **active**，跨 continuation turn | ✅ 允许存活 |
| goal **paused**（含用户插话、预算、Esc） | ❌ 必须 interrupt，实例保留 |
| goal **cancel / complete** | ❌ 必须 interrupt，实例保留 |
| goal **resume** 后 | subagent **不**自动恢复；main agent 用 tools 决定 |

这样既保留 background 的并行价值，又避免「goal 已停、子还在改仓库」的幽灵任务。

---

## 对你四点决策的总对齐

| # | 你的决策 | 与现状 | 未来分支动作 |
|---|----------|--------|--------------|
| 1 | 停 goal ⇒ 主+子 interrupt，子不 close | 仅 Esc/插话路径满足 | adapter 钩子 + 集成测试 |
| 2 | resume 靠用户；paused 可琐事；subagent 靠 main | 已基本满足 | 文档补 Non-Duty |
| 3 | goal 预算只显示 main；subagent token 归 context | 基本满足 | 文档声明，不做 rollup |
| 4 | background 跨 **active** 续跑轮可存活；**goal 停**则必须停 | active 跨轮：已是；goal 停：缺口 | 同上 #1 + 测「bg 跨 turn + goal pause」 |

---

## 仍建议补的测试（未来分支，3 条就够锁契约）

1. active goal：Turn1 background → Turn2 已开始 → assert bg 仍可 running
2. active goal + bg running → `/goal pause` → assert bg **interrupted**，**未** close，`pendingQueue` 仍在
3. 上例 resume goal → assert bg **不**自动 drain；main 调 `subagent_run(subagent_id)` 后可继续

---

若你认可 **「active 跨轮允许、goal 停必须 interrupt 且不 close」** 这条 background 规则，我可以下一步直接起草一页 `docs/goals/adr-goal-execution-boundary.md` 骨架（只文档、不改代码），方便你开新分支时对照实现。要的话回一句「写 ADR 骨架」即可。

## User

1.这里注意：我们为subagent/mainagent都创建了“instance”实例，但这些实例在os级别的内存中是否占用是否还是按照启动方式来的？如ohbaby启动cli in-process模式，那么退出后这些agent实例随着cli退出而释放。ohbaby serve后台有daemon的模式，退出后agent实例也会被“销毁”吧？但是重新启动服务后，subagent是否存活呢？或者说subagent instance实例是否可以被main 主agent重新唤醒呢？看看kimi-code/codex的代码:/Users/hansun025/Projects/code-cli/codex ; /Users/hansun025/Projects/code-cli/kimi-code 2.跨goal：1.Goal 仍为 active，只是 GoalDriver 进入 下一轮 continuation 存活！ 2.goal pause/complete subagent实例销毁，pause subagent只是暂停，实例不销毁。即使Resume goal 不会自动帮 subagent 跑 resume，但是mian agent自行进行subagent续跑。3.我讲的很清楚了吧，还有什么问题吗？

## Assistant

懂，而且比之前更精确了。下面按你的问题逐条对齐，最后只留 **1 个** 还需拍板的边界。

---

## 你的契约（我现在的理解）

| 场景 | goal | subagent 实例 |
|------|------|---------------|
| goal **active**，进入下一轮 continuation | 继续续跑 | **允许存活**（含 background 跨轮） |
| goal **pause** | paused | **interrupt，实例保留**（不 close） |
| goal **complete** | 清记录 | **实例销毁**（close） |
| `/goal resume` | 用户显式恢复 | **不自动续跑**；main agent 自行 `subagent_run` |
| goal paused 时用户发消息 | 可处理琐事 | 不走 goal objective |
| token 预算 UI | 仅 main agent | subagent 上下文由 context 模块独立管 |

这和「goals 编排、execution 执行」的分层一致；**pause 与 complete 对 subagent 的处理不同**，是关键修正。

---

## 1. Instance 与 OS 内存 / 进程的关系

ohbaby 里其实有 **三层**，不要混为一谈：

| 层 | 是什么 | 进程退出后 |
|----|--------|------------|
| **AgentInstance** | 单次 turn 的运行时对象（`core/agents/instance.ts`） | 随进程释放，**不持久** |
| **SubagentInstanceRecord** | 逻辑实例（`subagent_id`、status、queue、child session） | 看启动模式 |
| **SessionSubagentHost.active** | 内存调度（AbortController、drain） | 随进程释放 |

**AgentInstance ≠ OS 级常驻进程**；每次 `subagent_run` 会新建/复用逻辑 record，再 **临时** 构造 AgentInstance 跑 turn。

### 按启动方式

**CLI in-process（默认）**

- 通常用 `InMemorySubagentInstanceStore`（`composition.ts` 默认）
- 进程退出 → `dispose()` → 内存 active 清空；record **不落盘**
- **重启 CLI 后 subagent 不可唤醒**（除非走 persistent 路径）

**serve / persistent backend**

- `ui-persistent.ts` 用 `DatabaseSubagentInstanceStore` + SQLite
- 进程退出 → `host.dispose()` → 在跑中的标 `interrupted`；**record + child session 消息/context 仍在 DB**
- 文档（`docs/agents/dfd-interface.md`）：重启 **不自动 drain queue**，**不自动创建 AgentInstance**

### 重启后能否被 main agent 唤醒？

**可以，但有条件**（persistent 模式）：

1. record 仍在 DB，且 **未 close**（`closedAt` 为空）
2. status 为 `interrupted` / `timed_out` / `completed` 等（`claim` 拒绝 `running`/`cancelled`）
3. main agent 显式 `subagent_run(subagent_id=..., prompt=...)`
4. 会 **新建 AgentInstance**，从 child session + `contextScopeId` **恢复上下文**（context 模块已管）

**不会**发生的事：服务重启后 subagent 自己跑起来；那是违反当前设计的。

---

## 2. 与 kimi-code / codex 对照

| | ohbaby | kimi-code | codex |
|---|--------|-----------|-------|
| 逻辑实例 | `SubagentInstanceRecord` + child session | `metadata.agents[id]` + Agent 对象 | Thread 树 + rollout |
| 跨进程恢复 | DB record + `recoverInterrupted`；手动 `subagent_run` 续 | `ensureAgentResumed(id)` 从磁盘 metadata **自动 reload Agent** | `resume_thread` 恢复 thread 历史 |
| 显式 resume API | `subagent_run(subagent_id)` | `host.resume(agentId)` / `retry` | 通过 thread 关系续跑 |
| 轻量 side-agent | — | `persistMetadata: false`（不持久） | internal subagent |

kimi 更偏 **session 内 agent 元数据持久 + 自动 resumeAgent**；codex 偏 **thread 持久 + spawn 树**；ohbaby 偏 **instance record + 显式 tool 续接**，重启后 **不自动** 帮 subagent 跑。

你的方向（goal resume 不自动续 subagent、main agent 自行控制）与 ohbaby 现状 **一致**，future 分支主要是把 **goal pause/complete 与 subagent 命运** 接上。

---

## 3. 对你「跨 goal」规则的代码差距（future 分支）

| 你的规则 | 当前代码 |
|----------|----------|
| active 跨 continuation 存活 | ✅ background 已支持 |
| goal **pause** → sub interrupt，实例保留 | ⚠️ 用户 Esc 会；`/goal pause`/预算 pause **还不会** |
| goal **complete** → sub **销毁** | ❌ `markComplete` 只清 goal，**不** `subagent_close` |
| resume 不自动续 sub | ✅ 已符合 |

future 分支要做的，本质是在 adapter 加 **goal 生命周期钩子**：

```
goal pause/cancel(?)  → interruptRunTree / interruptByParent（不 close）
goal complete         → close 该 parent 下全部 subagent（或等价销毁）
goal active 跨轮      → 不动（保持现状）
```

---

## 4. 还有什么问题？

**只剩 1 个需要拍板：**

> **`/goal cancel` 对 subagent 算 pause（interrupt 保留实例）还是 complete（销毁实例）？**

- 若 **cancel = 放弃任务** → 倾向 **销毁**（同 complete）
- 若 **cancel = 临时放弃、可能重来** → 倾向 **interrupt 保留**（同 pause）

你定这一条后，契约就完整了，可以写 ADR，没有其它阻塞问题。

---

**简短确认**：你的 1–3 点我都清楚了；instance 在 OS 里就是进程内对象，持久性取决于 in-process vs serve+DB；重启后 subagent **可被 main agent 唤醒**（persistent 下、未 close、显式 `subagent_run`），不会自己活过来。请回 **`/goal cancel` 走 pause 还是 complete 语义**。

## User

1.等下，跨goal时goal complete → sub 销毁其实也可以不做，subagent仍保留！但是goal complete时一定是由main agent决定的complete，换言之，goal complete时，mainagent和subagent都是complete状态了 2./goal cancel对subagent算pause，倾向 interrupt 保留（同 pause），只有当main agent认为subagent较多，上下文信息也较长/混乱时可以销毁subagent实例，这个是后续system-prompt加强对工作

## Assistant

收到，这两点把契约收得更合理了——**complete 是语义收敛，不是强制销毁；cancel 是 interrupt 保留，清理交给 main agent 自觉。**

---

## 更新后的完整契约

| 触发 | goal | subagent | 谁负责 |
|------|------|----------|--------|
| goal **active**，跨 continuation 轮 | 续跑 | **允许存活**（含 background） | — |
| goal **pause**（含 Esc/插话/预算） | paused | **interrupt，实例保留** | adapter 级联 interrupt |
| **`/goal cancel`** | 清 goal 记录 | **interrupt 保留**（同 pause） | adapter 级联 interrupt |
| **goal complete** | 清 goal 记录 | **不强制销毁**；正常应已 complete | **main agent 先收敛再 `UpdateGoal(complete)`** |
| `/goal resume` | 用户恢复续跑 | **不自动续** | main agent 自行 `subagent_run` |
| subagent **销毁** | — | `subagent_close` | main agent 按需（prompt 引导） |

---

## 1. goal complete：语义约束，不是 hook 销毁

你的意思是：

> complete 是 main agent 审完后的宣告；宣告时 main 和 sub 都应是 **complete 状态**，而不是 goal 层去 `subagent_close` 全家。

这更干净：

- **goals 层**：只负责 `markComplete` + 清 goal 记录，**不**加「complete ⇒ close all subagents」
- **execution 层**：subagent 实例、child context 可继续留在 session 里
- **prompt 层**（后续）：教 main agent——declare complete 前先 `subagent_status`，unfinished 的先收尾或 close

**future 分支不必做** complete→destroy；**要做的是** system-prompt + 可选集成测试验证「complete 前 subagent 已收敛」的行为模式。

---

## 2. `/goal cancel` = pause 语义

| | pause | cancel |
|---|-------|--------|
| goal 记录 | 保留，可 resume | **丢弃** |
| subagent | interrupt，保留实例 | **同样 interrupt，保留实例** |

区别只在 **goal 是否还能 `/goal resume`**；subagent 侧行为一致。

**future 分支 adapter 工作**：pause 和 cancel 都走 `interruptRunTree` / `interruptByParent`，**都不** `subagent_close`。

---

## 3. subagent 销毁：main agent 自觉，不靠 goal 层

> 只有 main agent 认为 subagent 太多、上下文又长又乱时，才 `subagent_close`——靠后续 system-prompt 加强。

分层正确：

- **goal 层**：不拥有 subagent 生命周期终态（除 interrupt 级联）
- **prompt 层**：教何时 status / close / 并行上限
- **context 层**：管各 instance 上下文长度与 compact

---

## 对 future 分支工作的收窄

之前讨论的「goal complete ⇒ close subagents」**取消**。

**仍要做：**

1. goal **pause / cancel / 预算 pause** → interrupt 主 + 子（不 close）
2. goal **complete** → 仅清 goal；**不**自动动 subagent
3. 联合测试：pause/cancel + 在跑 subagent → interrupted + queue 保留 + 未 close
4. system-prompt（后续）：complete 前收敛 subagent；上下文乱时主动 close

**不必做：**

- complete / cancel 时批量 `subagent_close`
- goal token 预算 rollup subagent

---

## 与 kimi/codex 的对齐点

- **kimi**：complete 也是 agent 层自审，host 不强制销毁 sibling agents
- **codex**：thread complete 不自动删 spawn 树；子 thread 可独立存在

ohbaby 这条「complete 是 main 宣告、实例可保留、清理靠 prompt」与两者精神一致。

---

## 当前是否还有未决问题？

**没有了。** 契约已闭合：

- 编排层：goal 停 ⇒ interrupt 全家；complete 只清 goal
- 执行层：实例 persistent 模式下可跨重启由 main 唤醒
- prompt 层：complete 前收敛、按需 close（后续）

你确认后，我可以起草 `docs/goals/adr-goal-execution-boundary.md` 骨架（只文档），把上述表格和分层写进去，供开新分支对照。要的话回「写 ADR」。
