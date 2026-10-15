# 第 1 批：优化方案与改动面

> 基线 main / `018a5c96`；依据 [00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md) 与 [plan/02 §2.7](../plan/02-optimization-plan-and-change-scope.md)。本文是给后续开发会话的实施契约，本次只撰写规划文档。路径除注明外均在 `packages/ohbaby-agent/src/`。

## 1. 交付目标与完成定义

在 `core/llm-client` 加一层通用的请求空闲看门狗：每次 attempt 内，建流等待与每次 next 等待都有独立计时，超时即有界结束；超时是独立原因，不带 goal 特例、不 abort 用户共享 signal、不新增第二层重试循环；与既有部分输出、重试、取消和清理规则按原顺序衔接。

**本批完成定义**：

- 四处 provider 等待（建流、首个 next、usage-only 后的 next、主循环 next）都被同一守卫覆盖，没有漏网的裸 `await`。
- 只有 outstanding 的 provider 等待计入计时；消费者处理事件、本地持久化 flush、yield 的耗时不误判为 provider 空闲。
- 超时只 abort 看门狗自己的 attempt 级子控制器；用户 stop、外部 abort 与 goal 截止的取消语义不变，且不被伪装成可重试超时。
- 无已提交输出时，超时走既有重试与退避；重试耗尽明确 failed。已有部分输出、工具调用或副作用时不重放。
- iterator 不响应 abort、`return` 永不返回时，调用方仍有界退出；清理不阻塞；迟到 settle 不污染后继 attempt、不产生未处理 rejection。
- 默认常量与请求级可选覆盖可用；测试可以注入小阈值，也能用 fake timers 在默认阈值上验边界。
- 现有回归用例（`llm-client.test.ts`、`sdk-retry.integration.test.ts`、`driver.unit.test.ts`）在新分类下仍然通过。

## 2. 职责与数据流（模块视角）

**职责边界。** `core/llm-client` 拥有看门狗本身、计时口径与超时分类；`services/interface-providers` 只多收到一个融合 signal 和一个可选的活动回调，不感知超时参数；lifecycle、context、goals 的业务入口不改——超时最终以既有 `ProviderRetryExhaustedError` 或 `ProviderStreamInterruptedError` 的面貌向上传播，上层不需要认识新错误类。

```text
streamResponse（每次 attempt）
  ├─ 建流等待 ──┐
  ├─ 首个 next ──┤ 四处等待都经 watchdog 守卫：进入即计时，settle 即清计时
  ├─ usage-only next ─┤  超时 → 报超时错误 + abort 看门狗子控制器
  └─ 主循环 next ──┘        （融合进 provider 可见 signal，不碰 caller signal）
        │
        ├─ 无已提交输出 → 既有重试循环（退避、llm:retrying 事件）→ 耗尽后 ProviderRetryExhaustedError
        └─ 已有部分输出 → 既有 partial 门槛 → ProviderStreamInterruptedError，不重放

上层保持不变：run failed →（目标仍 active 时）driver pause；用户 abort 仍走 user_aborted partial
```

## 3. 四个等待点与计时口径

守卫的位置（符号为准）：

| 等待 | 位置 | 要求 |
| --- | --- | --- |
| 建流 | `const opening = provider.streamResponse({...})`（`core/llm-client/streaming.ts:470`） | 守卫覆盖 `opening` 本身；建流超时同样要结束调用方等待，并让 attempt 记为超时 |
| 首个 next | `opening.then(...)` 链内 `observer.next(iterator)` 调用（`:496`） | 守卫这一次 next 的等待；与建流是两个连续等待点，各自重新计时 |
| usage-only 后 next | `isUsageOnlyEvent(event)` 分支的 `next = await observer.next(iterator)`（`:557-560`） | 必须单独覆盖；该路径跳过 flush 与 yield，不能被「只守循环尾部」漏掉 |
| 主循环 next | 循环尾部 `next = await observer.next(iterator)`（`:621`） | 同上 |

计时口径：

- 只在守卫进入后到该次等待 settle 之间计时；settle 立即清计时。同一时刻最多一个未完成等待，因此可以只有一个定时器。
- 不把 `observer.flush()`（本地持久化）、`yield` 与消费者处理事件的耗时算作 provider 空闲：这些发生在守卫之外，计时已清。消费者处理一个 chunk 用多久都不会触发超时。
- 每次进入新等待重新计时；正常慢流只要事件之间的间隔小于阈值就永远不会触发，总时长可以超过阈值。
- 收到可观察活动重新计时。已 settle 的事件天然会重新计时；对「transport 有活动、但没有产出归一化事件」的情况（例如只有 role 或空 delta 的 chunk），由 provider 的活动回调触发重新计时，见 §5。
- 建流守卫超时后，迟到的 `opening` 不得污染 attempt：`opening` 成功、拿到 iterator 后必须先验证本次 attempt 是否已失效（至少 `signal.aborted || finalized || watchdog.expired()`，或等价的同步 retired 状态），失效时只对迟到 iterator 做 detach 清理，不调用 `observer.next`、不触碰 observer、不写入任何 attempt 状态。超时只 abort providerSignal，catch 退避期间 finally 尚未执行，所以原有 `signal.aborted || finalized` 不足以覆盖该窗口。先把返回值放在局部变量，检查后才赋给 attempt iterator / 启动 observer / 接首个 next；迟到 rejection 分支同样不能启动或修改 observer，异常由 race 消费。

## 4. 接口与选项

### 4.1 请求级选项（最小配置路径）

在 `streamResponse` 的 options 中新增可选字段，紧挨现有 `retry`：

```ts
idleTimeoutMs?: number;   // 未提供时用 DEFAULT_STREAM_IDLE_TIMEOUT_MS
```

- 校验沿 `validateRequestMaxTokens` 的形状（`streaming.ts:199-211`）：必须是正的有限数，且不超过 `2_147_483_647`（Node 定时器上限），否则抛 `RangeError`，在调用 provider 之前失败。
- 默认常量 `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000`，与错误类一起从新模块导出（`core/llm-client/idle-watchdog.ts`，见 §4.2）。
- **本批不接 `model.json`、不加环境变量、不做 UI、不加禁用哨兵值**。理由：当前配置层没有超时字段（01 §2.5），加一个要走 validation、manager、`LLMConfig` 与 client 投影四层；而请求级选项已经给测试提供了注入点。若未来确需产品级配置，沿同一 options 形状逐层加，不预先搭框架。
- 阈值是产品级兜底，不是 SLA。默认值按 §4.3 固定；本批不设实施前的实网核查门槛，后续实网观察如显示合法静默更长，只调常量，不改结构。

### 4.2 看门狗模块

新增 `core/llm-client/idle-watchdog.ts`（配 `idle-watchdog.unit.test.ts`），形状对齐参考实现（见 [03](./03-reference-projects.md)）：

```ts
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

export class ProviderStreamIdleTimeoutError extends Error {
  readonly code = "PROVIDER_STREAM_IDLE_TIMEOUT";
  // 至少携带 idle 时长与阈值，便于日志与测试断言
}

export function createIdleWatchdog(input: {
  signal: AbortSignal | undefined;   // 现有 attempt signal：上游取消经它转发给 provider
  timeoutMs: number;
}): {
  readonly providerSignal: AbortSignal;  // 只给 provider 调用用：any([signal, 超时信号])
  wait<T>(pending: Promise<T>): Promise<T>;                      // 守卫建流等待
  next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>>; // 守卫一次 next 等待
  pulse(): void;                     // 有活动但没有值：对未完成的等待重新计时；没有未完成等待时是空操作
  expired(): boolean;                // 本次 attempt 是否已因超时结束
  dispose(): void;                   // 清定时器与监听；幂等
};
```

要点：

- 超时来源是一个专用的 attempt 级 controller，它只融合进 `providerSignal`，用于尽快结束连接；不写进 `signal` 本身，原因见下一条。
- 为什么不复用现有 attempt controller：如果超时去 abort 它，`signal.aborted` 会变真，catch 的第一判断（`streaming.ts:731`）就会把超时读成用户取消——正是 §2.7 禁止的伪装；而且摘要路径（无 `requestOwner`）的 attempt controller 现在根本不在 provider 链上，改它等于重写那条路径的 abort 归属。所以保留这一个只服务超时的 controller，并且只挂在 provider 调用上，不改变 caller signal 与 attempt controller 的既有归属。
- 守卫等待必须让**超时本身能结束调用方的 await**：即使底层 `next()` 不理会 abort、`return()` 永不返回，也要用 race 让超时先结算（参考 ZCode 的注释场景）。
- 被放弃的等待留在原地，由超时触发的 provider abort 让它自然收敛；迟到 resolve 或 reject 的 handler 已由 race 挂好，不产生未处理 rejection。
- `pulse()` 只在存在未完成等待时重新计时，因此消费者耗时不会因为 provider 侧活动被误算。

### 4.3 默认阈值与长思考取舍

- 固定 10 分钟（`600_000` ms）作为保守工程默认：建流等待包含提供方排队与提示预填充，长思考期间也可能长时间没有可观察 chunk，阈值要留足余量；没有实测数据支撑更精确的取值，就取偏大的一侧。
- 不做 ZCode 每次重试增加 30 秒的机制；选择比 DSH 的 300 秒更宽松的默认值，为合法静默留余量。参考数值与适配器能输出 reasoning，并不能证明实际请求的静默时长分布。
- 阈值管单次无活动等待。若每次尝试从建流开始就完全无活动，默认 5 次重试意味着最多 6 次尝试，约 60 分钟再加退避才耗尽。建流、首事件分别计时，有活动还会重置，所以这不是所有请求的总时长上限；用户可以随时 stop，goal 总活跃时长另由第 3 批预算限制。
- 合法长思考若超过 10 分钟完全没有可观察活动，也会被判超时；已有部分输出时按既有规则失败、不重放。该默认值是保守工程选择，尚无真实请求测量支持；后续若需调整，修改常量并重跑边界用例。

## 5. provider 边界的活动回调

`InterfaceProviderRequest`（`services/interface-providers/types.ts:174-186`）新增可选字段：

```ts
onActivity?: () => void;   // provider 观察到原始 transport 活动时调用；必须同步、廉价、不得抛出
```

- 三个适配器在能观察到原始 chunk 或事件处各加一处调用：`openai-compatible.ts:465` 的 `for await (const chunk of stream)`、`anthropic.ts:733` 的 `for await (const rawEvent of stream)`、`openai-responses-stream.ts:840` 的 `for await (const event of stream)`。
- 回调由 `streamResponse` 接到 `watchdog.pulse()`；假 provider 和现有测试不传该字段即可，不受影响。
- 本批把这项接线定为交付内容之一（§9 的 S3），不留给实施临场决定：加一个可选字段和三个调用点，改动小、可以独立测试；只保留「事件 settle 后重新计时」会留下「transport 活着、归一化事件为空」的误判窗口。
- 边界要写实：只对适配器真正收到的原始事件重新计时；SDK 内部丢弃的注释式心跳不可观察，不声称它们会重置计时。

## 6. 分类、重试与取消的顺序

在 `streamResponse` 的 catch 中按以下顺序判定（`streaming.ts:715-797` 的现有骨架）：

1. `signal.aborted` 优先：用户 stop、外部 abort 与 goal 截止取消都走既有 partial 返回路径，不重试。超时不会 abort 共享 signal，所以不会把用户取消伪装成超时。
2. 看门狗已触发（`watchdog.expired()`）时，把当前错误归一为 `ProviderStreamIdleTimeoutError`。这一步必须在 `provider.isAbortError(error)` 之前：超时 abort 会让 SDK 抛 `APIUserAbortError`，否则会被误判为 `provider_abort`。
3. 既有 partial 门槛（`:769-780`）不动：已有正文、reasoning、工具调用片段或 finish 信息时抛 `ProviderStreamInterruptedError`，不重放。本批不把超时并入 `transport` 源（即 `streamFailureSource` 不加超时分支），摘要路径「部分输出后能否重试」的语义保持现状。
4. 无已提交输出时走既有重试循环：`failedAttempts` 计数、`nextRetryDelayMs` 退避、`llm:retrying` 事件都不变。`isRetryableProviderError` 需要认识新错误类（`retry.ts:105-128` 加一支），否则超时不会重试；`retryReason` 对新错误返回 `stream_idle_timeout`（`retry.ts:84-103` 加一支），保证事件与日志能辨认原因。
5. 重试耗尽仍按既有形状抛 `ProviderRetryExhaustedError`（cause 为超时错误）；摘要路径的 `retry: { maxRetriesPerStep: 0 }`、上下文压缩的单次重试等都沿用既有语义，不需要新分支。

不新增第二层循环：SDK 已是 `maxRetries: 0`，看门狗自身不重试，只把错误交给既有循环。

## 7. 所有权、取消与清理

- **所有权**：看门狗实例归 `streamResponse` 的每次 attempt 所有，在重试循环体内创建、attempt 的 `finally`（`:831-838`）里最先 `dispose()`。上层不知道它的存在。
- **超时只 abort 专用 controller**：它只融合进 provider 调用看到的 signal（`providerSignal = AbortSignal.any([signal, timeout.signal])`），不写进 `signal` 本身。这样超时后 `signal.aborted` 仍为 false：catch 的第一分支不会把超时读成用户取消，观察记录记 `error` 而不是 `aborted`，重试退避等既有判断也不受影响。
- **现有 signal 归属不重写**：`streaming.ts:379-384` 的 caller signal 与 attempt controller 融合规则、`finally` 里的 `controller.abort()` 保持原样；超时来源与它们互不干扰（为什么不能复用 attempt controller 见 §4.2）。
- **清理**：保留现有 `closeIterator` 的 detach `return()`（`:439-449`），不在 `finally` 里 `await` 任何 provider 侧的清理；provider 不响应 abort、`return` 永不返回时，调用方已经由超时结算退出，清理只是脱离引用。
- **迟到结果隔离**：每次 attempt 用新的 iterator 与新的看门狗；被放弃的等待的 settle 由 race 挂好 handler（成功值被丢弃、异常被消费），不会写进后继 attempt 的累积状态，也不会变成未处理 rejection；迟到的 `opening` 在退避期间（finalized 仍 false）和 finally 之后均按 §3 的过期校验隔离，只做 detach 清理。事件监听统一用 `{ once: true }` 并随 settle 移除；`observer.close()`（`:834`）已有同类清理，看门狗对齐。

## 8. 失败如何向上传播（与 goals 的衔接）

- 无输出、重试耗尽 → `ProviderRetryExhaustedError` → lifecycle 记为 run failed（`terminalReason: "provider_retry_exhausted"`）→ `ui-inprocess.ts:1005` 的 `runTurn` 返回 `{ status: "failed" }` → `goals/driver.ts` 在目标仍是 `active` 时 `pause("runtime error: ...")`。**最终表现就是当前 goal 暂停**，与现有「failed outcome pauses with runtime error reason」用例一致（`goals/driver.unit.test.ts:82-99`）。
- 已有部分输出 → `ProviderStreamInterruptedError` → 同样 run failed → 目标暂停（可 resume），不会自动重放产生重复输出或副作用。
- 观察记录：超时 attempt 的 `ModelRequestRecord.outcome` 记 `error`（共享 signal 未 abort，不是 `aborted`），usage 不伪造。
- 与未来预算截止的关系：截止机制会把目标置 `blocked` 并中断本次 run，迟到的 watchdog 失败不得覆盖它。本批只保留现有行为——driver 的「仅当目标仍 active 才 pause」守卫（`goals/driver.unit.test.ts:82-118` 覆盖 failed 暂停与已 paused 不被覆盖）。更完整的保护由后续批次补齐：第 2 批在记账核对 goalId 与本次执行所属生命周期（plan/00 决议 7+12），第 3 批的截止中断与 blocked 状态补上剩余部分。本批不实现这些，也不改变失败到达 driver 的通道。

## 9. 分步（同批 Stage）

| Stage | 内容 | 可独立验证 |
| --- | --- | --- |
| S1 模块 | `idle-watchdog.ts`（常量、错误类、实现）＋ `idle-watchdog.unit.test.ts`；`isRetryableProviderError`／`retryReason` 分支 | 纯逻辑单测：计时、重新计时、dispose、超时能结束不响应的等待、迟到 rejection 不泄漏 |
| S2 接入 | `streamResponse` 的四处守卫、`idleTimeoutMs` 校验、catch 分类顺序、`providerSignal` 融合；更新 `llm-client.test.ts` 的 signal 断言并补 W1–W6 用例 | 定向用例：注入小阈值与 fake timers；既有重试、取消、不重放回归 |
| S3 活动回调 | `InterfaceProviderRequest.onActivity`，三个适配器接线，provider 侧用例 | 构造「只有空 delta 的 chunk 流」证明空闲计时被持续重置、不被误判超时 |

S2 依赖 S1；S3 可与 S2 并行接线，但完成定义要求三者在同一批内闭合，否则「transport 活着、事件为空」窗口仍会误判。验收顺序：S1 单测 → S2/S3 定向用例 → `pnpm test:unit`、`pnpm test:integration`、`pnpm typecheck`。

## 10. 改动面（本批文件）

只列本批会动的文件，不是全仓清单。

| 文件 | 改动 |
| --- | --- |
| `core/llm-client/idle-watchdog.ts`（新增） | 常量、`ProviderStreamIdleTimeoutError`、`createIdleWatchdog` |
| `core/llm-client/idle-watchdog.unit.test.ts`（新增） | 见 04 |
| `core/llm-client/streaming.ts` | `idleTimeoutMs` 选项与校验；四处守卫；catch 分类顺序；provider 可见 signal 融合 |
| `core/llm-client/retry.ts` | `isRetryableProviderError` 与 `retryReason` 各加一支 |
| `core/llm-client/index.ts` | 按需导出常量与错误类（供测试与日志使用） |
| `services/interface-providers/types.ts` | `InterfaceProviderRequest.onActivity?: () => void` |
| `openai-compatible.ts`、`anthropic.ts`、`openai-responses.ts`（含 `openai-responses-stream.ts`） | 原始 chunk／事件循环处调用 `request.onActivity?.()` |
| `docs/core/llm-client/architecture.md`、`test.md` | 同步看门狗职责与测试点；不顺手改写历史取名漂移（模块文档里 `streamChatCompletion` 之类的旧名不在本批范围） |

## 11. 兼容与回滚

- **已知会变的断言**：`llm-client.test.ts:719` 的 `expect(callArgs.signal).toBe(controller.signal)` 改为行为断言（provider 收到的 signal 变为 `any([signal, 超时信号])`：abort caller signal 后它同步 abort；超时后 caller signal 本身不被 abort）。这是本批唯一预期改动的既有契约断言。
- **接口兼容**：`onActivity` 是可选字段，既有生产者、假 provider 与测试字面量不受影响；`idleTimeoutMs` 是可选选项。无持久化格式与数据库变化，无历史数据迁移。
- **行为兼容**：默认开启后，10 分钟零活动的请求会失败而不是无限等待；正常快流与慢流不受影响（间隔计时）。摘要与标题请求同样受保护，不另设开关。
- **回滚**：去掉 provider 调用处的 signal 融合与四处守卫即回到现状；也可只把常量调大。回滚不得顺带撤销现有取消、重试与 partial 保护，也不保留长期禁用开关（§2.8 的回滚约束）。

## 12. 与相邻批次的衔接

- 第 2 批（执行准入与统计）与本批共享「run failed」通道：本批只改失败原因与分类，不改 driver 的暂停逻辑和状态枚举。
- 实现预算截止与 blocked 的后续批次负责 W4 的组合面（截止中断与超时竞争、blocked 不被迟到失败覆盖）；本批为它保留的接口事实是：超时永远不 abort 共享 signal，失败以 run failed 到达 driver。
- 本批不修改 plan 或相邻批次文档；相邻批次文档若尚未撰写，本文只按 [README](../README.md) 的批次地图引用其职责，不猜测其文件内容。
