# 内置工具配置模块（tools/）实施文档

本目录是 `src/config/tools/` 模块的实施级规格，配套代码重构落地。  
高层愿景／背景请看父目录的设计文档；本目录只回答"具体怎么改、怎么测、怎么迁移"。

## 模块边界（务必先看）

本模块**只**处理：

- 内置工具中"需要外部网络服务 + API Key"的那一类工具的配置

本模块**不**处理：

- MCP 服务器配置 → `src/config/mcp/`
- Skills 配置 → `src/config/agents/`（或后续独立模块）
- 内置工具的行为参数（如 bash 的 shell path、grep 的默认上限等）→ 应放在各自模块或不需要持久化配置
- LLM provider 的 key → `src/config/llm/`

当前覆盖范围：**仅 web_search 工具的 Tavily provider**。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [schema.md](schema.md) | `search.json` 字段、类型、默认值、错误码 |
| [architecture.md](architecture.md) | 代码模块结构、文件职责、与 services 层的边界 |
| [dfd-interface.md](dfd-interface.md) | 数据流（`.env` → `process.env` → `getSearchConfig()` → 工具）、公开 API |
| [migration.md](migration.md) | 从现状到目标的迁移清单 |
| [test.md](test.md) | 单元 / 契约 / 集成测试覆盖矩阵 |

## 决策摘要

| 项 | 取值 | 理由 |
| --- | --- | --- |
| 配置文件路径 | `~/.ohbaby/tools/search.json` | 采用 opencode 风格的分离组织；tools 配置集中在 `tools/` 目录下 |
| API Key 存储方式 | 仅声明 `apiKeyEnv` 字段，key 本身不入文件 | 沿用 `model.json` 约定；配置文件可入 git |
| `.env` 加载方式 | bin 入口一次性灌入 `process.env`（opencode 模式） | 解决 pnpm filter 切换 cwd 导致 `.env` 找不到的根因；统一全局唯一来源 |
| 项目根目录定位 | 向上查找 `pnpm-workspace.yaml` | 适配 monorepo 启动场景 |
| 无 `search.json` 时 | 回退到默认值 `{provider: "tavily", apiKeyEnv: "TAVILY_API_KEY"}` | 用户只设环境变量也能用，不强制配置文件 |
| LLM 模块 `loadProjectEnv` | 本次一并删除 | bin 已统一加载 `.env`，原函数变成死代码 |

## 一分钟上手示例

**配置（可选，仅当需要覆盖默认值时）**：

```jsonc
// ~/.ohbaby/tools/search.json
{
  "provider": "tavily",
  "apiKeyEnv": "TAVILY_API_KEY",
  "baseUrl": "https://api.tavily.com",
  "defaults": {
    "searchDepth": "basic",
    "maxResults": 5,
    "topic": "general",
    "timeout": 60
  }
}
```

**环境变量（必需）**：

```dotenv
# 项目根目录的 .env
TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxx
```

**消费方**：

```typescript
import { getSearchConfig } from "@/config";

const config = await getSearchConfig();
// → { provider: "tavily", apiKey: "tvly-...", baseUrl: "...", defaults: {...} }
```
