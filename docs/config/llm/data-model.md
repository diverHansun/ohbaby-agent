# LLM 配置模块数据模型

## 核心概念

### ModelJsonConfig

用户在 `~/.ohbaby-agent/model.json` 中定义的配置对象，包含模型和 API 配置信息。

字段：
- provider：LLM 提供商标识（如 'openai'、'zhipu'）
- defaultModel：要使用的模型名称（如 'gpt-4'）
- apiConfig：API 访问配置
  - baseUrl：API 服务的基础 URL
  - apiKeyEnv：指向哪个环境变量来读取 API Key（如 'OPENAI_API_KEY'）
- llmParams：LLM 运行参数
  - temperature：采样温度（0-2）
  - maxTokens：最大生成 token 数

### LLMConfig

经过加载、验证、合并后的最终配置对象，可直接用于 llm-client 模块。

字段：
- provider：提供商标识
- model：模型名称
- apiKey：实际的 API Key（从环境变量读取）
- baseUrl：API 基础 URL
- temperature：采样温度
- maxTokens：最大生成 token 数

**关键区别**：LLMConfig 中的 apiKey 是实际值，而 ModelJsonConfig 中的 apiKeyEnv 只是指针。

### ConfigError

配置相关的错误对象，包含：
- message：人类可读的错误信息
- code：机器可读的错误代码（如 'MISSING_API_KEY'、'INVALID_TEMPERATURE'）
- context：额外的诊断信息（可选）

## 生命周期与归属

**创建**：
- ModelJsonConfig：由用户手工编辑 model.json 创建
- LLMConfig：由 LLMConfigManager 加载、验证后创建

**更新**：
- 用户修改 model.json，通过 reloadLLMConfig() 触发重新加载
- 不支持程序修改

**销毁**：
- 当 reload() 被调用时，缓存的 LLMConfig 被清除
- 应用关闭时自动释放
