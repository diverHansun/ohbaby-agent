# LLM 配置模块数据流与接口

## 上下文与范围

本模块与以下外部模块交互：

- **文件系统**：读取 `~/.ohbaby-code/model.json` 和 `.ohbaby-code.local/model.json`
- **环境变量**：读取 `.env` 中指定的 API Key
- **llm-client 模块**：消费本模块提供的 LLMConfig
- **command 模块**：接收热重载触发命令

本文档描述配置如何加载、验证、暴露给消费者。

## 数据流描述

### 流程1：初始化配置加载

```
应用启动
  ↓
llm-client 调用 getLLMConfig()
  ↓
config/llm 检查内存缓存
  ├─ 缓存存在 → 返回
  └─ 缓存不存在 → 执行加载流程
    ↓
  检查 .ohbaby-code.local/model.json（本地调试覆盖）
    ├─ 存在 → 使用
    └─ 不存在 → 使用 ~/.ohbaby-code/model.json
    ↓
  解析 JSON，得到 ModelJsonConfig
    ↓
  从环境变量读取 API Key（根据 apiKeyEnv 指定）
    ↓
  验证 ModelJsonConfig（检查必填字段、类型、值范围）
    ↓
  验证 API Key（检查存在且非空）
    ↓
  如验证失败 → 抛出 ConfigError，流程终止
    ↓
  合并为 LLMConfig 对象
    ↓
  缓存到内存
    ↓
  返回 LLMConfig
```

### 流程2：热重载配置

```
用户通过 command 触发重载
  ↓
command 调用 reloadLLMConfig()
  ↓
config/llm 清除内存缓存
  ↓
重新执行初始化配置加载流程（同流程1）
  ↓
返回新的 LLMConfig
```

### 流程3：错误处理

```
任何加载/验证步骤失败
  ↓
生成 ConfigError（包含错误代码和诊断信息）
  ↓
抛出异常
  ↓
缓存状态不更新
  ↓
下一次调用 getLLMConfig() 时，缓存为空，会再次尝试加载
```

## 接口定义

### 接口1：getLLMConfig()

```typescript
async function getLLMConfig(): Promise<LLMConfig>
```

**语义**：获取当前有效的 LLM 配置

**输入**：无

**输出**：LLMConfig 对象，包含 provider、model、apiKey、baseUrl、temperature、maxTokens

**行为**：
- 第一次调用时从文件加载、验证、缓存
- 后续调用返回缓存结果
- 验证失败抛出 ConfigError

**适用场景**：应用启动时获取配置

### 接口2：reloadLLMConfig()

```typescript
async function reloadLLMConfig(): Promise<LLMConfig>
```

**语义**：清除缓存并重新加载配置

**输入**：无

**输出**：新加载的 LLMConfig 对象

**行为**：
- 清除内存中的缓存
- 重新从文件加载配置
- 验证失败抛出 ConfigError

**适用场景**：用户修改 model.json 后，通过 command 触发重载

## 数据归属与责任

| 数据 | 创建者 | 所有者 | 责任 |
|------|--------|--------|------|
| model.json | 用户 | 用户 | 用户负责创建和维护，config/llm 负责读取 |
| 环境变量 | 用户/CI系统 | 用户 | 用户/CI负责设置，config/llm 负责读取 |
| LLMConfig | config/llm | 消费者 | config/llm 生成，消费者负责使用；config/llm 在缓存清除时释放 |
| ConfigError | config/llm | 消费者 | config/llm 生成，消费者决定如何处理（如日志、重试等） |

**关键原则**：
- 配置是只读的，不支持修改
- config/llm 不会主动同步配置变化到其他模块
- 消费者需要在需要时主动调用 reloadLLMConfig()
