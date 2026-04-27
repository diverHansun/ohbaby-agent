# LLM 配置模块文档

本目录包含 LLM 配置模块（`src/config/llm`）的完整设计文档。

## 文档导航

- **[goals-duty.md](goals-duty.md)**：模块的设计目标与职责边界
- **[architecture.md](architecture.md)**：模块的内部结构和设计决策
- **[data-model.md](data-model.md)**：核心数据概念的定义
- **[dfd-interface.md](dfd-interface.md)**：数据流和对外接口
- **[test.md](test.md)**：测试策略和验证方式

## 快速了解

### 模块职责

LLM 配置模块负责：
1. 从 `~/.ohbaby-agent/model.json` 加载 LLM 配置
2. 从 `.env` 读取 API Key
3. 验证配置的完整性和有效性
4. 支持配置缓存和热重载

### 公开接口

业务层通过以下接口使用本模块：

```typescript
import { getLLMConfig, reloadLLMConfig } from '@/config';

// 获取配置
const config = await getLLMConfig();

// 热重载配置
const newConfig = await reloadLLMConfig();
```

### 数据流

```
用户编辑 ~/.ohbaby-agent/model.json
            ↓
调用 getLLMConfig()
            ↓
加载、验证、缓存配置
            ↓
返回 LLMConfig 对象
            ↓
llm-client 消费配置
```

### 配置文件位置

- **用户全局配置**：`~/.ohbaby-agent/model.json`（由用户创建和维护）
- **本地调试覆盖**：`.ohbaby-agent.local/model.json`（可选，.gitignore 排除）
- **API Keys**：`.env`（项目级，.gitignore 排除）

### 错误处理

配置加载或验证失败时抛出 `ConfigError`，包含：
- message：人类可读的错误说明
- code：机器可读的错误代码（如 'MISSING_API_KEY'）
- context：额外的诊断信息

应用应在启动时捕获和处理这个错误。

## 后续扩展

本模块的设计支持未来添加其他配置类型（如 tokenCounting、turn 等），每个类型都遵循相同的架构模式。
