# 请求空闲监控的位置与后续回看

> 记录日期：2026-10-15。实施期间用户提出位置疑问，随后同意本批先放在 `core/llm-client`，要求留档，并派子代理核查五个参考项目。本文记录该决定与源码证据，不改写已确认的 00–04。

## 当前决定

本批 `idle-watchdog.ts` 留在 `core/llm-client`。它监控一次模型请求的建流和流读取是否长期没有可观察活动，普通对话、摘要、标题和 goal 续跑共用；它不判断目标是否取得进展，也不覆盖工具执行。

当前 `streamResponse` 拥有 attempt、重试、部分输出和取消规则，也是四个等待点的共同调用者。让它持有看门狗，provider 只上报活动，能在同一处决定“这次超时是否允许重试”，无需让 goals 了解 SDK 连接。goals 的活跃时长预算由 improve-3 单独实现，不能拿本批的空闲阈值替代。

用户原话：

> packages/ohbaby-agent/src/core/llm-client/idle-watchdog.ts这个模块放llm-client真的合适吗？我似乎不是很同意，为什么goal模块需要这个看门狗？

> 行，同意，但这个地方记一下，后面要回头看，如果可行你派遣子代理查看code-cli/下项目分别是如何做“监控的是一次模型请求有没有持续返回数据”的

## 五个参考项目的实际做法

以下为本地源码快照，不代表上游最新版本。根目录均为 `/Users/hansun025/Projects/code-cli/`；Claude Code 目录实际是 Claude Code Best（CCB）的复原扩展实现，不作为 Anthropic 官方源码证据。

| 项目 / HEAD | 所属层与活动口径 | 阈值、退出与覆盖边界 |
| --- | --- | --- |
| ZCode / `aac47556` | model adapter；逐次守卫 SDK `fullStream.next()`，只计 outstanding 等待 | 默认 600 秒，每次重试增加 30 秒；race next、timeout、abort。覆盖首事件和中段，没有单独的 opening Promise 守卫 |
| deepseek-harness / `d743267388` | 通用 timeout helper，由 provider adapter 使用；守卫 next，原始 SSE frame 和注释心跳 pulse | 默认 300 秒；首个 next 内含 fetch，因此覆盖建流。超时 race 主动结束等待；只在有未完成读取时计时 |
| kimi-code / `cbd754049` | 当前 V2 主要 requester 为 SDK 的裸 for-await；未找到应用层模型流空闲 watchdog | 有可选 headers timeout，与流空闲不同；不能据此声称 SDK/runtime 没有任何超时。Google 建流另有 caller abort race |
| CCB / `77a7934e` | API 编排层；开流成功后按 SDK raw event 重置；timer 跨本地处理和 yield 持续计时 | 显式开关启用，默认 90 秒，45 秒 warning；abort SDK stream、detach body.cancel，没有 next/timeout race。建流由另一套 API timeout 负责 |
| Codex / `12cca49c81` | `codex-api` 的 SSE/WS transport parser；SSE 在归一化前按解析事件守卫，WS 按 frame（含 Ping/Pong）守卫 | 默认 300 秒；Tokio timeout 结束 poll。WS send 同样有界，connect 默认 15 秒；SSE idle 不覆盖 HTTP 开流等待，不把消费者背压算作空闲 |

### 源码锚点与不能照搬的部分

- **ZCode**：`apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts:readNextWithStreamIdleTimeout`；`runner-stream.ts` 的 stream 消费、`canRetryStreamFailure`、`closeStreamIteratorBestEffort`。出现 reasoning、正文、工具调用或 finish 后，adapter 不重放。清理另有 1 秒上限及 SDK tee 处理；timeout catch 会等待 `onTimeout`，本项目不照搬这处潜在阻塞。
- **DSH**：`packages/util/timeout/src/index.ts:idleWatchdog`；`packages/llm/llm-deepseek/src/adapter.ts:generate`；`sse.ts:parseSse`；`defaults.ts`。adapter finally abort 后 detach return。helper 的 timeout 有 race，但没有独立 race caller abort；本项目必须保留用户取消的有界退出。DSH 的重试层会结算 `assistant/attempt` 后重试，不等同于本项目“有 partial 就不重放”。
- **Kimi**：`packages/agent-core-v2/src/human/llm/requester/timeout.ts` 解析 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS`；`bases/{openai,anthropic,openai-responses,google-genai}/requester.ts` 为已核查调用链。上层 `human/agent/turn.ts` 可 rollback accumulator 后重试。下载逻辑另有 idle watchdog，不能用它证明模型请求也有同类保护。
- **CCB**：`src/services/api/claude.ts` 的 `releaseStreamResources`、`CLAUDE_ENABLE_STREAM_WATCHDOG`、`CLAUDE_STREAM_IDLE_TIMEOUT_MS` 和 raw event 循环；`client.ts` 的 `API_TIMEOUT_MS`。超时退出依赖 SDK 配合；还保留 streaming → nonstreaming fallback，源码记录过重复工具执行风险。借鉴诊断信息，不复制其退出与重放策略。
- **Codex**：`codex-rs/codex-api/src/sse/responses.rs:process_sse_with_treatment`；`endpoint/responses_websocket.rs:run_websocket_response_stream/send_websocket_request`；`model-provider-info/src/lib.rs` 默认配置；`core/src/responses_retry.rs`、`core/src/session/turn.rs` 恢复策略。terminal error 直接 drop 连接，不等待 graceful close；core 可重建历史后重试，没有通用“出现正文就禁止新请求”门槛。Rust drop 与 JS iterator.return 不能直接类比。

这些实现支持“请求存活监控与 goal 进度判断分开”，但不能证明某个目录位置天然正确。DSH/Codex 的分层更细；ohbaby 当前 attempt 边界集中在 llm-client，沿现有边界接入最少。

## 后续回看条件

在 improve-5 组合验收时回看一次；如果未来请求管线先发生变化，则提前检查：

1. 是否仍只有 `streamResponse` 一个消费者？若多个独立请求入口开始复制相同计时和取消逻辑，再评估提取公共 helper。
2. attempt 与重试所有权是否已经下沉到独立请求层？若已迁移，看门狗应随所有者移动，不长期留一个跨层转发壳。
3. SDK 是否开始暴露更细的 transport 活动？先调整 provider 活动接线，不把 SDK 未暴露的心跳宣称为可观察。
4. 实网是否出现合法静默超过 10 分钟？用真实等待分布复查阈值，不能仅凭另一个项目的默认值修改。

当前不新增通用 timeout 包、不做 goals 专用 watchdog，也不把上述回看条件当成已承诺的重构任务。
