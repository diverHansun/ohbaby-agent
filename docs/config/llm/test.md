# LLM 配置模块测试策略

## 测试范围

**覆盖的职责**：
- 从 model.json 加载配置
- 从环境变量读取 API Key
- 验证配置的完整性和有效性
- 缓存和热重载机制
- 错误情况的处理和报告

**不覆盖的内容**：
- 文件系统的底层行为（假设 fs 模块正确）
- Node.js 环境变量系统（假设 process.env 正确）
- 外部模块（llm-client、command）如何使用本模块的配置

## 关键场景

### 正常路径

1. **配置成功加载**：model.json 和 API Key 都有效，getLLMConfig() 返回完整的 LLMConfig
2. **缓存生效**：第一次调用加载，第二次调用返回缓存结果，不重复加载文件
3. **本地调试覆盖**：.ohbaby-agent.local/model.json 存在时优先使用，不存在时使用 ~/.ohbaby-agent/model.json
4. **热重载工作**：reloadLLMConfig() 清除缓存，下一次调用重新加载文件

### 错误路径

1. **model.json 不存在**：抛出 ConfigError，错误代码为 'FILE_NOT_FOUND'，错误信息指出路径
2. **model.json 格式无效**：抛出 ConfigError，错误代码为 'INVALID_JSON'，错误信息指出具体语法错误
3. **必填字段缺失**：抛出 ConfigError，错误代码为 'MISSING_FIELD'，错误信息列出缺失的字段
4. **字段值无效**：
   - temperature 不在 0-2 范围内 → ConfigError，错误代码为 'INVALID_TEMPERATURE'
   - maxTokens 为负数 → ConfigError，错误代码为 'INVALID_MAX_TOKENS'
5. **API Key 不存在**：环境变量未设置 → ConfigError，错误代码为 'MISSING_API_KEY'，错误信息指出哪个环境变量缺失
6. **API Key 为空**：环境变量设置但值为空 → ConfigError，错误代码为 'EMPTY_API_KEY'

### 边界情况

1. **temperature 为 0**：有效，表示完全确定性
2. **temperature 为 2**：有效，最高随机性
3. **maxTokens 为 1**：有效，最小值
4. **model.json 包含额外字段**：忽略额外字段，不报错
5. **连续调用 reloadLLMConfig()**：每次都清除缓存并重新加载，不出现竞态条件

## 集成点测试

### 与文件系统集成

- 能否正确读取不同位置的 model.json（~/.ohbaby-agent 和 .ohbaby-agent.local）
- 文件不存在时的错误处理
- 文件权限问题时的错误处理（如无读权限）

### 与环境变量集成

- 能否正确读取 process.env 中指定的 API Key
- 环境变量不存在时的错误处理
- 环境变量值为空字符串时的错误处理

### 与 llm-client 集成

- config/llm 返回的 LLMConfig 的所有字段都能被 llm-client 正确使用
- llm-client 无法从其他地方获取配置，必须依赖本模块的输出

## 验证策略

**单元测试**（isolation）：
- loaders.test.ts：测试 loadModelJson()、loadApiKey() 函数
  - 使用 mock 文件系统避免依赖真实文件
  - 使用 mock 环境变量
  - 验证返回值和错误情况

- validation.test.ts：测试 validateModelJson()、validateApiKey() 函数
  - 纯函数，易于单元测试
  - 测试所有字段的验证规则
  - 测试边界值和错误情况

- manager.test.ts：测试 LLMConfigManager 的缓存和热重载机制
  - 使用 mock 的 loaders 避免 I/O
  - 验证缓存是否生效
  - 验证 reload() 是否清除缓存
  - 验证单例机制

**集成测试**（integration）：
- integration.test.ts：测试完整流程（使用真实文件或完整 mock）
  - 设置真实 model.json 文件（或 mock）
  - 设置环境变量
  - 调用 getLLMConfig()，验证完整返回值
  - 修改 model.json，调用 reloadLLMConfig()，验证新值
  - 验证错误场景的完整流程

**测试环境**：
- 使用 Vitest 作为测试框架
- 使用 fixtures/ 目录存放 model.json 样本
- 使用 beforeEach/afterEach 清理环境变量和文件系统
- 不依赖全局状态，确保测试隔离

**无需自动化测试的部分**：
- 真实文件权限问题（可手工验证）
- 真实网络 I/O（API Key 有效性验证由 llm-client 负责）
