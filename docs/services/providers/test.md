# providers 模块的测试策略

## 测试目标与位置

测试位于 `packages/ohbaby-llm/src/providers/`，验证自有请求到 wire 参数的转换、原始流到 `InterfaceProviderStreamEvent` 的归一化，以及协议校验和用量合同。执行结果由本议题验收记录维护。

| 文件（相对该目录）                                                          | 主要职责                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `index.test.ts`                                                             | 显式三协议 factory、缺省 Chat、未知 kind 拒绝                                               |
| `openai-compatible.test.ts`、`openai-compatible-native.integration.test.ts` | Chat 请求与增量、原生状态重放                                                               |
| `openai-responses.unit.test.ts`                                             | Responses 请求投影、事件顺序与终态校验、`store: false` 和不发送 continuation/cache 控制字段 |
| `anthropic.test.ts`、`anthropic-native.integration.test.ts`                 | Messages、system、tools、流事件及原生块重放                                                 |
| `model-contract.unit.test.ts`、`native-state.unit.test.ts`                  | 自有消息模型、同源和 native 投影合同                                                        |
| `reasoning.unit.test.ts`                                                    | 推理意图、路由能力与请求参数                                                                |
| `token-usage.unit.test.ts`、`responses-token-usage.unit.test.ts`            | inclusive input、cache 明细、reasoning 子项、缺失与非法值、诊断回调                         |

## 跨模块合同

依赖 agent 配置或上下文的 `packages/ohbaby-agent/src/core/context/prompt-cache-wire.contract.test.ts`、`packages/ohbaby-agent/src/core/lifecycle/openai-responses.integration.test.ts`，从 `ohbaby-llm` 导入被测接口。agent `core/llm-client/sdk-retry.integration.test.ts` 使用真实 SDK 和本地 fetch stub 验证 SDK 重试关闭、项目层 HTTP 尝试预算、取消及原始流活动；这些文件不能搬入本包形成反向依赖。

## 测试边界

- provider 测试验证 wire 参数、事件归一化、native 校验和 SDK 错误识别，不执行工具或启动 agent。
- 正文/推理/工具累积、最终 `ParsedToolCall[]`、取消快照、项目重试与空闲看门狗属于 client 测试。
- `provider` id 不决定协议；新增测试应使用显式 `interfaceProvider`，不能恢复按 anthropic/claude 字符串猜测协议的旧约定。
- 使用本地 fixture 或 fetch stub。真实付费请求只由显式 opt-in smoke 脚本运行，不是普通单元或集成测试的前置条件。
