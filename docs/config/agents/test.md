# config/agents 模块 test.md

本文档描述 `config/agents` 模块的测试范围与验证策略。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试关注以下职责的验证：

1. **配置文件加载**
   - 从全局路径（`~/.ohbaby/agents/settings.json`）读取配置
   - 从项目路径（`.ohbaby/agents/settings.json`）读取配置
   - 文件不存在时返回空配置

2. **配置合并**
   - 项目配置覆盖全局配置（同名 Agent 完全替换）
   - 不同名 Agent 合并到同一集合

3. **配置验证**
   - Zod Schema 格式验证
   - 类型正确性验证
   - 必填字段验证（如 subagent 必须有 description）

4. **错误处理**
   - JSON 解析错误时抛出 ConfigParseError
   - Schema 验证失败时抛出 ConfigValidationError
   - 文件权限错误时抛出 ConfigAccessError

### 不覆盖范围

以下内容不在本模块测试范围内：

- agents 模块的业务验证（工具存在性、权限合法性等）
- system-prompt 模块的提示词加载
- lifecycle 模块的 maxSteps 控制
- LLM 模型选择与切换

---

## 二、Critical Scenarios（关键场景）

### 2.1 配置加载场景

| 场景 | 输入 | 预期结果 |
|------|------|----------|
| 全局配置存在，项目配置不存在 | 仅全局配置文件 | 返回全局配置内容 |
| 项目配置存在，全局配置不存在 | 仅项目配置文件 | 返回项目配置内容 |
| 两者都存在 | 全局和项目配置 | 返回合并后的配置 |
| 两者都不存在 | 无配置文件 | 返回 `{ agents: {} }` |

### 2.2 配置合并场景

| 场景 | 全局配置 | 项目配置 | 预期结果 |
|------|----------|----------|----------|
| 同名覆盖 | `explore: { maxSteps: 15 }` | `explore: { maxSteps: 25 }` | `explore: { maxSteps: 25 }` |
| 不同名合并 | `explore: {...}` | `security: {...}` | 包含两个 Agent |
| 部分覆盖 | `explore: { maxSteps: 15, temp: 0.5 }` | `explore: { maxSteps: 25 }` | `explore: { maxSteps: 25 }`（temp 丢失） |

### 2.3 Schema 验证场景

| 场景 | 输入 | 预期结果 |
|------|------|----------|
| 有效配置 | 符合 Schema 的 JSON | 返回验证后的配置对象 |
| name 缺失 | `{ mode: "primary" }` | 抛出 ConfigValidationError |
| mode 无效值 | `{ name: "x", mode: "invalid" }` | 抛出 ConfigValidationError |
| subagent 缺少 description | `{ name: "x", mode: "subagent" }` | 抛出 ConfigValidationError |
| temperature 超范围 | `{ ..., temperature: 3.0 }` | 抛出 ConfigValidationError |
| 颜色格式错误 | `{ ..., color: "red" }` | 抛出 ConfigValidationError |
| model ID 格式错误 | `{ ..., model: "invalid" }` | 抛出 ConfigValidationError |

### 2.4 错误处理场景

| 场景 | 触发条件 | 预期结果 |
|------|----------|----------|
| JSON 语法错误 | 配置文件包含无效 JSON | 抛出 ConfigParseError，包含文件路径和错误位置 |
| Schema 验证失败 | 配置不符合 Schema | 抛出 ConfigValidationError，包含失败字段和原因 |
| 文件权限错误 | 无法读取配置文件 | 抛出 ConfigAccessError，包含文件路径 |

---

## 三、Integration Points（集成点测试）

### 3.1 与文件系统的集成

| 集成点 | 验证重点 | 失败时的预期行为 |
|--------|----------|------------------|
| 读取配置文件 | 正确解析 JSON 内容 | 文件不存在时返回空配置 |
| 文件权限 | 正确处理权限错误 | 抛出明确的 ConfigAccessError |
| 路径解析 | 正确处理 `~` 和相对路径 | 路径解析失败时抛出错误 |

### 3.2 与 agents 模块的集成

| 集成点 | 验证重点 | 失败时的预期行为 |
|--------|----------|------------------|
| loadAgentConfig 调用 | 返回类型正确的 AgentsConfig | 抛出的错误类型可被调用方捕获 |
| 配置数据传递 | 配置对象结构符合 agents 模块预期 | 类型不匹配时编译错误 |

### 3.3 与 config/llm 模块的关系

config/agents 模块不直接依赖 config/llm 模块。

模型参数（temperature、topP 等）在 agent 配置中是可选的：
- 设置时：覆盖 config/llm 的全局配置
- 未设置时：由 agents 模块从 config/llm 获取默认值

此逻辑由 agents 模块负责，不在 config/agents 测试范围内。

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试策略

**测试对象**：loadAgentConfig、loadFromPath、mergeConfigs、validateConfig

**模拟策略**：
- 模拟文件系统操作（fs.readFile、fs.access）
- 不模拟 Zod Schema（使用真实 Schema 验证）

**测试数据**：
- 准备标准测试配置文件（valid-config.json、invalid-config.json）
- 覆盖边界条件的测试数据（空对象、缺失字段、类型错误）

### 4.2 验证重点

| 验证类型 | 方式 | 说明 |
|----------|------|------|
| 格式验证 | 自动化测试 | Schema 验证的正确性 |
| 合并逻辑 | 自动化测试 | 配置覆盖规则的正确性 |
| 错误处理 | 自动化测试 | 错误类型和信息的准确性 |
| 类型安全 | TypeScript 编译 | 返回类型与接口定义一致 |

### 4.3 测试用例设计原则

1. **每个职责至少一个测试**
   - 配置加载：至少 4 个测试（四种文件存在组合）
   - 配置合并：至少 3 个测试（覆盖、合并、部分覆盖）
   - Schema 验证：每个字段的边界条件

2. **错误路径完整覆盖**
   - 每种错误类型至少一个测试
   - 错误信息的准确性验证

3. **边界条件测试**
   - 空配置文件
   - 空 agents 对象
   - 超长字符串
   - 特殊字符

### 4.4 测试环境要求

- 使用临时目录存放测试配置文件
- 测试完成后清理临时文件
- 不依赖用户真实的全局配置目录

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 测试范围与 goals-duty.md 中的职责对应
- [x] 集成点覆盖 dfd-interface.md 中描述的数据流
