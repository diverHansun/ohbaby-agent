# 测试与验收契约

状态：计划，尚未执行本轮实施验收。调查阶段的临时红测试只证明直接故障，见 [01](01-problem-analysis-and-current-state.md)。实施结果写入届时新增的 05。

## 1. 场景和判定

| 编号 | 场景／触发 | 必须观察到的结果 | Stage |
| --- | --- | --- | --- |
| T01 | 真实 SQLite 放入另一目录历史 `message_1`；子完成时主空闲 | 自动 run 成功接收 runtime 身份，模型收到结果一次；旧消息不变 | 1 |
| T02 | 重启、切项目、超出 UI 历史窗口；重复身份内容不一致 | 合法自动输入不冲突；真正跨 session/scope/内容冲突仍拒绝 | 1 |
| T03 | A/B 已结束、C 被可控 barrier 阻塞；主忙／主闲各测 | A/B 可先消费，不等待 C；C 后来可开下一轮；同一会话不并行开主 run | 2 |
| T04 | 主 Stop 后子继续；新结果在 abort 收尾和 idle 边界到达；C 已被忙 run 接收但未请求 | 顺带接收但未请求的 C 保留自动机会；本次 run 的触发结果 A/B 被 Stop 后不自行重开；Stop 不给会话永久上锁 | 2 |
| T05 | 子结果在 beforeFinish 及 inputs close 前后到达 | 当前 run 消费或下一 run 接力，无两边遗漏；重复事件只处理一次 | 2 |
| T06 | 部分认领、认领后提交前、建账前 Stop 分别注入；账本暂缺时并发检查 | 持久 run 关联可解释；活跃提交不被抢占；Stop 将触发结果恢复额度置 0，随即重开数据库仍不重试；owner 接管后仅合格入口失败有限恢复，无孤儿 gate 或假消费 | 2 |
| T07 | 接收成功但 delivery 关联未完成；成功请求后 input／execution 确认遗漏 | 重开真实数据库后按身份补关联／确认，不额外请求模型 | 2 |
| T08 | 自动 submit resolve-failed、reject、cancel；首个请求之前的入口故障 | 三种返回都释放 gate 并正确展示；非 Stop 的合格入口失败最多额外 3 次，重试前持久扣减额度，刷新／重启不重置；准入禁止不启动 | 2 |
| T09 | provider 已尝试后失败，或主 Stop；之后重复事件与新 C 分别到达 | 重复事件不启动；C 可以启动并带未消费旧结果；已消费结果不再交付；后续步骤失败不撤销消费 | 2 |
| T10 | 子 LLM retry 耗尽、超时、意外退出与正常停服；输出文件不可读 | 前两者及时通知；process-interrupted 与 service-shutdown 在接管后各补一次，关闭服务期间不启动模型；另测 abort 的 markInterrupted 先于 interruptRoot 写终态，仍保留 service-shutdown | 3 |
| T11 | reopen SQLite：死 owner／活 foreign owner／未知 owner；反复 list/monitor/history | 仅有效接管恢复；不重复补通知；纯读不写数据、不产生模型调用；旧 delivery=none 中断不激活，不扫醒全部旧会话 | 3 |
| T12 | Goal active／paused／ended／budget exhausted；重启丢失 ownedRuns；goalId 为 string／null／旧缺失；归档、迁移、Rewind | 持久归属驱动原准入，不按 triggerSource 猜；未知 Goal 结果不落入普通路线；已替换 Goal 不重新归属；被回退数据不复活；已知普通结果不一概冻结；旧记录仅完整历史证明从未有 Goal 时可按普通结果处理 | 3 |
| T13 | 子 Completed，主自动 run 在输出前失败；成功消费后主后续失败 | 前者显示主处理错误和必要待处理提示；后者只显示主任务错误，不把子结果改成投递失败 | 4 |
| T14 | Web/TUI 无输出自动失败、正常静默成功、用户 Stop；重连／刷新 | 自动失败可见且遵循现有每轮错误组件；不伪造用户消息；正常静默成功不增噪声；刷新不重执行 | 4 |
| T15 | 主到子重复消息、scope 越界、目标关闭未消费、手动 stop/close 子 | 幂等与隔离保持；未消费可查且不隐式重放；手动停止无独立自动唤醒；迟到成功不覆盖终态 | 3 |

T07 必须覆盖“成功请求已存在，但 input.processedRequestId 还未写”的窗口，不能只测 execution.markProcessed 失败；另测首次请求失败、后一个不同 requestId 成功，确保不是只查 firstAttemptRequestId。T08 的重试需 fake clock 和持久剩余额度断言，不能以短时间没看到第二次调用替代。另测顺带输入已写 firstAttemptRequestId、尚未写 execution claim 即退出，恢复仍不重复唤醒。T09 的失败后新结果是产品要求，不能误写成永久 suppress。

## 2. 测试入口与方法

现有入口包括 `execution-store.integration.test.ts`、`execution-message-channel.integration.test.ts`、`continuation-coordinator.unit.test.ts`、`session-supervisor.unit.test.ts`、`adapters/ui-inprocess/subagent-wakeup.integration.test.ts`、`runtime/prompt-scheduler/current-run-inputs.integration.test.ts` 和 `runtime/execution-recovery/session.integration.test.ts`。把跨 persistent facade 的 T01 放在合适的正式集成入口，不能只保留 gitignored 探针。

SDK 使用 `packages/ohbaby-sdk/src/util/turn.unit.test.ts` 和 subagent reader 测试；Web 使用已有 SubagentsPage 集成测试，TUI 使用已有 app／transcript 契约入口。不要创建一套新测试框架；遵循各包现有 Vitest 配置与脚本。

核心可靠性用例使用临时 SQLite、真实 store/runtime 与确定性 fake model。为外部调用前后、结果接收后、确认前提供测试阻塞点或已有可替换端口；不要为测试暴露新的产品 API。不依赖真实网络、不用长 sleep、不把 mock callback 被调用当作消费完成。

## 3. 整体验收

1. T01 先在未修实现变红，修复后变绿；旧冲突保护仍通过。
2. T01–T15 覆盖所有 Stage；相关包类型检查和已有 lifecycle／Goal／输入回归通过。实际命令使用实施时 package.json 的脚本，不预写已通过结果。
3. 做一次本地端到端：派 A/B/C，先看到 A/B 处理；停止主轮次后 C 结束仍唤醒；再模拟一个子失败，主收到原因并可自行补救；无输出启动失败能在界面看到。
4. 用隔离数据库验证进程恢复、旧 attempted 兼容与纯读不变；不直接修改用户原故障会话或生产数据库作为测试手段。
5. 检查无新信箱、无限重试、周期模型巡查、Goal 绕行或工具重放；同步权威文档。05 记录偏差和残余风险，未经验证的项明确保留，不能称为完整修复。

## 4. 本次规划检查

本次只检查文档一致性、路径和源码依据，并按用户要求交 Pi 审查。Pi 对设计的同意不能替代以上实现测试；尚不存在本轮“全部测试通过”的结论。
