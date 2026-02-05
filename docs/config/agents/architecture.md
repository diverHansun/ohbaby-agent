# config/agents 模块 architecture.md

本文档描述 `config/agents` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

config/agents 是 iris-code 配置系统的一部分，专门负责 Agent 配置的加载和验证。它遵循与 config/mcp 相同的设计模式，保持配置加载逻辑的独立性和纯净性。

### 核心架构

```
config/agents/
├── types.ts              # 类型定义和 Zod Schema
├── loaders.ts            # 配置文件加载逻辑
├── index.ts              # 公开接口导出
└── __tests__/
    ├── loaders.test.ts   # 加载器单元测试
    └── validation.test.ts # Schema 验证测试
```

### 数据流向

```
1. loadAgentConfig() 被调用
   |
   v
2. 加载全局配置文件 (~/.iris-code/agents/settings.json)
   |
   v
3. 加载项目配置文件 ({project}/.iris-code/agents/settings.json)
   |
   v
4. 合并配置（项目覆盖全局）
   |
   v
5. Zod Schema 验证
   |
   v
6. 返回 AgentsConfig 对象
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 函数式加载模式

采用纯函数式加载而非单例类管理器。

```typescript
// 函数式模式（采用）
export async function loadAgentConfig(): Promise<AgentsConfig>

// 而非单例模式
class AgentConfigManager {
  private static instance: AgentConfigManager
  private cache: AgentsConfig
}
```

**理由**：
- 配置加载不需要状态管理
- 缓存由调用方（agents 模块）根据业务需要控制
- 更简单、更易测试
- 与 config/mcp 的设计模式保持一致

### 2.2 Zod Schema 优先验证

使用 Zod 进行声明式验证，而非手动校验。

**理由**：
- 类型安全：TypeScript 类型自动从 Schema 推导
- 及早失败：配置错误在加载阶段就被发现
- 清晰的错误信息：Zod 自动生成详细的验证错误
- 可维护：Schema 即文档，修改配置结构只需修改 Schema

### 2.3 分层合并策略

全局配置和项目配置分别加载后合并。

```typescript
const globalConfig = await loadFromPath(globalPath)
const projectConfig = await loadFromPath(projectPath)
return mergeConfigs(globalConfig, projectConfig)
```

**理由**：
- 全局配置作为默认值，减少项目配置的冗余
- 项目配置可以覆盖全局配置，保持灵活性
- 清晰的优先级：项目 > 全局

### 2.4 未使用的模式

**未使用单例模式**：
- 配置加载是无状态操作
- 缓存由调用方控制
- 避免全局状态带来的测试困难

**未使用观察者模式**：
- 当前不需要配置热更新
- 保持简单（YAGNI 原则）

---

## 三、Module Structure & File Layout（模块结构与文件组织）

### 3.1 文件职责

#### types.ts

职责：定义配置相关的所有类型和 Schema

内容：
- `AgentConfig`：单个 Agent 的配置类型
- `AgentsConfig`：完整配置对象（包含所有 Agent）
- `AgentMode`：代理模式枚举
- `PermissionValue`：权限值枚举
- `ToolsConfig`：工具配置类型
- `PermissionConfig`：权限配置类型
- 对应的 Zod Schema 定义

#### loaders.ts

职责：实现配置文件的加载和合并逻辑

导出函数：
- `loadAgentConfig()`：主入口，加载并合并配置
- `loadFromPath(path)`：从指定路径加载单个配置文件
- `mergeConfigs(global, project)`：合并多个配置对象

#### index.ts

职责：对外导出公开接口

导出内容：
- `loadAgentConfig` 函数
- 所有类型定义（AgentConfig、AgentsConfig 等）
- 不导出内部实现细节（loadFromPath、mergeConfigs 等）

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 4.1 不做配置缓存

**当前方案**：每次调用 loadAgentConfig() 都重新读取文件

**代价**：
- 重复的文件 I/O 开销
- 无法感知配置热更新

**收益**：
- 实现简单，代码量少
- 避免缓存失效问题
- 调用方可以根据需要自行缓存

**理由**：
- Agent 配置加载频率低（启动时加载一次，切换 agent 时可能重新加载）
- 文件 I/O 开销可接受（约 10ms）
- 遵循 YAGNI 原则，避免过度设计

### 4.2 仅支持 JSON 格式

**当前方案**：仅支持 settings.json

**未采用方案**：同时支持 JSON 和 TOML/YAML

**理由**：
- JSON 是 TypeScript 原生支持的格式
- 与 iris-code 其他配置保持一致（mcp/settings.json）
- 额外格式需要引入解析依赖
- 可在未来根据需求扩展其他格式支持

### 4.3 同名 Agent 完全替换

**当前方案**：项目配置中的 Agent 完全替换全局配置中的同名 Agent

**未采用方案**：字段级别的深度合并

```typescript
// 采用方案：完全替换
global: { build: { maxSteps: 50, temperature: 0.7 } }
project: { build: { maxSteps: 30 } }
result: { build: { maxSteps: 30 } }  // 完全替换，temperature 丢失

// 未采用方案：深度合并
result: { build: { maxSteps: 30, temperature: 0.7 } }  // 保留未覆盖字段
```

**理由**：
- 完全替换逻辑更简单、更可预测
- 用户如需自定义某个 Agent，应提供完整配置
- 避免深度合并带来的"配置来源不明"问题
- 与 config/mcp 的合并策略保持一致

### 4.4 单文件配置

**当前方案**：所有 Agent 配置在同一个 settings.json 中

**未采用方案**：每个 Agent 一个独立文件

```
# 采用方案
agents/
└── settings.json  # 包含所有 Agent

# 未采用方案
agents/
├── build.json
├── plan.json
├── explore.json
└── custom-agent.json
```

**理由**：
- 单文件更便于管理和版本控制
- 减少文件 I/O 次数
- Agent 配置通常较小，不需要分文件
- 用户可以一目了然看到所有配置

---

## 五、Error Handling（错误处理）

### 5.1 错误类型

| 错误场景 | 处理方式 |
|----------|----------|
| 配置文件不存在 | 返回空配置，不报错 |
| JSON 解析失败 | 抛出 ConfigParseError |
| Schema 验证失败 | 抛出 ConfigValidationError |
| 文件读取权限问题 | 抛出 ConfigAccessError |

### 5.2 错误信息格式

```typescript
// Schema 验证失败时的错误信息示例
ConfigValidationError: Invalid agent configuration
  Path: agents.build.maxSteps
  Expected: number
  Received: string ("fifty")
  File: /Users/xxx/.iris-code/agents/settings.json
```

---

## 六、扩展预留点

虽然当前版本不实现，但架构预留了以下扩展点：

| 扩展功能 | 预留方式 |
|----------|----------|
| TOML 格式支持 | 可在 loadFromPath 中添加格式检测和解析 |
| 配置热更新 | 可添加 watchConfig() 函数，基于 fs.watch |
| 配置缓存 | 可在 agents 模块中添加缓存层 |
| 远程配置 | 可扩展 loadFromPath 支持 HTTP URL |

---

## 七、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构足够简单，与 config/mcp 保持一致
