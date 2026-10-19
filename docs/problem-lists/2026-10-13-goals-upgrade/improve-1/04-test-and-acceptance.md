# 第 1 批：测试与验收标准

> 依据 [02](./02-optimization-plan-and-change-scope.md) 与 [plan/04 §4.8](../plan/04-test-and-acceptance.md)。这是待实施的验收目标，不是已通过的结果。用仓库已有 Vitest、fake provider 与仓库既有分类，不新建测试框架。
> `idle-watchdog.unit.test.ts` 等新文件按既有命名后缀在实施时创建；下列命令中的文件除标注「新增」外均已存在。

## 1. 分层与定向命令

- unit：看门狗本身的计时、重新计时、dispose、错误分类；不触网。
- integration：`streamResponse` 与假 provider 的协作、四处等待点、取消与迟到结果的竞争，用可控 deferred 与 fake timers，不靠 sleep 碰运气。
- 回归：既有 llm-client、provider、goals driver 用例。

仓库根执行（示例，不是覆盖声明）：

```sh
pnpm exec vitest run \
  packages/ohbaby-agent/src/core/llm-client/idle-watchdog.unit.test.ts \
  packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts \
  packages/ohbaby-agent/src/core/llm-client/retry.unit.test.ts \
  packages/ohbaby-agent/src/core/llm-client/request-observation.unit.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/openai-compatible.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/anthropic.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/openai-responses.unit.test.ts \
  packages/ohbaby-agent/src/core/llm-client/sdk-retry.integration.test.ts \
  packages/ohbaby-agent/src/goals/driver.unit.test.ts

# 按类型回归（脚本按文件名后缀收集）
pnpm test:unit
pnpm test:integration
pnpm typecheck
```

`idle-watchdog.unit.test.ts` 为新增文件；其余路径已存在。按实际改动补用例，记录实际命令、通过/失败与未覆盖范围。

## 2. 用例（映射 plan/04 的 W 编号）

| ID | 本批要证明 | 主要落点 |
| --- | --- | --- |
| W1 | provider 建流或首个 next 永不完成时有界超时；符合重试条件时退避重试；耗尽明确 `ProviderRetryExhaustedError`（run 记为 failed） | `llm-client.test.ts`：假 provider 的 `streamResponse` 返回永不 settle 的 opening 或 next；断言错误类型、provider 被 abort、重试次数与 `llm:retrying` 事件 |
| W2 | 四处等待都受保护，无漏网裸 `await`：建流、首个 next、usage-only 后 next、主循环 next 各一个用例 | `llm-client.test.ts`：usage-only 用例先发一个只带 `tokenUsage` 的事件、再让下一次 next 永不 settle |
| W3 | 已输出正文、reasoning 或工具调用片段后挂起：显式失败、不重放 | `llm-client.test.ts`：断言 provider 调用次数为 1、错误为 `ProviderStreamInterruptedError`；沿用现有「有 delta 不重试」用例的形状 |
| W4 | 用户 stop 与超时竞争：取消原因不被伪装成可重试超时；超时不 abort 共享 signal；本批回归「run failed → 目标暂停、已 paused 不被迟到失败覆盖」 | `llm-client.test.ts`（abort 与 timeout 前后脚触发，断言 `user_aborted` partial、不做重试、caller signal 未因超时 abort）；`goals/driver.unit.test.ts` 既有两条用例。**goal 时间截止与 blocked 的完整交互留待实现预算截止的后续批次组合验证** |
| W5 | next／return 不响应 abort、迟到 resolve/reject：调用方有界退出、清理不阻塞、无未处理 rejection、不污染后继 attempt | `llm-client.test.ts`：假 iterator 忽略 signal 且 `return` 永不返回；超时后让旧 attempt 的 next 迟到成功与迟到抛错各一次；建流守卫超时后，让迟到的 `opening` 在 retry backoff 尚未结束（finally 未执行、共享 signal 未 abort）和 finally 之后，分别成功/失败（成功时断言不接首个 next、不触碰 observer、不覆盖 attempt iterator、不写新请求记录，迟到 iterator 只被 detach 清理；失败时断言错误被消费）；随后断言新 attempt 输出干净、无未处理 rejection |
| W6 | 只计 outstanding provider 等待：消费者处理缓慢不误判；可观察事件到达即重置；总时长可超过阈值 | `llm-client.test.ts` 用 fake timers：两次 next 之间由消费者等待超过阈值不触发；事件间隔小于阈值、累计超过阈值不触发 |
| W7 | 普通 run、goal run、多次重试共用同一保护；timer／listener 不泄漏、无第二层重试 | `llm-client.test.ts` + `sdk-retry.integration.test.ts`：以本地 fetch stub 计实际 HTTP 次数，等于 1 加应用层重试次数；attempt 结束后 fake timers 无残留计时 |
| 阈值边界 | 默认常量与注入值都按边界触发 | `idle-watchdog.unit.test.ts` 与 `llm-client.test.ts`：注入小阈值做场景断言；在默认 `DEFAULT_STREAM_IDLE_TIMEOUT_MS` 上用 `vi.useFakeTimers()` 与 `advanceTimersByTimeAsync` 验「差 1 毫秒不触发、到点触发」 |
| 分类与原因 | 超时错误可重试、原因可辨认；非法 `idleTimeoutMs` 在调用 provider 前拒绝 | `retry.unit.test.ts`（`isRetryableProviderError`／`retryReason`）；`llm-client.test.ts`（非法值抛 `RangeError`，provider 未被调用） |
| 活动重新计时 | 「transport 活着、归一化事件为空」的窗口不被误判 | provider 侧：`openai-compatible.test.ts`／`anthropic.test.ts` 的本地 HTTP server 发只有 role 或空 delta 的 chunk；断言 `onActivity` 被调用、空闲计时被重置、不判超时（S3） |

## 3. 计时口径怎么测

- 断言「不触发」与「触发」两类结果，不能只测超时能报错：漏测不触发会把 `0` 秒超时这种回归放过去。
- 消费者耗时用例要在两次 `next` 之间主动等待，证明计时已清；provider 侧活动用例要证明重新计时发生在「没有产出事件」的路径上。
- fake timers 与真实 deferred 混用时，用显式 deferred 作为 barrier：先推进 Vitest 的异步计时器（`advanceTimersByTimeAsync`），再结算 barrier 让被放弃的等待迟到返回；不靠猜调度顺序。

## 4. 取消、迟到与清理的证据

- 取消：先 abort 再推进计时，断言走 `user_aborted` partial 而不是超时；先超时再 abort，断言重试循环不会在 abort 后继续。
- 迟到：旧 attempt 的超时之后，让被放弃的 next 迟到 resolve 与迟到 reject 各发生一次；用 vitest 的未处理 rejection 检测（测试失败即视为不通过），不等实现方自证。
- 清理：假 iterator 的 `return` 永不返回时，测试在有界时间内结束；断言 `return` 被调用过、没有被 await（例如旧 attempt 结束后立即可推进下一步）。

## 5. goal 组合面的归属

- 本批验证：watchdog 失败最终 run failed → 目标在仍 active 时暂停；已 paused 的目标不被迟到失败覆盖（`goals/driver.unit.test.ts` 既有回归）。
- 留给后续批次：时间截止把目标置 `blocked`、截止中断与超时竞争、blocked 不被迟到失败覆盖。这些依赖预算截止机制，不在本批实现，也不在本批 04 里假装通过。

## 6. 验收判据（通过/不通过）

本批**通过**需同时满足：

1. 四个等待点都有守卫且能指认（不接受只测其中一个）；usage-only 路径单独有用例。
2. 超时不 abort 共享用户 signal；用户取消与外部 abort 优先且不重试；错误不被伪装成 `provider_abort`。
3. 无 partial 才走既有重试；有 partial 不重放，且以 provider 调用次数为证据。
4. W5 必须包含退避期间 finally 前的 opening 迟到成功/失败，不能只测 finally 后；不响应 abort 的 iterator 场景下：调用方有界退出、无未处理 rejection、清理不阻塞、后继 attempt 不被污染。
5. 消费者耗时不触发超时；可观察活动能重置计时；总时长可以超过阈值。
6. 默认常量与请求级覆盖都可用；非法值在调用 provider 前被拒绝；无多层配置改动。
7. 既有回归（`llm-client.test.ts`、`sdk-retry.integration.test.ts`、`driver.unit.test.ts`、provider 用例）通过；`pnpm typecheck` 与 lint 通过；模块文档（`docs/core/llm-client/architecture.md`、`test.md`）已同步。

任一条不满足即**不通过**。阈值按 [02 §4.3](./02-optimization-plan-and-change-scope.md) 固定为保守工程默认；后续实网观察如显示合法静默更长，允许只调常量并重跑边界用例，不改结构，不视为降级。

## 7. 审查要点

- 是否把 goal 或某个 provider 的特例塞进了 `core/llm-client`；是否偷偷假设 SDK 心跳。
- 计时口径是否只覆盖 outstanding 等待（有没有把 flush、yield、消费者耗时算进去）。
- 分类顺序是否把超时误判成 `provider_abort` 或用户取消；是否新增了第二层重试。
- 是否真的覆盖了 usage-only 与建流两个容易漏的等待点。
- 是否只测了「会超时」，没测「不该超时」。
- 回滚路径是否只停用新增包装，没有顺带撤销现有取消与重试保护。
