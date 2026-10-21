# llm-client 模块架构设计

## 位置与依赖

流式执行层位于 `packages/ohbaby-llm/src/client/`，协议层位于同包 `src/providers/`，纯配置合同位于 `src/config/`。消费者统一从 `ohbaby-llm` 导入；包只依赖厂商 SDK 和 Zod，没有 runtime workspace 依赖。

```text
agent config/llm（文件与环境变量 IO）
  -> agent core/llm-client/createLLMClient（配置与日志接线）
  -> ohbaby-llm/createLLMClientFromConfig（接收已校验 LLMConfig）
  -> createInterfaceProvider（连接级配置）

runtime / Lifecycle / Context
  -> ohbaby-llm/streamResponse（请求快照、缓存、重试、空闲保护）
  -> provider.streamResponse（SDK 与协议转换）
  -> InterfaceProviderStreamEvent
  -> StreamingResponse（中间展示与最终快照）
```

agent 的 `createLLMClient` 签名不变，配置默认从当前项目目录及其 `.env` 加载，具体读取由 agent config 模块执行。包装层将 token usage 诊断回调接入 agent logger。独立消费者直接把已解析的配置交给 `createLLMClientFromConfig`；工厂返回的 `config` 不包含明文 `apiKey`。

## 请求与协议边界

`streamResponse` 使用自有 `ModelMessage` 和 `ModelToolDefinition`，按请求快照决定 model、temperature、maxTokens、reasoning 和 prompt cache 策略。请求级覆盖不修改共享 client 配置。

provider 接口的核心是 `streamResponse(request)` 与 `isAbortError(error)`。provider 持有 SDK client，将自有消息转换为 wire 参数，再将原始事件转成 `InterfaceProviderStreamEvent`；client 层不直接处理厂商 chunk。

- `openai-compatible` 为缺省协议；`anthropic` 和 `openai-responses` 由 `interfaceProvider` 显式选择，未知 kind 抛错。`provider` 字符串是路由标识，不决定协议。
- 三协议支持各自的 native 输出与同源重放。成功耗尽后的 `modelState` 保留协议特殊状态，并校验其与共享投影的一致性；无法支持或不一致的协议数据拒绝通过。
- Responses 发送完整输入和 `store: false`，不使用 `previous_response_id`；其 prompt cache 策略仍为 observe-only。

## 流累积与完成边界

client 层累积正文、推理、工具调用原始 JSON 和 usage。provider 终态是完成候选；只有迭代器正常耗尽、工具参数解析和 native 校验通过后，才产出唯一正常最终快照。晚到错误可以使候选失效；无终态 EOF 和无本地信号的 provider abort 不伪造成功。

本地取消返回真实已有片段，`streamStopReason` 为 `user_aborted`，不合成占位正文、不发布可执行参数。调用方仍需耗尽生成器，再决定是否接受结果和执行工具。

三个内置 adapter 的 SDK 重试均关闭（`maxRetries: 0`）。项目层默认额外 5 次，仅在没有有效输出、错误可重试时重放；详见 [目标与职责](./goals-duty.md#重试边界)。context overflow、摘要 transport 恢复和工具执行属于 agent；请求观测经回调交给上层保存。

## 与 llm-model 的关系

agent `services/llm-model` 提供模型元数据、文本 token 估算和 UI reasoning 能力视图。`ohbaby-llm` 不依赖它，也不把估算值与 provider 返回的真实 `TokenUsage` 混用。结构化历史估算由 agent `core/context` 在领域消息上完成。

## 请求空闲看门狗（2026-10-15）

`streamResponse` 的每次 attempt 拥有一个 `idle-watchdog.ts` 实例。它分别守卫建流、首个 next、usage-only 后 next 和主循环 next；只计算未完成的 provider 等待，不计本地 flush 或消费者 yield 时间。默认 600,000 ms；请求级 `idleTimeoutMs` 可覆盖，必须为正有限数且不超过 2,147,483,647。没有环境变量、model.json 或 UI 配置入口。

provider 接收融合的 `providerSignal` 和可选 `onActivity`。三种协议在 SDK 原始事件到达时调用活动回调；没有产出归一化事件的 role/空 delta/状态事件也可续时。SDK 未暴露的心跳不在保证内。

超时只 abort 专属子 controller，并由 race 主动结束等待；不修改 caller signal。用户取消优先；无 partial 时走既有有界 retry，原因是 `stream_idle_timeout`，耗尽后抛 `ProviderRetryExhaustedError`；已有正文、reasoning、工具片段或 finish 时抛 `ProviderStreamInterruptedError`，不重放，也不把超时伪装成摘要可恢复的 transport 错误。

这个分类有一个上层后果：partial idle 在 lifecycle 中记录为 `APIError`，已输出正文仍保存在消息记录和 UI 中，但没有 interruption fact，也不会进入后续请求或摘要的失败历史投影。它与 ECONNRESET 的保留策略不同，属于本批按既有分类落地的边界。

安装的 OpenAI、Anthropic SDK 另有默认 600,000 ms 的建流 timeout，收到 HTTP 响应后清除；因此建流阶段存在同阈值竞争，错误可能先由 SDK 或看门狗报告。流读取仍由本模块守卫。未来上调 idle 常量时，需同时复查 SDK 的建流 timeout，不能将常量误当成唯一请求时限。

observer 观察受守卫的原始读取，迟到 chunk 不触发 first-text 记录。原始 opening 的回调保留局部 iterator 清理，先检查 aborted/finalized/expired 再绑定 attempt，覆盖退避期间 finally 尚未执行的窗口。return 继续 detach；不等待不合作 provider 的清理。

看门狗保护普通请求与 goal 请求，不判断任务进展；目录位置取舍及用户要求回看的事项见 [位置记录](../../problem-lists/2026-10-13-goals-upgrade/improve-1/06-request-idle-placement-review.md)。
