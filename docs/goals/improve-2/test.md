# goals 测试

> 版本范围：goals 升级第 2 批的实施后文档，只描述本批阶段状态；上级目录保留原始设计，后续批次尚未包含。原始规划与验收标准见 [improve-2 方案](../../problem-lists/2026-10-13-goals-upgrade/improve-2/02-optimization-plan-and-change-scope.md)和[测试标准](../../problem-lists/2026-10-13-goals-upgrade/improve-2/04-test-and-acceptance.md)，实际验证与限制见[实施验收](../../problem-lists/2026-10-13-goals-upgrade/improve-2/05-implementation-acceptance.md)。

测试遵循 [项目测试分类](../../../docs-test/classification.md)，就近使用 unit、contract、integration 命名。默认使用 fake provider；真实模型服从性测试保持显式 opt-in，不输出密钥。improve-2 验收基线见 [04-test-and-acceptance.md](../../problem-lists/2026-10-13-goals-upgrade/improve-2/04-test-and-acceptance.md)。

## 模块测试

| 测试文件 | 重点 |
| --- | --- |
| `store.unit.test.ts` | 生命周期、先 append 再提交、active 时间、complete 持久阶段、用量与预算 |
| `service.unit.test.ts` | 初始化、执行中断、单 driver、显式 resume、工具状态操作 |
| `admission.unit.test.ts` | 准入后计轮与同快照正文、epoch 失效、迟到用量去重、clear 重试、失败时钟与 G8 不重开 |
| `driver.unit.test.ts` | runner 拥有准入与结算，预算快路径、failed/cancelled 映射、最终轮计数 |
| `budget.unit.test.ts` | 轮数/active 时间预算、75% 收敛、安全阀，token 仅统计 |
| `tools.unit.test.ts` | 四工具 schema、参数与后端调用、tokens 预算单位拒绝 |
| `injection.unit.test.ts` / `injection.contract.test.ts` | 当前快照渲染、paused light note、不可信文本转义 |
| `persistence.integration.test.ts` | 真实 SQLite 回放、active 降 paused、complete 残留清理 |
| `goal-compact.integration.test.ts` | 真实消息 history 与 compact，目标状态独立、下轮重新渲染 |

## improve-2 必须验证的边界

- pause 条目先执行：旧准入不计轮、不发消息。admit 先执行：轮数已提交，后续准备取消仍算该轮。
- 准入 append 失败：内存、轮数、票据与 lease 均不留残留。pause append 失败：状态与 active 时间锚点保持原样。
- pause→resume、objective 实改与新目标创建立即使旧 epoch 无效；旧结果不能暂停新生命周期。同文编辑与预算调整保持 epoch。
- 普通用户工具在 initialized store 的任何 await 前捕获目标，在边界内复核；未知、缺失和失效模型 runId 拒绝变更。goal-owned 工具只能修改票据绑定目标。
- complete 发一次 completion，保留状态等待尾部 usage；usage 失败不标 settled，clear 单独失败重试不重复 usage，clear 仅发 progress。complete 残留不可 resume/edit/budget，但允许新建。
- 迟到 usage 只按 goalId 匹配，paused/complete 接受但不恢复 active，替换目标不接收旧用量。total/cache 缺失按部分统计，历史字段缺失保持未知。
- 预算只看轮数与 active 时间；旧 tokenBudget 兼容忽略，SetGoalBudget 的 tokens 单位拒绝。查询保留 total/cache/不完整标注，续跑正文不含 token 预算。
- driver 清理按 promise 身份；新代与显式 resume 不丢唤醒。运行失败且 pause 落盘也失败（G8）时，只展示错误，不自动重开同代。

## adapter 集成与执行恢复

跨模块 race 使用真实 owner 队列、gate、scheduler、runtime 和 store 组合验证，provider 输出及持久化故障按测试边界控制；不能仅用 store unit 测试替代：

1. 用户 prompt/compact/goal 共用 gate，queued 用户优先；goal 准入等待事件唤醒，不抢占用户 run。
2. 准备票据在 runId 之前可被停止；每个准备 await 后复核。worker 启动后，complete/objective 编辑不能因 epoch 失效误杀主 run；pause/cancel 在 runReady 交接执行捕获的停止意图。
3. 中断只作用于捕获的 rootRunId 与其子代理，不误伤后继用户 root，也不 close 子代理实例。
4. runtime finalization、usage、clear 共用顺序恢复闭包。恢复登记先于 lease 释放，阻止后继执行；重试不重复已成功阶段，不覆盖既有 recovery，不自动恢复自主运行。
5. goal 工具 create(replace:true) 不打断当前 run；旧票据不能修改或结算到新目标，新 epoch 在旧 driver 清理后推进。

## 运行方式

```sh
pnpm exec vitest run packages/ohbaby-agent/src/goals --exclude '**/*.real.*'
pnpm exec eslint packages/ohbaby-agent/src/goals
pnpm exec tsc -b packages/ohbaby-agent --pretty false
```

模块测试通过后，还需执行 adapter 的 goal execution / session execution / compact 集成测试与仓库要求的检查。真实模型测试不能代替上述确定性 race 与故障注入测试。
