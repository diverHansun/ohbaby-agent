# 模块架构

## 代码目录结构

```
packages/ohbaby-agent/src/config/tools/
  index.ts                     # 门面：re-export getSearchConfig / reloadSearchConfig 等
  search/
    types.ts                   # Zod schema、SearchConfig 类型、SearchConfigError 类
    loaders.ts                 # loadSearchJson、getSearchJsonPath
    validation.ts              # validateSearchJson、validateApiKey（纯函数）
    manager.ts                 # SearchConfigManager 单例（缓存 + reload）
    index.ts                   # getSearchConfig / reloadSearchConfig / isSearchConfigCached
```

文件职责严格分层，与现有 `src/config/llm/` 一一对应：

| 层 | 文件 | 职责 | 不做的事 |
| --- | --- | --- | --- |
| Types | `types.ts` | Zod schema、TS 类型、错误类 | 不做 I/O |
| Loaders | `loaders.ts` | 读文件、解析 JSON、定位路径 | 不做校验、不解析 env |
| Validation | `validation.ts` | 校验 schema、校验 API key 存在 | 不做 I/O |
| Manager | `manager.ts` | 组装上述三层、缓存、热重载 | 不直接被消费者引用 |
| Public API | `index.ts` | 暴露 `getSearchConfig` 等函数 | 不暴露 Manager 类 |

## 与现有模块的关系

```
┌─────────────────────────────────────────────────────────┐
│  bin.ts                                                 │
│    ↓                                                    │
│  loadDotenvIntoProcessEnv(findProjectRoot())            │  ← 新增
│    ↓                                                    │
│  runOhbabyCli()                                         │
└─────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  src/adapters/ui-runtime/composition.ts                 │
│    ↓                                                    │
│  web 工具执行时 await getSearchConfig()                 │  ← 新增
│    ↓                                                    │
│  createBuiltinTools({                                   │
│    searchProvider: { loadConfig: async () => ... }      │
│  })                                                     │
└─────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  src/services/search-providers/registry.ts              │
│    createSearchProvider(config)  ← 只接收 config，不再     │
│                                    自己读文件 / env        │
└─────────────────────────────────────────────────────────┘
```

## 设计模式与理由

**单例 + 缓存**（沿用 LLM 模块）  
search.json 不会频繁变化；首次解析后缓存 `SearchConfig` 对象，`reloadSearchConfig()` 用于配置变更后的主动刷新。

**纯函数式 Public API**  
对外只暴露 `getSearchConfig()` / `reloadSearchConfig()` / `isSearchConfigCached()`，不暴露 `SearchConfigManager` 类。消费者只关心"拿到当前 config"。

**Fail Fast**  
schema 校验、API key 不存在等错误立即抛异常；不做"降级到默认值"或"返回 null"等模糊行为。**例外**：search.json 文件不存在不算错误（回退到默认 schema），因为模块设计为"零配置可用"。

**职责单一**  
本模块只负责"把磁盘 + 环境变量的搜索配置转成 `SearchConfig` 对象"。不创建 provider 实例（那是 `services/search-providers` 的职责）、不注册到 tool scheduler（那是 `tools/builtin.ts` 的职责）。

## 与 services 层的契约

`services/search-providers` 在重构后：

- 删除 `loadDefaultSearchProviderConfig()` 和 `loadProjectSearchEnv()`
- `createSearchProvider(config: SearchProviderConfig)` 签名不变，但调用方必须先拿到 `SearchConfig` 再调用
- `SearchProviderConfig` 的形状由 services 层定义，**config 模块负责把 `SearchConfig` 适配成它**（在 `tools/search/index.ts` 提供一个 thin adapter 函数，或直接在 composition 层装配）

这样切分的好处：

- services 层无副作用（无 I/O、无 env 访问），易测
- config 模块对 services 层的接口形状有依赖，但反向无依赖
- 未来新增 provider（如 exa）时：在 services 注册工厂，在 config schema 的 `provider` 枚举加值，两边解耦

## bin 入口的 .env 加载

`bin.ts` 在 `runOhbabyCli` 之前新增一次 `.env` 加载：

```typescript
import { config as loadDotenv } from "dotenv";
import { findProjectRoot } from "./utils/project-root.js";  // 新增工具

const projectRoot = findProjectRoot(import.meta.url);
loadDotenv({ path: path.join(projectRoot, ".env"), override: false });
```

- `findProjectRoot()` 从 bin.js 文件位置向上查找 `pnpm-workspace.yaml`；找不到则返回 `process.cwd()`
- `override: false` 保证已存在的 shell 环境变量优先于 `.env` 内容（不覆盖父进程注入）
- 加载失败（文件不存在）：dotenv 默认静默跳过，符合"零配置可用"的设计意图

`src/utils/project-root.ts` 是一个小工具函数，独立于 config 模块；config 模块本身**不**关心 `.env` 在哪里——它只读 `process.env`。
