# LLM 配置模块架构

## 架构概览

LLM 配置模块由以下主要部分组成：

- **Loaders（加载层）**：负责从文件和环境变量读取原始配置数据
- **Validation（验证层）**：对配置进行格式、类型、值范围的检查
- **Manager（管理层）**：整合加载和验证，提供缓存、热重载等能力
- **Public API（接口层）**：对外暴露简洁的函数接口，隐藏内部实现

各部分协作流程：

```
getLLMConfig() 调用
  ↓
检查缓存 → 有效则返回
  ↓
loadModelJson() 读取 model.json
  ↓
loadApiKey() 读取环境变量中的 API Key
  ↓
validateModelJson() 验证 model.json 格式和内容
  ↓
validateApiKey() 验证 API Key 存在
  ↓
合并配置为 LLMConfig 对象
  ↓
缓存结果并返回
```

## 设计模式与理由

**单例模式（Singleton）**
- LLMConfigManager 作为单例存在，确保全局只有一份配置实例
- 避免多次加载配置文件，降低 I/O 成本

**Fail Fast 原则**
- 配置验证失败立即抛异常，不尝试降级或部分使用
- 理由：配置是系统前置条件，无法降级

**缓存策略**
- 首次加载后缓存配置对象，后续调用直接返回缓存
- 提供 reload() 方法主动清除缓存，支持热重载
- 理由：model.json 不会频繁变化，缓存降低 I/O；热重载支持运维需求

**函数式导出**
- 对外仅暴露 getLLMConfig() 和 reloadLLMConfig() 函数，不暴露 Manager 类
- 理由：隐藏实现细节，降低消费者的认知负担

## 模块结构与文件组织

```
src/config/llm/
├── types.ts          定义 LLMConfig、ModelJsonConfig、ConfigError 等类型
├── validation.ts     验证函数：validateModelJson()、validateApiKey() 等
├── loaders.ts        加载函数：loadModelJson()、loadApiKey() 等
├── manager.ts        LLMConfigManager 类（单例、缓存、热重载）
├── index.ts          公开接口导出：getLLMConfig()、reloadLLMConfig() 等
└── __tests__/
    ├── loaders.test.ts
    ├── manager.test.ts
    ├── validation.test.ts
    ├── integration.test.ts
    └── fixtures/      测试数据
```

各文件职责：

- **types.ts**：定义配置相关的类型和错误类，不包含实现逻辑
- **validation.ts**：纯函数式验证，无状态，易于单元测试
- **loaders.ts**：纯函数式加载，处理文件 I/O 和环境变量读取
- **manager.ts**：管理类，协调加载和验证，维护缓存状态
- **index.ts**：导出公开接口，隐藏实现类

## 架构约束与权衡

**权衡1：每次调用都从缓存读 vs 每次调用都重新加载**
- 选择：缓存 + 主动热重载
- 理由：model.json 不会自动变化，缓存提高性能；热重载支持运维需求
- 代价：内存中持有一份配置副本

**权衡2：同步加载 vs 异步加载**
- 选择：异步（async/await）
- 理由：加载和验证可能涉及文件 I/O，异步更符合 Node.js 最佳实践
- 代价：调用者需要 await

**权衡3：Fail Fast vs 可降级**
- 选择：Fail Fast
- 理由：配置无效时应用无法正常运行，降级无意义
- 代价：应用启动失败需要用户修复配置

**权衡4：单全局实例 vs 多实例允许**
- 选择：单全局实例（单例）
- 理由：配置通常是全局的、唯一的；避免多实例导致配置不一致
- 代价：无法同时运行多个配置实例（通常不需要）
