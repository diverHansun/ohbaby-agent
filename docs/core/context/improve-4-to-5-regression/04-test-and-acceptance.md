# 4. 测试与验收标准

> 本文是 improve-4～5 联合回归的验收契约。
> 测试围绕真实风险与状态不变量，不以覆盖率百分比、测试数量或 E2E 截图代替正确性证明。

## 4.1 测试回答的核心问题

联合回归必须回答七个问题：

1. **请求是真的吗？** 测量、压缩判断、Provider 发送和 cache 观测是否针对同一份 `PreparedModelRequest`。
2. **历史合法吗？** mask/prune/summary/abort/restart 后，模型可见 history 是否唯一且 tool pairing 合法。
3. **状态隔离吗？** primary、shared child session 中多个 subagent scope、不同 session 是否互不污染。
4. **失败能恢复吗？** 任意承重写入点失败或进程被杀后，重新打开存储能否得到确定终态。
5. **设计可继续维护吗？** 测试是否暴露稳定边界，而不是依靠深 mock、sleep 和私有实现断言维持假绿。
6. **压缩能自救吗？** 原请求和 summary 请求都超过 Provider 实际窗口时，是否能有界缩小且保持 turn/tool pairing。
7. **观测能归属吗？** 所有 Context 事件是否属于正确 session/scope，compaction 事件是否另属正确 attempt，且重放不会重新发事件或偷偷调用 LLM。

## 4.2 测试层次与职责

沿用仓库现有 unit/contract/integration/smoke 分类，不另造一套测试体系。

| 层 | 本轮典型对象 | 替换边界 | 目标 |
|---|---|---|---|
| unit | Reference Model、projection、threshold、usage、state-machine | fake clock/token counter/typed dependencies | 快速验证纯逻辑与不变量 |
| contract | `PreparedModelRequest`、TokenUsage、PromptCache wire、Message atomic/idempotent port | 接口下业务使用 fake | 防止消费者可见语义漂移 |
| integration | Context + MessageStore + Lifecycle + ToolScheduler + MCP + RunManager | 只替换真实 Provider/不可控网络 | 验证真实状态协作、并发、重建 |
| smoke | build、serve、compiled Web、真实 Provider capability | 尽量真实；凭据 opt-in | 验证发布产物和环境可用 |

补充执行层：

- **property/model-based** 属于 unit 或 integration，不是第五种基础分类。
- **fault/restart** 主要属于 integration。
- **soak** 是扩大 action 数量的 integration/nightly 运行方式。
- **summary semantic eval** 是 nightly/release evaluation gate，不混入普通 unit。

## 4.3 测试质量规则

### 4.3.1 必须做到

- 测行为与最终模型视图，不断言私有 helper 的调用次数。
- fake 必须实现真实 typed port；不可用万能 mock 掩盖接口缺字段。
- 时间、随机、并发先后和 Provider stream 都可控制。
- 并发测试使用 barrier/latch；禁止以随机 `sleep()` 制造竞态。
- 每个属性失败输出：seed、shrunk action trace、session/scope、expected/actual canonical model view diff。
- restart 测试必须销毁 manager/store/cache 实例，再从 durable store 重新构造。
- external test 无凭据可 skip；普通 unit/contract/integration 不得因环境方便而 skip。
- Prepared request equality 比较 Provider 实际输入中的 messages、tools/content blocks 及顺序；cache fields 由独立 capability/policy 契约校验，不要求它们出现在 `PreparedModelRequest`；不把无关对象 property serialization 当 cache 必要条件。

### 4.3.2 禁止假绿

- 只断言“不抛错”或 `toBeTruthy()`。
- 用预置 `usageAfter` 替代真实下一次 `prepareTurn()` 重测。
- 在同一内存对象里模拟“重启”。
- 给 production 类增加 test-only getter/failpoint；故障装饰器应位于测试 adapter/port 边界。
- 自动 retry flaky 测试后报绿。
- 把 real-provider skip 计作真实 Provider pass。
- 只测 primary 后宣称 subagent 已覆盖。
- 只验证 cache key 字符串，忽略真实 Provider-relevant prefix 是否改变。

## 4.4 Reference Model

### 4.4.1 核心动作集合

第一批 generator 只产生 Context durable truth 最承重的领域合法动作：

| Action | 说明 |
|---|---|
| `startUserTurn` | 创建 primary/subagent initiating user message，开始新 run |
| `appendAssistantDelta` | 追加部分/完整 assistant 文本或 reasoning |
| `appendToolCall` | 追加有稳定 call id 的工具意图 |
| `appendToolResult` | 完成、失败或 interrupted result |
| `prepareStep` | 用当前 ordered tools 创建 `PreparedModelRequest` |
| `observeUsage` | 注入 Provider usage/cache observation 并更新 calibration |
| `autoCompact` | 按阈值执行 mask/prune/summary |
| `manualCompact` | 强制执行用户触发 compact |
| `providerOverflow` | Provider 报 context overflow，触发 force prepare/retry |
| `abortRun` | 在 prepare、stream、tool、summary 或 backoff 中断 |
| `restartManager` | 保留 durable store，重建 process-local state |

非法动作由 generator 前置条件排除，例如没有 pending tool call 时不生成对应 result；专门的 malformed/recovery tests 负责非法 durable 输入。

### 4.4.2 扩展动作集合

以下动作复用同一 Reference Model identity/canonical view assertion，但在 R2/R5 的专门 property/integration suite 接入，不作为首个 generator 的“全绿”条件：

| Action | 归属 |
|---|---|
| `lazyLoadMcpTool` / `changePermission` | R2 tool epoch、immutable request、permission boundary |
| `spawnChildScope` / `disposeScope` | R2 primary/sibling child scope lifecycle |
| `switchSession` | R2 多 session/scope 调度与事件归属 |
| `editMemoryFile` | R5 run snapshot 与下一 run 刷新 |

验收报告必须分别写“核心动作集”和“扩展动作集”的覆盖状态，禁止核心 generator 全绿就声称全部动作已建模。

### 4.4.3 Reference Model 只保留最小知识

Reference Model 不复制 TokenCounter、LLM summary prompt 或 cut-point 算法。它只维护：

- 每个 session/scope 的 durable entries 与 active/compacted 标志；
- pending tool call ids；
- run snapshot identity；
- tool epoch 和 ordered tool ids/hash；
- compaction attempt phase；
- expected cache scope key identity；
- deterministic repair identity：由 durable call id/status/schema version 推导，不保存随机/当前时间。

真正的 summary 文本由固定 scripted summarizer 返回；Reference Model 只判断“summary 与被替代原文是否唯一活跃”。这样能避免测试把生产算法复制一份后一起写错。

## 4.5 全局不变量

以下不变量适用于每个动作之后，而不只适用于最终状态。

| ID | 不变量 | 失败含义 | 优先级 |
|---|---|---|---|
| INV-01 | `onRequestMeasured` 捕获的最后 request 与 Provider 实际输入的 `{ messages, tools }` 投影深等价 | 测量/发送旁路重现 | P0 |
| INV-02 | 返回的 `PreparedModelRequest` 不被后续 MCP load、permission change、retry 或调用方 mutation 改写 | snapshot 不稳定 | P0 |
| INV-03 | `inputTokens` 为 inclusive occupancy；cache breakdown 可选但有值时求和等于 input | 窗口/命中率语义错误 | P0 |
| INV-04 | 模型可见 tool call 都有且只有一个合法 result，或显式 interrupted/unknown repair；repair 的 ID/文本/status 是 durable call identity/status/schema version 的确定性函数，真实 result 优先 | Provider 请求非法、副作用被误判或 replay/prefix 抖动 | P0 |
| INV-05 | 同一 initiating user message 的 `model-context:runtime:v1` 基数不超过 1 | runtime 重复/缓存破坏 | P0 |
| INV-06 | 成功提交 summary 后，被替代原文与 summary 不会同时 active；失败时不能声称完成 | durable truth 歧义 | P0 |
| INV-07 | 在相同 model、tools、tailDirectives、reasoning projection 下，`status=compacted` 后**下一次真实 `prepareTurn()` request** usage 必须低于触发前 `usageBefore`；否则只能是 pruned/inflated/failed/skipped | 使用不同投影自证压缩成功，状态撒谎 | P0 |
| INV-08 | scope A 的动作不改变 scope B 的 history、calibration、mask、thrash、tool epoch、cache key | subagent 隔离失败 | P0 |
| INV-09 | `disposeScope(A)` 幂等且不改变兄弟 B；`disposeSession` 才能清理全部 scope | cleanup 越界/泄漏 | P0 |
| INV-10 | 从同一 durable store 重建后，模型可见 view 与 deterministic repair 等价；只允许明确列出的 ephemeral 数值重置；resume 不调用 LLM、不重写 store | 恢复不确定或偷偷重新生成事实 | P0 |
| INV-11 | 所有 Context event 属于正确 session/scope；compaction progress/terminal 另属于同一 attempt；每次 accepted attempt 恰有一个 terminal outcome；replay 不重发历史 observable event | UI/运行状态串线、重复或悬挂 | P1 |
| INV-12 | 同一 run 的 system/memory snapshot 稳定；文件变化只进入下一 run；subagent 不自动加载 Memory | 长期/工作记忆混层 | P1 |
| INV-13 | 同 session/scope/tool epoch 的稳定前缀相同；deterministic repair 重建不改变 prefix；有意 epoch 变化只影响下一 request 并随后稳定 | cache prefix 抖动 | P1 |
| INV-14 | 自动压缩尝试受 per-turn cap/thrash lock 约束；错误/零收益不会形成热循环 | 成本与可用性风险 | P1 |
| INV-15 | summary/title/export 不包含 runtime metadata、secret 或 UI-only 文本 | 隐私/缓存/语义污染 | P0 |
| INV-16 | prefix-only append 不修改之前已经持久化/准备的 message objects | 历史可变/快照污染 | P1 |

## 4.6 P0 重点测试矩阵

### 4.6.1 Request 单一真相源

| ID | 场景 | 类型 | 断言 | 现状 |
|---|---|---|---|---|
| REQ-01 | 普通 primary step | unit + integration | measured request = sent request 的 `{ messages, tools }` 投影；内容与顺序相同 | 已有强覆盖，联合保留 |
| REQ-02 | 普通 subagent step | integration | 与 REQ-01 相同且带正确 scope | 部分已有，需联合链 |
| REQ-03 | max-steps finalization | unit | directive 只出现一次、计量并发送；tools 为 `[]` | 已有，保留回归 |
| REQ-04 | overflow → force prepare → retry | unit + integration | retry 发送新的 force-prepared request；旧 request 不变 | 已有局部，需工具/MCP组合 |
| REQ-05 | active reasoning + tool loop | property/integration | reasoning 投影进入下一 step，不改变已发送 prefix | 需新增组合 |
| REQ-06 | prepare 后 lazy MCP load | barrier integration | 当前 request 不变；下一 request 新 epoch 含新工具 | 需新增 |
| REQ-07 | prepare 后 permission change | barrier integration | 当前已授权快照不被原地修改；下一 request 反映变化 | 需新增 |
| REQ-08 | 调用方尝试修改 request | contract | deep freeze/readonly 语义不被破坏 | 部分已有，补明确契约 |

验收重点：任何 REQ 用例都必须捕获 Provider adapter 最终输入，不能只断言 `prepareTurn()` 返回值。

### 4.6.2 压缩、部分失败与恢复

| ID | 故障点/场景 | 类型 | 重建后必须满足 | 对应风险 |
|---|---|---|---|---|
| CMP-01 | summary generation 非 overflow 失败 | unit + event contract | 无 summary、原文 active、attempt terminal=failed 且 scope 正确 | PR-01/PR-06/PR-11 |
| CMP-02 | summary inflation 两次 | unit | 不提交 summary；thrash/attempt 有界 | PR-06 |
| CMP-03 | summary message create 后失败 | fault integration | 不存在 active 空 summary 或双可见 | PR-01 |
| CMP-04 | summary part append 后失败 | fault integration | summary/原文只有一种合法 active 组合 | PR-01 |
| CMP-05 | 第 N 个旧 part update 后失败 | fault + property | 任意 N 重建都不产生部分完成歧义 | PR-01 |
| CMP-06 | prune 第 N 个 part update 后失败 | fault + property | tool pairing 合法；结果不谎报完整 prune | PR-01 |
| CMP-07 | durable commit 后、event 前失败 | fault integration | 重建以 store 为事实源识别已提交；不得回滚历史，resume 不补发旧 observable event | PR-01/PR-11 |
| CMP-08 | summary stream abort | integration | attempt terminal=aborted/failed；下一 turn 可继续 | PR-01/PR-06 |
| CMP-09a | 同 scope auto + auto | barrier integration | 至多一个 stale snapshot 提交；另一个等待/跳过/基于新 revision 重算 | PR-01/PR-09 |
| CMP-09b | 同 scope manual + auto | barrier integration | manual/auto 不重复提交；terminal event 各自可解释；无 threshold 路径叠加 | PR-09 |
| CMP-09c | 同 scope manual + manual | barrier integration | 明确排队/拒绝/合并契约，最终只有合法提交；无永久 busy | PR-09 |
| CMP-10 | primary 与 child 同时 compact | integration | 独立成功/失败；无跨 scope mutation | PR-01/INV-08 |
| CMP-11 | repeated compaction | property/soak | 上一 summary 不被重复展开；模型视图仍唯一 | PR-01/INV-10 |
| CMP-12 | hard SIGKILL at durable boundary | subprocess integration | 父进程等待 marker 精确内容后 kill；重启 view 合法；若有 marker，current lifecycle=busy、prior lifecycle=stale/orphan 并可恢复 | PR-01 |
| CMP-13 | summary request 自身 context overflow | unit + integration + real capability | 每次按完整 turn/API round 严格缩小并清前导 tool result；保留近期边界；有 max/abort；成功或明确 terminal failure | PR-10 |

CMP-03～CMP-07、CMP-09a～09c、CMP-12、CMP-13 是本轮最重要的新测试；没有这些，不能声称验证了 Context 鲁棒性。

### 4.6.3 runtime injection 与恢复

| ID | 场景 | 类型 | 断言 |
|---|---|---|---|
| RUN-01 | 同一 manager 顺序重复 snapshot | unit | runtime part 只有一份；现有回归保留 |
| RUN-02 | 同一 manager、同一 message 并发 snapshot | barrier unit/integration | runtime part 只有一份 |
| RUN-03 | 两个 manager、同一 store/message 并发 | database integration | durable 唯一性跨实例成立 |
| RUN-04 | snapshot 后重启/resume | integration | 不移动、不重写 runtime part |
| RUN-05 | initiating message 不在请求 scope | unit | 明确失败且不向别的 scope 附着 |
| RUN-06 | summary/title/export/UI projection | contract | runtime part 模型可见但 UI/summary/title/export 隐藏 |
| RUN-07 | primary/subagent 同时创建各自 snapshot | integration | system/memory/runtime 不串；subagent 无 memory |
| RUN-08 | 同一 run 中 directory/system/memory 文件变化 | unit/integration | 当前 run 不变，下一 initiating turn 才接纳 |

若 RUN-02/03 红，修复必须落在 durable 幂等边界；禁止只加 `Set<messageId>`。

### 4.6.4 Scope 隔离

| ID | 场景 | 类型 | 断言 |
|---|---|---|---|
| SCP-01 | shared child session 两个 scope 交错 history | property/integration | list/prepare 只看到自己的 history |
| SCP-02 | A 超阈值、B 低于阈值 | integration | 只压 A；B parts/time/usage 不变 |
| SCP-03 | A calibration 极高、B 未观测 | property | B factor 仍 1.0 |
| SCP-04 | A mask cutoff 前移 | property | B projection 不变 |
| SCP-05 | A thrash locked | property | B 仍可按自身状态 compact |
| SCP-06 | A lazy loads MCP tool | integration | B tool set/epoch/order 不变 |
| SCP-07 | A cache hit/miss | contract/integration | cache key/diagnostic 不污染 B |
| SCP-08 | dispose A 两次 | integration | 幂等，B Context/MCP/tool sequence/sandbox 不变 |
| SCP-09 | public static window 查询 child session | contract | 返回 unavailable/null，不聚合兄弟 scope伪精度 |
| SCP-10 | primary 与 child overflow/abort 同时发生 | integration | retry/progress/terminal event 分别归属正确身份 |
| SCP-11 | primary 与 sibling child 发布同类 ContextEvent | contract/integration | primary 缺省 scope 归一为 primary，child 带精确 scope；compaction 带 attempt identity；不得只按 session 聚合 |

### 4.6.5 Context event 身份与终态

| ID | 场景 | 类型 | 断言 |
|---|---|---|---|
| OBS-01 | primary/child 的 window、cache、prepare event | contract | `sessionId` 必填；primary 缺省 scope 只表示 primary，child 带精确 `contextScopeId`；消费者不得把缺省当全 scope 聚合 |
| OBS-02 | summary success/failed/inflated/skipped/abort | table-driven unit/contract | 每个 accepted attempt 的 progress/terminal 共用一个 `attemptId`；terminal 恰好一次且 outcome 属于固定枚举；success 另带 rung/result |
| OBS-03 | primary 与两个 sibling child 的 attempt 交错 | barrier integration | 三条 event stream 可按 session/scope/attempt 无歧义分组；一个 attempt 失败不终止或覆盖另一个 |
| OBS-04 | durable commit 后 publish/subscriber 抛错 | fault integration | durable model view 保持已提交；错误可观测但不得生成第二 terminal 或回滚 store |
| OBS-05 | reopen/resume 已提交、失败或 orphan 状态 | restart integration | 历史 observable event 数为 0；恢复不调用 LLM；新 attempt 使用新 identity，不冒充旧 attempt continuation |

## 4.7 P1 可靠性与设计测试矩阵

### 4.7.1 阈值、投影和 TokenUsage

| ID | 场景 | 类型 | 断言 |
|---|---|---|---|
| BUD-01 | `current/inputBudget = 0.95` | unit | ratio 条件触发 summary rung |
| BUD-02 | ratio < 0.95、remaining = 4096 与 4095 | unit | 当前严格 `< minRemainingInputTokens`：4096 仅靠 floor 不触发，4095 触发 |
| BUD-03 | context window 大、input budget 小 | unit | 分母使用 input budget |
| BUD-04 | 只有 cacheRead 增长 | contract/unit | `currentTokens/inputTokens` 同步增长，不把 hit 当空闲空间 |
| BUD-05 | cache 0 observed vs unavailable | contract | `observed` 区分明确 0 与缺字段 |
| BUD-06 | Provider 报分项不一致/负数/NaN | contract | 安全归一化或拒绝，不产生负 occupancy |
| BUD-07 | repeated real usage calibration | property | factor scoped、clamped、EMA；重启回 1.0 符合契约 |
| BUD-08 | manual vs automatic same input | metamorphic unit/integration | intended-equivalent model view/usage 一致 |

### 4.7.2 Tool/MCP 与稳定 prefix/cache

| ID | 场景 | 类型 | 断言 |
|---|---|---|---|
| PFX-01 | 同 tool set 同 epoch 连续 steps | contract | ordered tool projection deep stable |
| PFX-02 | registry 遍历顺序变化但语义集合相同 | unit/contract | canonical order 不抖动 |
| PFX-03 | 新 MCP schema 首次加入 | integration | epoch 只增一次；当前 request 不变、下一 request 变化 |
| PFX-04 | MCP disconnect/reconnect | integration | 明确 epoch transition，随后重新稳定 |
| PFX-05 | permission removing tool | integration | 过期 tool 不再可执行；不能为 cache 保留 |
| PFX-06 | primary/subagent 同名工具不同 scope | contract | prefix/key/diagnostic 按 scope 隔离 |
| PFX-07 | compaction 合法缩短 history | unit/real provider | cache baseline reset，不误报 break |
| PFX-08 | system/runtime/tool 真变化 | contract | diagnostic 指出变化来源，不只报 hit rate 降低 |
| PFX-09 | stable system + initiating runtime | contract | runtime 不在每 step 尾部重复注入 |
| PFX-10 | cache key | unit/contract | key 基于 sessionId+contextScope；tool epoch 不写入 key |
| PFX-11 | manager restart 新 tool epoch | integration/real provider | 首次 miss 允许，之后稳定；不虚构恢复 hit |
| PFX-12 | 同一 unfinished tool durable state 重建 | unit/integration | synthetic repair id/text/status 字节稳定；真实 result 覆盖 synthetic；稳定 prefix 不因时间/随机变化 |

### 4.7.3 Memory 与 run snapshot

| ID | 场景 | 类型 | 断言 |
|---|---|---|---|
| MEM-01 | global + nearest project OHBABY.md | integration | 合并顺序、来源标记正确 |
| MEM-02 | project file 向上查找 | integration | 不越过 project root/path boundary |
| MEM-03 | 文件缺失/读取失败 | unit/integration | 安全降级为空并 warning，不中断请求 |
| MEM-04 | 恶意 prompt 内容 | serializer integration | security scan 生效，不突破 system 边界 |
| MEM-05 | run 中途编辑文件 | integration | 当前 snapshot 不变，下一 run 刷新 |
| MEM-06 | subagent | integration | 不调用 loader、不注入 Memory |
| MEM-07 | repeated compaction | property | summary 不把 runtime metadata/secret 当长期记忆 |
| MEM-08 | ghost memory tools | contract/rg | 不恢复 `memory_list/read/add/update/remove` 可执行契约 |

### 4.7.4 Lifecycle 中断、重试与工具修复

| ID | 场景 | 类型 | 断言 |
|---|---|---|---|
| LIF-01 | abort during prepare | unit/integration | 不发送 Provider 请求；状态可再次启动 |
| LIF-02 | abort during assistant stream | integration | partial 内容按既有契约持久化；无重复 final |
| LIF-03 | abort running tool | integration | partial output + interrupted/abort notice；tool pairing 合法 |
| LIF-04 | process dies after tool intent before result | crash integration | 重建补 deterministic interrupted/unknown，不假定副作用成功；真实 result 存在时覆盖 synthetic |
| LIF-05 | transient summary/provider stream failure | unit/integration | 只重试可重试错误；有 max/abort |
| LIF-06 | non-overflow provider failure | unit | 不进入 force compaction retry |
| LIF-07 | overflow retry also overflows | unit/integration | 明确 terminal failure，不无限循环 |
| LIF-08 | prompt submitted during manual compact | integration | prompt 可先被 UI scheduler 接受，但同 scope 的 Context durable mutation 必须排在 compact terminal 之后；不同 scope 可继续；auto compact 复用 owner 不发生嵌套死锁 |
| LIF-09 | reopen/resume with summary/tool/compaction durable state | integration | `failOnResumeGenerate` 保证 LLM 调用为 0；store 无新增 repair 写（除非协议显式要求）；observable replay event 为 0 |

LIF-08 的推荐契约是“接纳与执行分离”：保留现有 prompt scheduler 的快速接纳；logical compaction 从 snapshot 到 terminal 持有 per-scope lease，prompt 的 Context 写入随后执行。auto compact 在 prompt owner 内复用/转交 owner token，不能嵌套死锁；revision recheck 再防御多 manager 或漏接入口。代码交叉核验表明，当前 `compactSessionInternal()` 直接进入 `runtime.compactSession()`，没有经过 `waitForPromptSlot()`，`ContextManager` 也没有 session/scope lock；因此当前并发行为是已识别缺口，而不是可依赖的规范。

## 4.8 变形测试（Metamorphic Tests）

变形测试不需要知道完整期望文本，只验证改变一个因素后哪些东西必须/不得变化。

| ID | 变换 | 必须保持 | 允许变化 |
|---|---|---|---|
| META-01 | 在 history 末尾 append 新 turn | 原有 durable prefix objects/ids/time | 新 suffix、usage |
| META-02 | 只改变 Provider cache stats | model request、occupancy input 口径 | cache breakdown/hit rate |
| META-03 | tool registry 返回顺序打乱 | canonical tool order/request prefix | 无 |
| META-04 | tool epoch 有意增加一次 | 旧 PreparedModelRequest | 下一 request 与 cache observation |
| META-05 | dispose scope A | scope B 全部状态 | A 不可再观察的 transient state |
| META-06 | 同 history 同 tools 手工/自动 compact | 最终 model view、真实 usage 量纲 | progress event、force reason |
| META-07 | 重建 manager | durable model view、deterministic repair、稳定 prefix | calibration/mask/thrash 等明确 ephemeral state |
| META-08 | OHBABY.md run 中变化 | 当前 run request | 下一 run snapshot |

## 4.9 Summary 语义评测

### 4.9.1 固定语料

至少包含：

- 多文件读写、重命名和失败的 edit；
- 用户明确目标、禁止项、分批计划和未决选择；
- 长 tool output 与已裁剪 output；
- primary/subagent 不同任务；
- 一次 Provider overflow 和重试；
- runtime environment 中含 cwd/date/tool catalog，但这些不应进入 summary；
- 人工插入的 secret canary，任何 summary/export 中都不得出现。

### 4.9.2 评测维度

| ID | 维度 | 硬规则/评分 |
|---|---|---|
| EVAL-01 | overall goal | 必须保留关键目标 |
| EVAL-02 | constraints/decisions | 必须保留明确禁止项和已定选择 |
| EVAL-03 | file state | 关键 read/modified/deleted/moved 不误报 |
| EVAL-04 | unresolved work/errors | 未解决错误不能被写成已完成 |
| EVAL-05 | recency | 保留必要近期动作，不被旧噪声淹没 |
| EVAL-06 | privacy/runtime filtering | secret canary、Date/cwd/Available tools/runtime metadata 不出现 |
| EVAL-07 | compression utility | summary 明显短于被替代内容，且下一任务可继续 |

规则断言失败直接失败；LLM-as-judge 分数用于趋势和 release 审查，必须记录 model/prompt/version，并经过人工样本校准。

## 4.10 测试 fixture 与可观测输出

建议测试支撑件：

| Fixture | 职责 |
|---|---|
| deterministic TokenCounter | 让预算边界和 cut-point 可精确构造 |
| scripted ContextLLMClient | 返回 compact/failed/inflated/stream-abort 等确定脚本 |
| request-capturing Provider | 捕获 adapter 最终 input，比较 measured/sent |
| failpoint Message adapter | 在 create/append/第 N 次 update/durable commit 后失败 |
| store conformance suite | 同一组 atomic/idempotent/reopen 契约跑 in-memory 与 database store |
| barrier/latch | 控制 snapshot、MCP load、compact、tool execution 的竞态 |
| content-gated crash marker | marker 预创建为空；父进程等待 `request-dispatched`/`commit-entered` 等精确内容后 SIGKILL |
| fail-on-resume ContextLLMClient | resume/replay 期间一旦调用 LLM 立即失败，证明恢复只依赖 durable truth |
| fake clock | 验证 compactedAt、事件顺序、lease/backoff，不用 sleep |
| canonical model-view serializer | 输出稳定、可 diff 的 messages/tools/active parts |
| secret-free eval corpus | 固定 summary 语义样本，不含真实用户 secret |

失败报告示例应包含：

```text
seed=184467
step=17 action=autoCompact(session=child_1, scope=subagent_b)
failpoint=after-summary-part
invariant=INV-06
expected_active=[summary_1,user_9,assistant_10]
actual_active=[user_1,assistant_2,summary_1,user_9,assistant_10]
```

## 4.11 CI 与执行策略

### 4.11.1 现有命令

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run test:smoke
pnpm run build
```

### 4.11.2 建议新增便捷入口

```text
test:context:regression  → 固定的 Context unit/contract/integration 核心集合
test:context:property    → 固定 seed + PR 预算的属性测试
test:context:restart     → failpoint/reopen/subprocess crash integration
test:context:soak        → nightly 多 seed 长序列
test:context:eval        → nightly/release summary semantic eval
```

这些脚本不存在时不得在验收记录中假装已运行；实施批次创建后再作为正式命令。

### 4.11.3 分层门禁

| 阶段 | 必跑 | 目标时间/性质 | 失败处理 |
|---|---|---|---|
| 本地红绿循环 | targeted unit/contract/property smallest trace | 秒级 | 修复后继续 |
| 每批 commit 前 | format/lint/typecheck + unit + contract + 本批 targeted integration | 分钟级 | 阻断 commit |
| PR/批次审查 | 全 unit/contract/integration + build + fixed property seeds + restart suite | 可重复、无外网 | 阻断合入/下一批 |
| nightly | 多 seed soak + hard crash + summary eval | 较慢 | 记录 seed；修复或 quarantine，禁止 retry 假绿 |
| release/manual | real cache OpenAI-compatible/Anthropic/M13 + compiled Web | 真实外部环境 | 阻断发布；区分 capability/环境/产品缺陷 |

## 4.12 真实 Provider 与 compiled Web E2E

### 4.12.1 凭据与环境

- API key 只从环境变量读取，不写进 repo、fixture、命令历史、截图或日志。
- 已在对话中暴露过的 key 应轮换；测试文档不重复记录其值。
- 无凭据时 real-provider gate 可以 skip，但报告必须写 `SKIP(no credential)`，不得写 pass。
- 记录 endpoint、API family、model、测试时间与 Provider capability；不记录完整敏感 request。

### 4.12.2 OpenAI-compatible/Anthropic cache

每条真实链至少连续发送：

1. 基线请求；
2. 相同稳定前缀 + 小 suffix；
3. 同 scope 下一 step；
4. 有意 tool epoch 变化；
5. 新 epoch 再次稳定；
6. 另一个 subagent scope 对照。

验收：

- usage 能区分 observed hit/miss/unavailable；
- cache read 计入 `inputTokens`；
- 同 scope 稳定步骤有真实 hit（Provider/模型支持时）；
- epoch 改变允许 miss/write，随后恢复稳定；
- sibling scope key 不复用；
- Provider 不支持某字段时按 capability skip/unsupported，不伪造 0。

### 4.12.3 compiled Web

必须：

- 先 `pnpm build`，使用本次 `dist`；
- 从仓库外临时 workspace、隔离 `OHBABY_HOME`/数据库/平台目录启动；
- `serve --port 0 --no-open` 或等价安全方式；
- 通过 Web 主路径创建 session、提交多轮 prompt、触发工具和至少一次 context 更新；
- 检查粗略占用 UI、cache breakdown/observed、compaction progress/terminal、session scope；
- 验证 runtime metadata 不出现在 transcript；
- 子代理不显示 session-only 聚合的伪精确静态值；
- 关闭后清理临时进程和目录。

## 4.13 每批验收映射

| 02 批次 | 必须通过 |
|---|---|
| R0 | BUD-01～03；权威文档以 95% + remaining floor 为当前契约，85% 只作明确标记的历史目标；无旧接口冲突；现有 unit/contract |
| R1 | 核心 Reference Model scaffold 及其可表达的 `INV-04/06/10/13/14/16`；固定 seed property 全绿且可 replay/shrink；不冒充扩展动作已覆盖 |
| R2 | REQ-02/05～07、SCP-01～11、OBS-01～03、PFX-01～06、LIF 组合场景；CMP-09a～09c 与 LIF-08 同 scope 串行/异 scope 并发 |
| R3 | CMP-03～07、CMP-12/13、OBS-04/05、LIF-09、INV-04/06/10/11；真实 store reopen；resume 零 LLM/零 replay event |
| R4 | RUN-02/03、BUD-08、META-06；所有 request identity 回归 |
| R5 | MEM-01～08、PFX-07～11、EVAL-01～07；Provider contract 全绿 |
| R6 | nightly soak 无未解释失败；real-provider 非 skip；compiled Web 真实运行 |

## 4.14 最终发布门

联合回归只有同时满足以下条件才能标记完成：

1. P0 不变量 INV-01～10、INV-15 全部有确定性自动测试。
2. primary 与 subagent 在 request、compaction、MCP、cache、restart 场景中都有对称证据。
3. 所有 compaction failpoint 在 manager/store 重建后产生唯一合法 model view。
4. summary 请求自身 overflow 能在有界次数内严格缩小后成功，或以明确 terminal failure 结束；无无限循环、无 tool pairing 破坏。
5. 同 initiating message 的并发 runtime 注入幂等，或跨层契约证明该并发不可达。
6. 三类同 scope compact 并发、manual compact+prompt 均满足 exclusive lane + revision 复核；异 scope 仍真实并发。
7. 所有 Context event 携带正确 scope；compaction event 携带正确 attempt 且每个 accepted attempt 唯一终态；resume 零 LLM、零历史 observable replay event。
8. manual/automatic projection 的差异已被测试解释：等价，或文档明确为有意差异。
9. Context 权威文档与实际接口、状态所有权、95% + remaining floor 契约一致。
10. unit、contract、integration、lint、typecheck、build 全绿；普通 suite 无新增 skip/flaky retry。
11. nightly soak 保存 seed 且无未解释失败；summary eval 无 privacy/runtime metadata 泄漏。
12. 提供凭据时，OpenAI-compatible/Anthropic/M13 真实 cache gate 实际运行；compiled Web 使用本次构建产物完成主路径。
13. 独立审查对照 02/04，所有偏差写入实施后的 `05-implementation-acceptance.md`，不回写本规划伪造完成状态。

## 4.15 对抗性审查重点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| summary 写一半进程死亡 | 每个 durable boundary failpoint + reopen + hard crash；原子端口或 orphan recovery | OS/文件系统极端故障仍需底层 DB 保证 |
| summary 请求自身也超窗口 | turn-aware 严格收缩 + pairing normalize + max/abort + 进展断言 | Provider 错误分类错误仍可能使不可恢复错误走错分支 |
| auto/manual compact 交叉提交 | per-scope lane + commit revision 复核 + 三类 barrier 测试 | 外部未走 Context port 的新写入口需持续纳入 lane |
| 同 message 并发 runtime append | barrier + multi-manager database test；durable idempotency | 分布式多进程若超出本机存储模型需另评估 |
| child session 聚合兄弟 scope | 所有 helper/event/key 必带 scope；dispose 对称测试 | 无 scope 的历史 legacy 数据需继续安全处理 |
| replay 重发事件或偷偷摘要 | fail-on-resume LLM + observable event count=0 + durable view parity | 未来显式 repair migration 需另定义版本化副作用 |
| Provider usage/cache 字段漂移 | 表驱动 contract + real capability gate；observed/unavailable | 第三方 compatible endpoint 可能非标准，需显式 capability |
| cache 优化掩盖权限变化 | request correctness 优先；permission/tool epoch 必须改变下一 request | Provider 内部 cache 行为不可完全控制 |
| 随机 suite 假稳定/难复现 | seed + shrinking + no sleep + canonical diff | generator 分布仍需通过历史失败反馈调优 |
| Summary 看似短但丢关键信息 | 结构硬门 + corpus/eval + human calibration | judge 模型自身会漂移，不能做唯一门 |
