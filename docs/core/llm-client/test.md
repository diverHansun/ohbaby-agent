# llm-client 模块的测试策略

## 范围与位置

纯 client 测试位于 `packages/ohbaby-llm/src/client/`，只依赖本包配置合同、providers 和测试 fixture。agent 包装层及跨模块合同保留在 agent，避免新包反向依赖 agent。

文档列出当前测试职责，不表示本次编辑已经执行测试；执行结果见本议题验收记录。

## 本包测试

| 文件（相对 `packages/ohbaby-llm/src/client/`）                  | 验证内容                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `llm-client.test.ts`                                            | 显式配置工厂、不在返回 config 暴露密钥、provider 绑定、请求参数、正文和工具片段累积、取消与重试                     |
| `completion.unit.test.ts`                                       | EOF 后唯一完成、晚到 usage/error、合法空 stop、无本地信号 provider abort、取消不伪造正文、非法工具 JSON/native 投影 |
| `model-snapshot.unit.test.ts`、`native-state.unit.test.ts`      | 中间快照、工具原始参数、原生状态只在正常耗尽后发布                                                                  |
| `retry.unit.test.ts`、`errors.unit.test.ts`                     | 错误分类、Retry-After、退避及 overflow 边界                                                                         |
| `prompt-cache.unit.test.ts`                                     | 策略选择、稳定键、scope 隔离、跨重试复用和 observe-only 边界                                                        |
| `idle-watchdog.unit.test.ts`、`stream-idle.integration.test.ts` | 等待点计时、原始活动续时、消费者空档、部分输出后的中断、取消竞争与迟到清理                                            |
| `request-observation.unit.test.ts`                              | 请求记录回调、尝试准入、观测保存失败、真实接收时间与取消                                                            |

纯配置校验测试位于 `packages/ohbaby-llm/src/config/__tests__/validation.unit.test.ts`。协议转换测试见 [providers 测试策略](../../services/providers/test.md)。

## 留在 agent 的测试

- `packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts` 验证 `createLLMClient` 默认项目和 `.env` 路径、显式配置选项、配置错误传播与 token normalization 诊断回调。
- `tests/integration/core/llm-client/sdk-retry.integration.test.ts` 通过真实 SDK 和受控 HTTP 响应验证三种协议的流内错误、缺终止事件、共享预算和摘要兼容。开始输出后，符合条件的模型步骤应先封存失败请求，再发送 `retry` 帧并抛出带 `stepRetry` 的错误。已交付部分输出的请求以错误结束，Lifecycle 负责重发当前步骤。
- `tests/integration/core/lifecycle/step-retry.integration.test.ts` 验证 Lifecycle 重跑步骤、失败历史、请求记录顺序、待处理输入和取消。
- `packages/ohbaby-agent/src/core/context/prompt-cache-wire.contract.test.ts`、`tests/integration/core/lifecycle/openai-responses.integration.test.ts` 验证依赖 agent 的 wire/配置合同，直接导入 `ohbaby-llm`。
- Lifecycle/Context、server 和 CLI 的集成测试验证结果接受、用量持久化、摘要恢复及取消。这些属于上层接线，不搬进本包。

## 维护原则

- 分别校验中间帧与最终帧；不能只断言最后一帧的正文。
- 正常完成必须同时具备 provider 终态、生成器耗尽和校验通过；无终态空流是中断，显式空 stop 是合法终态。
- 取消返回已有真实片段，不期待 `(Interrupted)` 或 `(Empty response)` 占位文本。
- 重试测试在 HTTP 边界核对实际请求次数、`retry` 帧和失败观测，确认 SDK 没有隐式重试。验证 LLM 层在无有效输出时原地重试，在已有输出时按资格发出整步重来的决定。配置 IO 和日志测试留在 agent。
- 协议 wire 参数由 provider 测试验证，不在 client 测试重复实现 adapter。
