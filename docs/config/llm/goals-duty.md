# LLM 配置模块的目标与职责

## 设计目标

1. 为上层模块提供统一、可信的 LLM 配置接口
   - 消费者无需关心配置的加载、验证、缓存等细节

2. 支持配置热重载
   - 允许通过命令更新配置而无需重启应用

3. 及早失败并提供清晰的错误信息
   - 配置无效时立即抛异常，防止应用以错误配置运行
   - 错误信息应指出具体问题位置和原因

## 职责

1. 从配置文件加载 LLM 配置
   - 从 `~/.ohbaby-agent/model.json` 读取模型和API配置
   - MVP 不实现 `.ohbaby-agent.local/model.json` 本地覆盖，避免文档与运行时行为不一致

2. 从环境变量加载 API Key
   - 父进程环境变量优先；缺失时解析当前项目 `.env` 作为补充
   - 解析 `.env` 不修改全局 `process.env`，避免跨项目污染
   - 根据 model.json 中指定的环境变量名读取 API Key
   - 验证 API Key 存在且非空

3. 验证配置完整性和有效性
   - 检查必填字段（provider、defaultModel、apiConfig、llmParams等）
   - 验证字段类型和值范围（如 temperature 在 0-2 之间）
   - 验证 model.json 文件格式有效

4. 合并来自不同源的配置
   - 将 model.json 和 .env 中的信息合并为统一的 LLMConfig 对象

5. 提供配置缓存机制
   - 首次加载后缓存配置，减少重复的文件 I/O
   - 提供 reload() 方法清除缓存并重新加载

6. 导出简洁的公开接口
   - 提供 getLLMConfig() 便利函数
   - 提供 reloadLLMConfig() 用于热重载
   - 不暴露内部实现类（如 LLMConfigManager）

## 非职责

1. 不管理其他类型的配置
   - 如 tokenCounting、turn 等其他模块的配置由其各自负责

2. 不进行配置值的业务级决策
   - 如选择使用哪个模型、如何调整温度等决策不属于本模块
   - 本模块仅负责加载和验证，消费者决定使用方式

3. 不持久化或修改配置文件
   - 配置是只读的，不支持 setLLMConfig() 等写入操作
   - 用户需要直接编辑 model.json 来改变配置

4. 不对应用全局状态负责
   - 不会自动同步到其他模块
   - 消费者需要在适当时机调用 getLLMConfig() 或 reloadLLMConfig()

5. 不进行 Token 使用统计或成本计算
   - Token 相关逻辑由 tokenCounting 模块负责

6. 不创建 LLM SDK 实例
   - 不直接 import openai 或其他厂商 SDK
   - 当前由 `core/llm-client.createLLMClient()` 根据 `LLMConfig` 创建 OpenAI-compatible client
   - 本模块仅提供 `LLMConfig` 数据，不感知调用方如何使用这些配置

7. 不感知 provider 的协议差异
   - 配置中的 `provider` 字段当前只是字符串标识（如 `openai`、`zhipu`）
   - 本模块不会根据 provider 推断消息协议、工具调用协议或 SDK 类型
   - 当前校验只保证 `provider` 是非空字符串，不校验它是否已经在某个运行时注册表中实现

## 与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| core/llm-client | 被依赖 | `createLLMClient()` 直接调用 `getLLMConfig()` 创建当前的 OpenAI-compatible client |
| services/providers | 已实现 | `core/llm-client` 当前会把本模块输出拆分为连接级配置并传给 `createProvider()` |
| config/mcp、config/agents | 并列 | 同为 config/ 下的子模块，schema-loading-validation 模式一致
