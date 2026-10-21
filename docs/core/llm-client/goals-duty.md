# llm-client 模块的目标与职责

## 当前状态

源码位于 `packages/ohbaby-llm/src/client/`，通过 `ohbaby-llm` 包根入口公开。该包还包含 `src/providers/` 的协议适配器，以及 `src/config/` 的配置类型、纯校验和模型 profile 函数。包不依赖其他 workspace 包。

- `createLLMClientFromConfig(config, options?)` 同步接收已解析、已校验的 `LLMConfig`，创建 provider 并返回 `LLMClientInstance`。
- `streamResponse()` 接收自有 `ModelMessage` 和 `ModelToolDefinition`，消费 provider 的规范化事件，产出 `StreamingResponse`。
- `ohbaby-agent` 保留异步 `createLLMClient(options?)` 包装层，负责 `getLLMConfig()`、项目 `.env` 路径和诊断日志接线，再调用纯配置工厂。原有 agent 公开导出保持兼容；新工厂直接从 `ohbaby-llm` 导入。

## 设计目标与职责

1. **提供统一流式入口**：调用方使用自有消息、工具定义和取消信号，协议转换由同包的 providers 完成。
2. **累积文本、推理与工具片段**：中间 `messageSnapshot` 供展示；工具 JSON 在正常流耗尽后解析。
3. **明确完成边界**：只有流耗尽并通过终态和 native 投影校验才发布正常最终快照；保留统一 `finishReason` 和原始 `rawFinishReason`。
4. **区分取消与失败**：有本地取消信号时返回已有真实片段和 `user_aborted`；无终态 EOF、协议错误和无本地依据的 provider abort 属于失败。
5. **维护调用层保护**：保留 prompt cache 策略和键、请求观测回调、空闲看门狗及既有有界重试。
6. **传递真实用量和原生状态**：规范化 usage，成功耗尽后输出经校验的 `modelState`；不把推理或原生状态混进正文。

## 重试边界

三个内置 adapter 均显式设置 SDK `maxRetries: 0`，关闭 SDK 重试；项目层默认额外重试 5 次，适用于尚无正文、推理、工具片段或完成信号，且错误属于既有名单的尝试。名单包括 408、429、5xx、指定连接错误和空闲超时。默认指数退避从 500 ms 开始、基数上限 10,000 ms，带抖动；显式 Retry-After 上限 60,000 ms。请求可通过 `retry` 覆盖策略。

出现有效输出后项目层不重放。context overflow 交回 agent Lifecycle 的强制压缩恢复；摘要 transport 中断保留来源，交回 agent Context 的既有摘要恢复。`retry` 帧报告项目层重试；默认单次步骤请求通道最多 6 次 HTTP 尝试，不计上层 overflow 或摘要恢复。

## 非职责

- 配置文件和环境变量的读取、配置单例与写回、网络探测、系统代理安装仍在 agent。`ohbaby-llm/src/config/` 只提供纯类型、校验和 profile 函数；工厂不会自行校验或加载文件。
- session/message/run 持久化、工具权限与执行、上下文裁剪和 overflow 恢复由上层负责。回调可由上层保存请求观测，但包本身不读写数据库。
- token 估算、模型元数据和 UI reasoning 能力视图仍在 agent 的 `services/llm-model/`；本包传递 provider 真实 usage。
- 不做 provider fallback，不新增自动续写，不把 `isComplete` 或已解析工具参数当作运行成功或工具执行授权。

## 与其他模块的关系

| 模块                                                       | 关系                                             |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `ohbaby-llm/src/providers`                                 | 同包协议边界，创建 SDK client 并输出规范化事件   |
| `ohbaby-llm/src/config`                                    | 同包纯配置合同与校验函数                         |
| agent `config/llm`、`core/llm-client/create-llm-client.ts` | 读取配置并调用工厂，接入诊断回调                 |
| agent Lifecycle / Context / runtime                        | 调用流接口、接受结果、保存和恢复                 |
| agent `services/llm-model`                                 | 提供上层预算所需估算和模型能力视图，不被本包依赖 |
