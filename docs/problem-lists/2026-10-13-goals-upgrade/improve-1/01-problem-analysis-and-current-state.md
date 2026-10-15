# 第 1 批：现状与问题分析

> 基线代码 main / `018a5c96`（2026-10-15 核对）。本文诊断现状，给 [02](./02-optimization-plan-and-change-scope.md) 提供改动依据；不复述 [plan/01](../plan/01-problem-analysis-and-current-state.md) 的整体问题。源码路径默认相对仓库根，定位以符号为准，行号只用于快速定位。

## 1. 结论：本批要修的三处现状

| 现状问题 | 位置 | 本批处理 |
| --- | --- | --- |
| 没有任何应用层空闲超时：provider 既不发事件也不报错时，生成器一直挂在 `await` 上 | `core/llm-client/streaming.ts` 的 `streamResponse` | 加 attempt 级空闲看门狗 |
| 等待点分散在四处（建流、首个 next、usage-only 后的 next、主循环 next），没有统一保护 | 同上（`:470`、`:496`、`:558`、`:621`） | 四处统一守卫 |
| 超时没有独立原因与分类：现有分支只有用户取消、provider abort、partial-output 门槛 | `:731`、`:745`、`:769-780`、`retry.ts` 的 `isRetryableProviderError` | 新增超时错误类并接入重试与原因分类 |

## 2. 现状与代码锚点

### 2.1 四个等待点与调用链

`provider.streamResponse` 的签名是 `Promise<AsyncIterable<InterfaceProviderStreamEvent>>`（`services/interface-providers/types.ts:202-204`），所以「建流」和「取下一个事件」是两个连续的 provider 等待：

- 建流：`const opening = provider.streamResponse({...})`（`streaming.ts:470`）。SDK 调用在这里发出 HTTP 请求并等到流可用；`openai-responses` 还会先 `await client.responses.create(...)`（`openai-responses.ts:181`）。
- 首个 next：在 `opening.then(...)` 链里调用 `observer.next(iterator)`（`:496`），`first` 这个 promise 实际覆盖「建流加首个事件」。
- usage-only 后的 next：`isUsageOnlyEvent(event)` 分支直接 `next = await observer.next(iterator); continue;`（`:557-560`），不经过循环顶部的 flush 与 yield。
- 主循环 next：循环尾部 `next = await observer.next(iterator)`（`:621`）。

调用方：agent-step 走 `core/lifecycle/lifecycle.ts:1450` 的 `for await`；context-summary 走 `adapters/ui-runtime/prompt-context.ts:90`（显式 `retry: { maxRetriesPerStep: 0 }`）；会话标题走 `services/session/title-generator.ts:127`。goals 侧 `adapters/ui-inprocess.ts:1005` 的 `runTurn` 等 `submitPromptInternal` 完成，`goals/driver.ts` 的 `driveGoal` 循环里 `await runner.runTurn(...)` 没有超时；provider 挂住时整轮不返回，目标保持 active，driver 不退出。

### 2.2 已有的有界机制与真正的缺口

用户主动取消其实是有界的：`RequestAttemptObserver.receive` 把待定 promise 与 abort 事件做 `Promise.race`（`request-observation.ts:46-61`），signal abort 后 `await` 会结束。重试退避也有自己的定时器（`sleepForRetry`，`streaming.ts:870-891`）。真正的缺口是：**没有人取消、provider 也不发事件时，没有任何定时器**，建流和 next 可以无限挂起。建流挂住时连首个 next 都到不了，`opening` 也不会被任何超时结束。

### 2.3 iterator 清理现状

`closeIterator`（`streaming.ts:439-449`）把 `iterator.return()` detach 出去，不等它返回；attempt 的 `finally`（`:831-838`）在未正常耗尽时 abort attempt controller 并调用 `closeIterator()`。也就是说「清理不阻塞取消」的形状已经存在，本批不需要另造；缺的是「等待本身有界」这道出口，设计时要保住现有 detach 行为。

### 2.4 signal 现状

每次 attempt 的 signal 组装在 `streaming.ts:379-384`：有 caller signal 且有 `requestOwner` 时是 `AbortSignal.any([callerSignal, controller.signal])`；有 caller signal 但没有 `requestOwner`（摘要路径）时直接用 caller signal；没有 caller signal 时用 attempt controller。现有断言 `expect(callArgs.signal).toBe(controller.signal)`（`llm-client.test.ts:719`）依赖这个恒等关系，本批若把 provider 可见 signal 换成融合信号，这条断言要改成行为断言（详见 02 兼容节）。

### 2.5 阈值与配置现状（定值前的核实）

- 请求级策略入口只有 `retry?: Partial<ProviderRetryPolicy>`（`streaming.ts` 选项，`resolveProviderRetryPolicy`，`retry.ts:174-181`；默认 `maxRetriesPerStep: 5`，`retry.ts:17-22`）。
- `model.json` 的 `llmParams` 目前只有 `temperature`、`maxTokens`、`contextWindowTokens`、`reasoning`（`config/llm/types.ts:56-79`，校验见 `config/llm/validation.ts:227-280`），且没有超时相关字段。往里加字段要同时改 validation、manager、`LLMConfig` 与 `createLLMClient` 的投影，属于多层配置，本批不做。
- 三个 provider 建 SDK client 都已显式 `maxRetries: 0`（`openai-compatible.ts:440`、`anthropic.ts:708`、`openai-responses.ts:171`），不存在 SDK 隐式重试层，看门狗只服务应用层这一层。

### 2.6 错误分类现状

`streamResponse` 的 catch 顺序（`streaming.ts:715-797`）：`signal.aborted`（用户取消，返回 partial 并结束）→ `provider.isAbortError(error)`（归为 `provider_abort`）→ protocol → 上下文溢出 → 摘要 transport → partial-output 门槛（有输出就不再重放）→ 重试计数。`isRetryableProviderError` 只认 HTTP status 与错误 code（`retry.ts:105-128`），`retryReason` 没有命中时返回 `connection_error`（`retry.ts:84-103`）。一个新的超时错误如果不显式接入这两处，就会被当成「不可重试且原因含糊」，既不重试也看不出是空闲超时。

另有一个具体的误判风险：超时需要 provider 侧 abort 才能尽快停掉连接，而 abort 后 SDK 可能抛出 `APIUserAbortError`（`provider.isAbortError` 为真）。如果只看错误对象不看「是谁触发了 abort」，超时会被伪装成 `provider_abort` 甚至用户取消。

## 3. 现状与预期（plan 约束）的区别

| 维度 | 现状 | 本批预期 |
| --- | --- | --- |
| 建流与 next 的等待 | 无上限；只有用户取消能让 `await` 结束 | 每次等待有独立计时，超时即有界结束 |
| 计时口径 | 不存在 | 只计 outstanding 的 provider 等待；消费者处理事件、本地 flush、yield 不计入 |
| 取消与超时 | 只有 caller signal 一种原因 | 用户取消优先且不重试；超时是独立原因，只 abort attempt 范围内的子控制器 |
| 重试 | 只由 provider 错误触发 | 无已提交输出时超时可走既有重试与退避；有输出时按既有规则不重放 |
| 清理 | detach return 已有，等待无界 | 等待有界、清理不阻塞、迟到 settle 不污染后继 attempt |
| 阈值 | 无任何超时常量或配置 | 单一常量加请求级可选覆盖；不做多层配置 |

## 4. 本批不解决的现状（留后续批次）

- 时间截止把目标置 `blocked`、迟到的运行失败不得覆盖 `blocked`：属于实现预算截止的后续批次；本批只保证失败走既有「run failed」通道，并验证「已 paused 不被迟到失败覆盖」的既有回归。
- goal 的状态、计轮、完成与统计、steer、CLI/Web 展示：分别是第 2、第 4、第 5 批。
- 语义化停滞检测、SDK 心跳假设：明确不做。

## 5. 测试基线现状

已有且与本批相关的用例：`core/llm-client/llm-client.test.ts`（signal 传递、本地取消返回 partial、重试后退避、有输出后不重放、非 abort 错误不重放、重试期间取消）；`retry.unit.test.ts`（重试分类）；`request-observation.unit.test.ts`（deferred 夹具与 streamStart 语义）；`sdk-retry.integration.test.ts`（真实 SDK 加本地 fetch stub，统计实际 HTTP 次数）；provider 侧 `openai-compatible.test.ts`、`anthropic.test.ts`、`openai-responses.unit.test.ts`（本地 HTTP server 与 wire 断言）；`goals/driver.unit.test.ts`（failed → paused、已 paused 不被覆盖）。

缺口：没有任何用例让 provider 永不 settle（既不 resolve 也不 reject），也没有阈值边界与计时口径的用例；`callArgs.signal` 的恒等断言会在本批被改成行为断言。

## 6. SWE 判断

复用 `RequestAttemptObserver`、既有 attempt 循环与 `closeIterator`，只新增一个小的纯逻辑模块（看门狗）和四处等待点守卫，不新建超时包、不把参数穿过业务端口、不加开关矩阵。这与 plan/01 §1.7「补齐边界而不是新建通用调度平台」一致；唯一的新跨层触点是一个可选的 provider 活动回调（见 02），用于避免误杀仍然活着的连接。

## 补充代码核查（2026-10-15，同一基线）

现有 `streaming.ts:487–501` 的 opening 回调按 `signal.aborted || finalized` 判断退出；`:806–817` 的重试退避发生在 `:832` 设置 finalized 之前。计划中的 watchdog 只 abort provider 子 signal，所以迟到 opening 可落在“两项都为 false”的窗口。02 必须增加即时 expired/retired 判据，04 W5 单独覆盖该窗口；不能把现有取消守卫描述成已足够。
