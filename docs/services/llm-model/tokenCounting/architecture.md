# tokenCounting 模块架构设计

## 当前状态

`services/llm-model` 当前已经落地为模型元数据与 token 估算服务层，不再是占位模块。源码位置：

```text
packages/ohbaby-agent/src/services/llm-model/
├── index.ts
├── tokenCounting.ts
└── tokenCounting.unit.test.ts
```

`tokenCalculation.ts` 如仍出现在旧文档中，应视为历史名称；当前实现以 `tokenCounting.ts` 为准。

## 职责边界

本模块只负责本地、同步、可注入的模型辅助能力：

- 根据模型标识返回保守的 context token limit。
- 使用启发式算法估算文本和消息历史的 token 数量。
- 计算 context 使用率与接近上限的 warning。
- 通过 `createHeuristicTokenCounter()` 提供可注入到 `core/context` 的默认 `TokenCounter`。

本模块不负责：

- 不调用任何 LLM provider 或厂商 SDK。
- 不读取 `config/llm`，不创建 client，不发网络请求。
- 不解释 provider 返回的真实 usage，也不把估算值写回 `TokenUsage`。
- 不决定是否压缩、裁剪、拒绝请求；这些策略由调用方负责。

## 与 LLM 三层的关系

```text
services/providers
  厂商 SDK/API、请求转换、流事件归一化、abort 判断

core/llm-client
  配置绑定、provider 调用、stream 聚合、tool call 参数完成态解析

services/llm-model
  模型元数据、token 估算、上下文限制；无网络 I/O
```

`services/llm-model` 的消息输入类型命名为 `TokenCountMessage`，表达“用于估算 token 的结构化消息”。`core/llm-client` 仍保留 `ChatCompletionMessage`，表达 provider/lifecycle 的消息输入边界。两者不要混名。

## 设计取舍

1. 当前 token counter 是启发式估算器，不追求与任何厂商 tokenizer 完全一致。
2. `TokenUsage` 表示 provider 返回的真实 usage；估算 token 只用于上下文规划。
3. 未知模型使用保守默认 context limit，避免上层误以为可用窗口过大。
4. 未来若接入真实 tokenizer，应作为本模块的新实现或策略注入，不应放入 `core/llm-client` 或 provider adapter。
