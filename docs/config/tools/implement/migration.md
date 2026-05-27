# 从现状到目标的迁移清单

> 本文档列出从"搜索工具因 cwd 错位读不到 .env"到"集中式 config/tools/search 模块"的逐步重构步骤。

## 现状回顾

- `.env` 文件位于项目根 `D:\Projects\Code-cli\ohbaby-agent\.env`
- `pnpm start` → `pnpm --filter ohbaby-agent start` → `node dist/bin.js`，此时 `process.cwd()` 被切换到 `packages/ohbaby-agent/`，根目录 `.env` 不被读取
- `services/search-providers/registry.ts` 自己实现了一份 `loadProjectSearchEnv()`，调用 `process.cwd()` 读 `.env`，因此搜索工具拿不到 `TAVILY_API_KEY`
- `config/llm/loaders.ts` 也有一份 `loadProjectEnv()`，逻辑相似；之所以 LLM 还能工作，是因为 `ZAI_API_KEY` 已通过 shell 注入到 `process.env`

## 目标状态

- `bin.ts` 启动时一次性将根目录 `.env` 加载到 `process.env`
- 所有下游模块（包括 LLM 和搜索）只读 `process.env`
- 新增 `src/config/tools/search/`，封装搜索配置的加载 / 校验 / 缓存
- 删除 `services/search-providers/registry.ts` 中的 `loadDefaultSearchProviderConfig` / `loadProjectSearchEnv`
- 删除 `config/llm/loaders.ts` 中的 `loadProjectEnv`，简化 `manager.ts`
- 在 composition 层显式注入 `getSearchConfig()` loader 到 `createBuiltinTools`

## 步骤清单

### 步骤 1：新增项目根定位工具

文件：`packages/ohbaby-agent/src/utils/project-root.ts`

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

export function findProjectRoot(startFromFileUrl: string): string {
  let dir = path.dirname(fileURLToPath(startFromFileUrl));
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd(); // 走到根仍未找到
    dir = parent;
  }
}
```

- 配套单元测试：`project-root.unit.test.ts`，验证三种情形（找到 / 找不到 / 嵌套）

### 步骤 2：bin.ts 加载 .env

修改 `packages/ohbaby-agent/src/bin.ts` 顶部：

```typescript
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { findProjectRoot } from "./utils/project-root.js";

const projectRoot = findProjectRoot(import.meta.url);
loadDotenv({ path: path.join(projectRoot, ".env"), override: false });
```

- `override: false`：保留父进程 shell 已有的环境变量优先级
- 文件不存在时 dotenv 静默跳过，不报错

### 步骤 3：新建 src/config/tools/search/ 模块

按 [architecture.md](architecture.md) 的目录结构创建 5 个文件。  
关键点：

- `types.ts`：Zod schema、`SearchConfig` 接口、`SearchConfigError` 类
- `loaders.ts`：只做"读文件 + JSON.parse"和"路径定位"
- `validation.ts`：纯函数，输入 unknown 输出 `SearchJsonConfig`（已校验过的）
- `manager.ts`：仿 `llm/manager.ts` 写 Singleton，含 `cachedConfig`、`load`、`reload`
- `index.ts`：暴露 `getSearchConfig` 等

### 步骤 4：建立 config/tools/index.ts 门面

```typescript
// src/config/tools/index.ts
export * from "./search/index.js";
```

并在 `src/config/index.ts` 加入：

```typescript
export {
  getSearchConfig,
  reloadSearchConfig,
  isSearchConfigCached,
  SearchConfigError,
} from "./tools/index.js";

export type {
  SearchConfig,
  SearchConfigLoadOptions,
  SearchConfigErrorCode,
} from "./tools/index.js";
```

### 步骤 5：重构 services/search-providers

修改 `packages/ohbaby-agent/src/services/search-providers/registry.ts`：

- **删除**：`loadDefaultSearchProviderConfig` 函数
- **删除**：`loadProjectSearchEnv` 函数
- **删除**：模块顶部 `import { parse as parseDotenv } from "dotenv";` 和 `readFileSync` 引入
- **保留**：`createSearchProvider(config)` 和 `registerSearchProvider`
- **保留**：`providerFactories` 注册表

修改 `services/search-providers/index.ts`：

- 删除 `loadDefaultSearchProviderConfig` 的 re-export

### 步骤 6：composition 层注入配置

修改 `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`（当前在第 578 行附近）：

```typescript
import { getSearchConfig } from "../../config/index.js";

// ...
for (const tool of createBuiltinTools({
  agentTaskController,
  taskExecutor,
  searchProvider: {
    loadConfig: async () => toServicesConfig(await getSearchConfig()),
  },
})) {
  toolScheduler.register(tool);
}
```

`toServicesConfig` 适配函数放在 `src/config/tools/search/index.ts`（或 composition 局部）—— migration 阶段两选一都可，推荐放 config 模块以便复用。

### 步骤 7：清理 LLM 模块

修改 `packages/ohbaby-agent/src/config/llm/loaders.ts`：

- **删除** `loadProjectEnv` 函数和 `ProjectEnv` 类型
- **删除** `parseDotenv` import 和 `ENV_FILE_NAME` 常量
- **简化** `loadApiKey`：去掉 `projectEnv` 参数，只读 `process.env`

```typescript
export function loadApiKey(envVarName: string): string | undefined {
  return process.env[envVarName];
}
```

修改 `packages/ohbaby-agent/src/config/llm/manager.ts`：

- 在 `performLoad` 中删除 `loadProjectEnv` 相关分支：

```typescript
const apiKey = loadApiKey(apiKeyEnvName);
```

- `LLMConfigLoadOptions` 中的 `projectDirectory` 字段保留（仍可用于测试），但不再传给 loaders

### 步骤 8：更新相关测试

详见 [test.md](test.md)。要点：

- 删除原 `services/search-providers/__tests__/registry.unit.test.ts` 中针对 `loadDefaultSearchProviderConfig` 的测试用例
- 新增 `src/config/tools/search/__tests__/{loaders,validation,manager}.unit.test.ts`
- LLM 模块测试中删除涉及 `.env` 文件读取的用例（保留 process.env 测试）
- 新增 `src/utils/__tests__/project-root.unit.test.ts`

### 步骤 9：更新 .env.example

把 `.env.example` 中的内容补全为本项目实际需要的变量：

```dotenv
# LLM provider key (currently zhipu/zai)
ZAI_API_KEY=your_zhipu_api_key_here

# Web search provider key
TAVILY_API_KEY=your_tavily_api_key_here
```

并删除现有 .env.example 中过时的 `OPENAI_API_KEY`、`GOOGLE_AI_API_KEY` 等条目。

## 验证步骤

1. `pnpm typecheck` 通过
2. `pnpm lint` 通过
3. `pnpm test` 通过
4. 手测：
   - 在项目根 `.env` 中保留 `TAVILY_API_KEY=...`
   - `pnpm start`
   - 让 agent 调用 web_search，应能正常返回搜索结果
5. 删除 `.env` 中的 `TAVILY_API_KEY` 行（保留 `ZAI_API_KEY`）
   - 再次启动并触发 web_search，应抛 `SearchConfigError(MISSING_API_KEY)` 并提示用户哪个环境变量缺失

## 顺序约束

- 步骤 1、3 可并行
- 步骤 2 依赖步骤 1
- 步骤 4 依赖步骤 3
- 步骤 5 依赖步骤 3、4
- 步骤 6 依赖步骤 4、5
- 步骤 7 依赖步骤 2（bin 已加载 .env 才能安全删除 LLM 的 loadProjectEnv）
- 步骤 8 与每个对应步骤同步进行（TDD）
- 步骤 9 任意时刻可改

## 兼容性影响

- **公开 API 新增**：`getSearchConfig` 等，对现有消费者无破坏
- **公开 API 删除**：`services/search-providers` 的 `loadDefaultSearchProviderConfig`、`LoadDefaultSearchProviderConfigOptions` 在重构后不再导出
- **配置文件**：用户**无需**创建 `tools/search.json`，原有 `.env` 加 `TAVILY_API_KEY` 的方式继续工作
- **行为变化**：`.env` 解析时机从"每次工具调用"提前到"程序启动"；副作用：`process.env` 会被 dotenv 修改（之前 LLM 模块刻意避免）
