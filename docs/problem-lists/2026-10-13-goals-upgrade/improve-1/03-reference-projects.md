# 第 1 批：参考项目核实与取舍

> 更新：2026-10-15。整体对照见 [plan/03](../plan/03-reference-projects.md) 与 plan/00 决议 2；本文只补本批实际核对的定点与不照搬处，不复述全部对照。
> 参考根目录：`/Users/hansun025/Projects/code-cli/`。行号只用于定位，优先按符号查找。

## 1. 本批实际核对（定点）

| 主题 | 项目与位置 | 读到的行为 | 本批用法 |
| --- | --- | --- | --- |
| 只在 outstanding 等待期间计时，可被活动重新计时 | DSH `packages/util/timeout/src/index.ts:idleWatchdog` | 定时器只在 `next()` 未完成时存在；`pulse()` 在仍有未完成等待时重新计时、否则空操作；`dispose` 清定时器；`idleWatchdog` 在 L135–140 要求正有限阈值；同文件另一个 `deadline` helper（L99–121）才接受非正值作为无定时器哨兵，不能混为一谈 | 借形状：消费者耗时不计入、`pulse()` 只在未完成等待上生效；不引入「关闭超时」的公开配置 |
| 超时本身要能结束等待 | DSH 同上（`Promise.race([iterator.next()..., expired.promise])`，注释说明 deadline 拥有这次等待）；ZCode `apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts:readNextWithStreamIdleTimeout`（`Promise.race([next, timeout, abort])`，注释写明 Stop 若不能立刻让 `next` 返回，等待必须主动结束） | 两端都不等「provider 配合 abort」才结算 | 本批硬性要求：守卫用 race 让超时结算调用方 await |
| 超时只取消自己的子控制器 | ZCode 同上，`createLinkedAbortController` 只把父 signal 的 abort 转发给子 controller，不反向 abort 父 signal；超时时 abort 子 controller 并把超时错误作为原因 | 与「只关自己这一层」一致 | 借边界：超时 controller 只融合进 provider 调用看到的 signal，共享用户 signal 永不被看门狗 abort |
| 原始事件活动重新计时 | DSH `packages/llm/llm-deepseek/src/sse.ts` 每个 SSE 事件调用 `activity()`，`adapter.ts` 把它接到 `watchdog.pulse()`；ZCode `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts:312–317` 消费 SDK `fullStream` 事件 | DSH 可观察原始 SSE；ZCode 这里可证实的是 SDK fullStream 活动，不能推定 SDK 未暴露的原始心跳也可观察 | 借形状：provider 边界加可选活动回调（本批 §5）；不声称 SDK 未暴露的注释式心跳可观察 |
| 输出前后的重试边界 | ZCode 设计文档同篇：idle timeout 触发时发布 `model_stream_stalled`、abort 当前请求；未越过重试边界可复用统一预算；已产出 reasoning/正文/工具调用/finish 则不自动重放，交给上层恢复 | 与本项目「无输出才重试、有输出不重放」同向 | 只借「有输出不重放」的判据；不引入新事件通道，复用现有重试与 partial 分支 |
| 清理不等待可能永不返回的 return | DSH `adapter.ts:generate` 的 `finally`：`consumer.abort()` 之后 `void iterator.return(undefined).catch(() => {})`，注释说明 awaiting 会把已结算的结果重新挂住 | 与 ohbaby 现有 `closeIterator` 的 detach 同形 | 保留既有 detach 行为，不新增等待 |

## 2. 本批不照搬处

- **不照搬超时回调等待**：ZCode `stream-idle-timeout.ts` 的超时路径会 await `onTimeout`；ohbaby 的调用方退出必须有界，清理继续 detach，不能让回调等待抵消 race 的保护。
- **不照搬默认秒数**：DSH 用 300 秒（`llm-deepseek/src/defaults.ts`），ZCode 用 600 秒 base（`packages/contracts/src/config/index.ts` 的 `DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS`）。本批把 10 分钟固定为保守工程默认，理由见 [02 §4.3](./02-optimization-plan-and-change-scope.md)；不以参考项目的数值为依据，也不以它们否定本项目的取值。
- **不照搬 per-retry 递增**：ZCode 的 `MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS = 30_000`（每次重试加 30 秒）是额外机制；本批保持单一常量，不做递增。
- **不照搬事件与恢复分层**：ZCode 的 `model_stream_stalled` 事件与 core stream recovery 是另一套恢复体系；本批复用现有 `llm:retrying` 与 `ProviderRetryExhaustedError`／`ProviderStreamInterruptedError` 通道。
- **不照搬配置体系**：ZCode 的 `modelStream.idleTimeoutMs` 走 `~/.zcode/cli/config.json` 与 runtime config 注入；本批只加请求级可选覆盖，不新建多层配置（[02 §4.1](./02-optimization-plan-and-change-scope.md)）。
- **不照搬错误优先级**：DSH 在 catch 里先判超时再判用户 abort（由 `AbortSignal.any` 的「先 abort 者为准」决定）；本批要求用户取消优先（plan/04 W4），见 02 §6 的顺序。
- **不引入 goal 专用超时，不新建超时包**：DSH 有独立 `util/timeout` 包与 goal 侧预算，本批只在 `core/llm-client` 放一个小模块，不做跨包抽象。

参考项目只支持局部形状选择，不按项目数量投票；本批规则以 [plan/00](../plan/00-discussion.md) 与 [plan/02 §2.7](../plan/02-optimization-plan-and-change-scope.md) 为准。
