# 第 5 批：测试与验收标准

> 依据：[plan/04](../plan/04-test-and-acceptance.md) D5／D6、E1～E8 与 §1／§4／§6，[02](./02-optimization-plan-and-change-scope.md)。
> 本文是**待执行的验收契约**，不是已通过结果。沿用仓库既有 Vitest 与项目级测试规则（`docs-test/`），不新建测试框架，不以覆盖率数字代替风险验证。

## 4.1 测试范围

- **单元／契约**：mask 删除后常量／类型／事件／再导出的引用闭合；`decideCompactionRung` 收敛后的档位；SDK `compactSession` 契约无 prune 残留。
- **集成**：三入口汇流与 busy 判定；跨入口失败终止与 force 一次；旧库重开；同一 run 多次压缩；子代理／scope 隔离。
- **有界实网**：每批的收尾动作（§4.7），本次**不执行**。

现有可直接扩展的位置均在 `packages/ohbaby-agent/src/`：`core/context/projection.unit.test.ts`、`manager.unit.test.ts`、`native-context.unit.test.ts`、`context-window-policy.integration.test.ts`、`compaction-atomic.integration.test.ts`、`compaction-hard-crash.integration.test.ts`、`core/message/database-store.integration.test.ts`、`core/lifecycle/lifecycle.unit.test.ts`、`adapters/ui-runtime/*`，以及 `tests/integration/core/context-agent-concurrency.integration.test.ts`、`context-subagent-scope.integration.test.ts`。

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | Stage |
| --- | --- | --- | --- | --- |
| G1 | 共用内部核心 | 集成 | 手动（CLI 命令／Web RPC）经 compact，自动与 force 经运行内 prepare，共用 runCompaction；活跃运行内自动／force 不被手动 busy 检查拒绝，不重复获取 mutationLane | 1 |
| G2 | 手动忙与重复 | 集成 | 有活跃 run 时后端给可读 busy，不入队、不暗停工具；压缩中不能重复发起、不能自动取消；子代理会话被拒 | 1 |
| G3 | 手动空闲成功 | 集成 | 只报结果，不额外发起普通请求；不自动续写 | 1 |
| G4 | mask 清扫闭合 | 单元/契约 | 无 `MASK_*`／`ContextEvent.Masked`／`maskEnabled` 残留；`CompactionThresholds` 只留 `summary`；`event-catalog` 无 mask 行；类型检查与契约测试通过 | 2 |
| G5 | 旧数据读取兼容 | 集成 | 删 mask 后旧会话数据库重开，旧摘要／原文可读，已退场 part 标记正确，无复活 | 2 |
| G6 | 跨入口失败终止（E3） | 集成 | 自动最终失败或无收益→结束本次运行，保留会话与原历史；自动／overflow／force 不另开额度；用户继续后进入新运行，不重跑已完成工具 | 3 |
| G7 | force 一次（E4） | 集成 | 溢出标不可重试、只进 force；一次性标志调用前**置位**、失败不回滚；**作用域＝本次恢复流程**：输入快照变化重入同一步不重新获额，新 model step／新 run 才复位（不是整个 run 只允许一次）；成功后重发不挂恢复钩子；二次溢出直接结束运行，不再 force | 3 |
| G8 | 多次压缩可继续（E1/E6 回归） | 集成 | 同一 run 连续至少三次成功压缩后可继续；压后没涨不重复压、涨过地板才再压；手动与溢出不受地板限制 | 3 |
| G9 | 压缩信号一致 | 契约 | 一次 attempt 唯一终态、scope 正确；自动经 run 流，CLI 手动经命令生命周期，Web 经请求状态和结果。业务 failed 即使命令 completed 也显示失败；手动用既有 context.window.updated 刷新占用，Web 完成后重查当前值；提交后 Stop 不抹成功，不伪造 run | 1/3 |
| G10 | 容量保护（E1／E7／E8） | 集成 | 默认 90% 与必要提前保护生效；模式 A／B 在手动、自动与 force 下共用约束，网络与容量恢复合计至多两次实际摘要请求。仅输出预留导致超窗、受保护输入较大、无合法可压旧段都覆盖；旧地板不阻挡容量条件变化 | 3 |
| G11 | Stop 与提交边界（D5／D6） | 集成 | 各入口提交前 Stop／冲突均不部分应用，提交后 Stop 保留成功；新输入不退场、不误确认普通交付；重开数据库后摘要、请求记录、遗漏及退场范围一致 | 3 |

## 4.3 集成边界

- Context ↔ Lifecycle／RunManager：溢出捕获、force 重试、运行结束链路。
- Context ↔ MessageStore：`commitCompaction` 原子提交与旧库重开（保留能力，不改事务语义）。
- Context ↔ SDK／server／CLI／Web：`compactSession` 契约、bus 事件与 run 流、notice 出口。
- 主代理／子代理／scope：busy 与失败终止互不污染（`tests/integration/core/context-subagent-scope.integration.test.ts`、`context-agent-concurrency.integration.test.ts`）。

## 4.4 回归清单（改造不能破坏什么）

- **保留的能力**：`time.compacted` 退场标记、`commitCompaction` 共用事务、工具调用与结果配对、原生依赖检查、旧摘要与原文读取、工具首次返回时的分页／必要限长。
- **断言按实际引用处理**：mask 专用断言（`projection.unit.test.ts:185-658`、`manager.unit.test.ts:1934-2268` 等）随机制删除；但**原子性、Stop、scope、配对、恢复**这类仍有效断言必须**移入新流程保留**，不能因为宿主测试文件被删而一起丢（`compaction-atomic.integration.test.ts`、`compaction-hard-crash.integration.test.ts`、`message/database-store.integration.test.ts` 的相关用例）。
- **前批不动**：第 3 批的 prune 清理、第 4 批的次数上限／抖动锁删除，本批只复核无回落，不重做。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
| --- | --- | --- |
| 默认路径 | 三入口完整使用新流程及第 3 批触发保护 | G1；`pnpm test:integration` 相关套件 |
| 无旧机制 | 无 prune-only／mask／重复 retry 分支 | G4；引用链核对 + 类型检查 |
| 失败不双花 | 自动／overflow／force 共享失败结果、不另开额度、不循环 | G6／G7 |
| 可继续 | 多次成功压缩后可继续；地板行为正确 | G8 |
| 不破坏旧数据 | 旧库重开读取正常 | G5 |
| 文档一致 | 模块文档与 `event-catalog.md` 已同步 | 02 §2.4 文档同步清单 |

示例定向命令（仓库根执行）：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/context/compaction-atomic.integration.test.ts
pnpm test:unit && pnpm test:contract && pnpm test:integration
```

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
| --- | --- | --- |
| 忙判定改动把「拒」变回「等」 | G2 断言后端 busy、不入队 | 与现有 `acquireRuntime` 重试语义的差异需实施时确认 |
| 跨入口只测自动一条 | G6／G7 强制覆盖 overflow／force | force 标志作用域易写错（step vs run） |
| 清扫误删共用件 | G5 + 引用链核对；保留清单 | `projection.ts` 里可能混有非 mask 辅助函数，须先核对 |
| 断言「按实际引用删除」被简化为「整个文件删」 | 4.4 明确保留原子/Stop/scope/配对/恢复 | 旧测试改写质量依赖实施审查 |
| 文档漂移 | 02 §2.4 文档同步清单 | 模块文档跨多文件，易漏 |

## 4.7 真实 API（每批收尾；本次不执行）

按 plan/04 §4：每批做完就走一次有界实网探测，不攒到别批。第五批串起压前普通请求、摘要、压后首个普通请求及后续正常请求，验证手动／自动、失败停止、用户继续与无重复工具副作用；缓存分别报告客户端共享前缀是否稳定、服务端是否真实返回 cache read／create。

用户已授权在独立测试数据目录、端口和会话中启动 agent 自己的 ohbaby 服务，用真实 api-key 发真实请求；凭据从测试说明或环境读取，**不写进参数、日志、文档或审查提示**。本次规划**没有**执行任何实网请求，也没有改业务代码。
