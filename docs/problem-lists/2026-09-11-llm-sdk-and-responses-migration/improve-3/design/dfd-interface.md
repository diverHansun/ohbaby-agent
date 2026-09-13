# LLM 契约 · 数据流与接口

## 1. Context & Scope

边界涉及 message/context、llm-client、provider、lifecycle、runtime 传输。SQLite 和 UI 不是新模型消息的直接所有者。

## 2. Data Flow Description

1. 历史读取按原 Message/Part JSON 解码；context serializer 保持过滤、summary、runtime、工具往返和 system 顺序。
2. 最终 messages/tools 构成同一深冻结 PreparedModelRequest；tail directives 和 step-local tools 不另建平行来源。
3. estimator 从此请求生成旧口径计量材料；composition 保持七类归因，与校准总量不强制相等。
4. llm-client 加上既有配置、scope、purpose、promptCache，交给绑定 adapter；各 adapter 直接翻译 ModelMessage，而非先翻译 Chat。
5. adapter 校验供应商流，llm-client 沿用累积与重试。Responses 仍须有效终态及 EOF 才释放终态，unsupported item 仍拒绝。
6. lifecycle 消费唯一快照及满足既有条件的解析调用，映射回既有 TextPart/ToolPart；不得直接把新快照 JSON 落库。
7. runtime worker、raw bridge consumer、LifecycleEvent 重建、公开导出各自检查；具体暴露调查见 ../01a。

## 3. Interface Definition

建议调用入口 streamResponse，返回现有异步 StreamingResponse。请求保留 model/messages/tools/temperature/maxTokens/signal/purpose/sessionId/contextScopeId/promptCache；client 创建接口不新增同义入口。ParsedToolCall 只在既有完成及解析条件下产生，isComplete 单独不足以授权。

公开旧入口按已确认决定删除，不留永久兼容 facade；发布入口测试和迁移说明覆盖仓库消费者。外部未知使用者不会自动兼容。内部事件与持久回放是否需要窄读取兼容，须 U4 明确，不能与公开函数别名混为一谈。

## 4. Data Ownership & Responsibility

context 拥有请求快照；adapter 拥有 wire 转换；llm-client 拥有单次累积；lifecycle 拥有执行/存储映射；message store 拥有持久 JSON。cache capability/key、usage normalizer、token metadata codec 保持原所有权。扩展字段不因 provider 支持就自动进入共享契约。
