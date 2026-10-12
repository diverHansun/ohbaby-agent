# 第 5 批入口贯通与旧机制清理

> 依据 [00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md)、[plan/02](../plan/02-optimization-plan-and-change-scope.md) §7／§9 和 [plan/04](../plan/04-test-and-acceptance.md)。本文供后续实施，验收见 [04](./04-test-and-acceptance.md)；本次不改业务代码。
> 前四批成果是本批实施的前置条件，不表示当前代码已经完成。第 3 批负责 prune 清理，第 4 批负责基本失败终止、force 一次和删除次数帽／抖动锁，本批复核并做跨入口回归。

## 2.1 方案总览

手动、自动与溢出恢复共用内部 `runCompaction` 核心，保留各自合理的触发和准入方式。手动忙时拒绝；自动与 force 在当前运行的安全边界进入，不套用手动空闲检查。随后删除 mask 及专属配置、事件、辅助函数和测试。

```text
CLI 命令 / Web RPC
  → 手动准入：空闲且没有重复压缩 → compact → compactUnlocked ─┐
  → 忙：立即返回 busy，不排队、不停止工具                   │
自动：运行内请求边界 → prepareTurnUnlocked ─────────────────┼→ runCompaction
溢出：本次恢复标志 → force prepare ─────────────────────────┘
  → 共用计划、生成、校验、事务和结果语义（第 3／4 批）
  → 自动成功：重建普通请求继续；手动成功：报告结果
  → 最终失败：自动／force 结束当前运行；手动返回失败
```

共用核心不等于强制所有入口调用公开 `compact()`。已有 mutationLane 保证串行，不能在持有 lane 的运行内路径再次调用公开方法造成重入，也不能把当前合法运行判为“会话忙”。

## 2.2 设计取舍

| 项目 | 做法 | 边界 |
| --- | --- | --- |
| 入口 | 保留 CLI 命令、Web RPC 和运行内 prepare，复用内部核心 | 不重写入站协议，不增加调度器 |
| 手动准入 | 用既有 session／scope 运行状态与独占机制，忙或重复立即拒绝 | 不仅靠按钮禁用，不用等待重试替代 busy |
| 自动／force | 在当前运行的安全请求边界进入 | 不套用手动空闲检查，不重复获取 lane |
| 失败 | 消费第 4 批结果和终止链路 | 本批不首次补 force 标志或失败终止 |
| 信号 | 开始、完成、失败的语义一致，沿用各入口已有通道 | 不为手动提示伪造 run，不新建事件框架 |
| 清理 | 删除 mask 专属实现，保留共用能力与旧数据读取 | 不按名称批量删除，不做无关 SWE 重构 |

## 2.3 实施阶段

### Stage 1：入口、准入和信号贯通

主要落点：`core/context/context-manager.ts` 的 `compact／compactUnlocked／runCompaction／prepareTurnUnlocked`；`adapters/ui-inprocess.ts` 的手动准入；`adapters/ui-runtime/composition.ts` 的 `compactSession`；lifecycle、run-stream-adapter 及命令／RPC 结果消费。

- 手动仅空闲执行。后端准入与取得独占资格必须衔接，防止“检查时空闲、获取时已有 run”仍执行；复用既有机制，不另建维护队列。
- 压缩中拒绝重复手动请求，不通过再次 compact 暗停当前任务。中断走现有暂停／停止能力。
- 自动成功继续原任务；手动成功只报告结果，不额外启动普通请求。内部失败结果不跨 automatic／overflow／force 再取摘要额度。
- 一次压缩 attempt 只有一个终态，scope 正确。自动用 run 流；CLI 手动用 `command.started／result.delivered／failed`，Web 用请求 busy 和返回结果。CLI 的业务 `result.status=failed` 也可能随 completed action 返回，展示不能只看命令 action 是否完成。
- 手动 `compactSessionInternal` 已用 usageAfter 更新缓存并发布 `context.window.updated`，复用它刷新占用；Web 弹窗完成后重新读取当前占用。两条手动通路接入第 4 批完成提示，不强塞 run 流。领域 bus 事件与 UI 通道各司其职。

完成条件：三类入口都进入同一内部核心；运行内自动与 force 不被手动 busy 规则拦住，手动忙与重复不排队；Stop、结果、scope 和占用刷新一致。

### Stage 2：删除 mask，复核前批清理

按真实引用链清理：

| 位置（相对 `packages/ohbaby-agent/src/`） | 本批动作 |
| --- | --- |
| `core/context/constants.ts`、`index.ts` | 删除 `MASK_*`、mask 阈值和再导出 |
| `core/context/projection.ts` | 删除 mask 专属类型、选择与改写函数；仍被摘要或其他有效路径使用的部分保留 |
| `core/context/context-manager.ts`、`types.ts` | 删除 maskCutoffs、maskConfig、maskEnabled 及遮罩接线 |
| `core/context/compaction-policy.ts` | 删除 mask 档及其判断；按现有新流程收敛档位，不为统一名称新增 force 档 |
| `core/context/events.ts`、`bus/event-catalog.ts` | 删除 ContextEvent.Masked、专属 schema 与登记 |
| 测试和模块文档 | 删除只证明 mask 策略的断言，保留有效的原子性、停止、scope、配对和恢复测试 |

带 50% 帽的旧 mask 比率不再有触发消费者；删除其专属计算。自动摘要继续按 `currentTokens / contextLimit`，容量继续用全量实际输出预留，不把旧帽挪给摘要。

prune／prune-only 的 SDK、CLI、Web 消费及配置应已在第 3 批清完；次数帽、抖动锁及专属原因应已在第 4 批清完。本批检查前置条件，发现残留属于前批交付缺口，不能把它改写为第五批才首次承担的任务。

完成条件：类型、导出、调用方、事件和测试对应一致；旧库可读；不误删 `time.compacted`、`commitCompaction`、工具配对和工具首次返回的分页／必要限长。

### Stage 3：跨入口回归与收尾

按 [04](./04-test-and-acceptance.md) 覆盖：

- 第 3 批 90% 默认线与必要提前容量保护，在运行内普通路径和相关 scope 中真正生效。
- 第 4 批最终失败／无收益终止，force 标志调用前置位、失败不回滚、同一步快照变化不重置、新 model step／新运行才重置；成功后重发无恢复钩子，二次 overflow 终止。
- 同一 run 在占用增长时连续至少三次成功压缩；无增长不重复压，窗口或输出预留改变后重新检查容量；手动和 force 不受地板限制。
- 手动／自动／force 下模式 A／B、Stop、提交冲突、新输入、数据库重开和摘要记录归属保持正确，所有实际摘要请求仍共享每次压缩的两次预算。
- CLI 与 Web 的进行中、成功、失败和占用刷新；手动成功不触发额外普通请求或工具副作用。

可控失败用离线故障注入，实网只做本批相关的有界探测。凭据在进程内加载，使用独立数据目录、端口和会话，不影响用户现有服务。本次文档任务不执行这些测试。

## 2.4 接口、迁移与兼容

保留现有 `compactSession` 的入口职责与第 3／4 批结果契约；已删除的 prune 字段不复活。对内复用 `runCompaction`，不要求公开入口完全合一。

本批没有数据库 schema 迁移。旧摘要、原文、modelRequests 和退场标记继续可读。回退应保留已提交事实，不把所有退场历史塞回窗口，也不重发模型请求来撤销；不能只恢复旧判断就宣称语义完全兼容。

实施后同步 `docs/core/context/goals-duty.md`、`dfd-interface.md`、`test.md` 与 `docs/bus/event-catalog.md` 的旧机制描述。Context 模块记录入口是 `docs/core/context/improve-7/`，其编号与本议题五批编号不同。plan 文件不在本轮修订范围。

## 2.5 风险与验收重点

| 风险 | 验证方式 |
| --- | --- |
| 所有入口硬塞公开 compact，导致 busy 误拒或 lane 重入 | G1 同时验证手动与活跃运行内自动／force |
| 手动准入竞态、忙时又变成等待 | G2 并发请求，断言立即 busy、无排队、无工具停止 |
| 只验上层调用次数，漏掉 SDK 或跨入口重试 | 复用第 3 批 HTTP 次数验证，G6／G7 检查终止 |
| 手动无 run 导致提示或刷新缺失 | G3／G9 分别覆盖 CLI 命令、Web RPC 与自动 run 流 |
| 删除整个文件误伤共用能力 | 类型与引用链核对，旧库重开及原子测试 |

## 2.6 范围与发布边界

第五批负责入口贯通、手动 busy／重复保护、全入口回归与 mask 清理。第三批的 prune 删除、第四批的基本失败终止／force 一次／Stop 保护和提示刷新都是前置交付，不能推迟到本批。

不做服务端 compact、历史召回、缓存预热、Shell 执行改造、大规模 UI 重设计或溢出学习窗口，不新建永久锁、版本服务或临时双实现。第三至第五批共同完成策略切换；文档完成不代表已实施或已具备发布条件。
