# config/agents 模块 goals-duty.md

本文档定义 `config/agents` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：config/agents 是 iris-code 配置系统的一部分，专门负责 Agent 配置文件的加载、验证和合并，为 agents 模块提供类型安全的配置数据。

**如果没有这个模块**：
- agents 模块需要自行处理文件读取和 JSON 解析
- 配置验证逻辑与业务逻辑耦合
- 全局配置和项目配置的合并策略难以统一维护
- 与 config/mcp、config/llm 的设计模式不一致

---

## 二、Design Goals（设计目标）

### G1: 与现有 config 模块保持一致

遵循与 config/mcp、config/llm 相同的设计模式：
- 函数式加载（非单例类）
- Zod Schema 验证
- 分层配置合并（全局 + 项目）

### G2: 类型安全

通过 Zod Schema 定义配置结构，在编译时和运行时都能保证配置类型正确。配置加载后返回强类型的 TypeScript 对象。

### G3: 配置与业务分离

本模块只负责配置的"收集与验证"，不涉及 Agent 的业务逻辑（如提示词组装、子代理执行、工具验证等）。

### G4: 错误明确

配置加载失败时提供清晰的错误信息，包括：
- 文件路径
- 验证失败的具体字段
- 期望的数据类型或格式

---

## 三、Duties（职责）

### D1: 加载配置文件

从指定路径加载 Agent 配置文件：
- 全局配置：`~/.iris-code/agents/settings.json`
- 项目配置：`{project}/.iris-code/agents/settings.json`

### D2: 验证配置格式

使用 Zod Schema 验证配置文件的格式：
- 字段类型检查（string、number、boolean 等）
- 枚举值检查（mode、permission 等）
- 必填字段检查
- 格式约束检查（如 color 必须是十六进制颜色）

### D3: 合并配置

将全局配置和项目配置按策略合并：
- 项目配置覆盖全局配置（同名 Agent 完全替换）
- 不同名 Agent 合并到同一集合

### D4: 导出类型定义

导出配置相关的 TypeScript 类型，供 agents 模块使用：
- `AgentConfig`：单个 Agent 的配置类型
- `AgentsConfig`：完整配置对象类型

---

## 四、Non-Duties（非职责）

### N1: 不负责内置 Agent 定义

内置 Agent（build、plan、explore、research）的默认配置由 agents 模块在代码中定义，不由本模块管理。

### N2: 不负责提示词加载

Agent 的系统提示词由 system-prompt 模块管理，本模块不处理任何提示词内容。

### N3: 不负责业务验证

以下验证由 agents 模块负责，不在本模块范围内：
- 工具名称是否存在（tools.include/exclude 中的工具名）
- 权限配置是否与 Policy 模块兼容
- model 字段指定的模型是否存在

### N4: 不负责配置缓存

配置的缓存策略由调用方（agents 模块）决定。本模块每次调用都重新读取文件。

### N5: 不负责配置热更新

本模块不监听配置文件变化。如需重新加载配置，需要调用方主动调用加载函数。

### N6: 不负责 IRIS.md 加载

用户自定义指令文件（IRIS.md）由 system-prompt 模块负责加载，不在本模块范围内。

---

## 五、设计约束与假设

### 约束

1. **配置格式**：仅支持 JSON 格式（settings.json）
2. **文件编码**：UTF-8
3. **配置路径固定**：不支持自定义配置文件路径
4. **单文件配置**：所有 Agent 配置在同一个 settings.json 中

### 假设

1. 文件系统可正常读取配置文件
2. 配置文件大小合理（通常不超过 100KB）
3. 调用方会正确处理加载失败的情况
4. agents 模块会在加载后进行业务验证

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| agents | 被依赖 | agents 模块调用 loadAgentConfig() 获取配置 |
| config/mcp | 同级 | 遵循相同的设计模式 |
| config/llm | 同级 | 遵循相同的设计模式 |
| system-prompt | 无关 | 不处理提示词 |
| lifecycle | 无关 | 不直接交互 |

### 依赖图

```
agents 模块
    |
    +-- config/agents (配置加载)
    |       |
    |       +-- Zod (Schema 验证)
    |       +-- fs (文件读取)
    |
    +-- system-prompt (提示词组装)
    +-- lifecycle (执行循环)
```

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
