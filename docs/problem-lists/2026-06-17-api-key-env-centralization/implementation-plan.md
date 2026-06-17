# 实施修改 / 优化方案

总原则：配置文件（model.json / search.json / mcp/settings.json）只存“键名 + 非密钥配置”，
真实 api-key 统一写入全局 `~/.ohbaby-agent/.env`；提供交互入口免去手改文件。

按批次推进。批次一交付后即可解决用户当前痛点；批次二统一 MCP。

---

## 批次一

### 任务 A：LLM API Key 首次写入即落到全局 .env

#### A0. 抽出共享的“全局 .env secret 写入”工具（新建）

新建 `packages/ohbaby-agent/src/config/secrets/env-secrets.ts`，导出：

```ts
export async function writeGlobalEnvSecret(key: string, value: string): Promise<string>;
// 内部：getGlobalEnvPath() -> 读现有内容 -> setEnvFileValue(content, key, value) -> 原子写 -> 返回 envPath
```

- 复用 `packages/ohbaby-agent/src/config/llm/env-file.ts:29`（`setEnvFileValue`，纯字符串处理）。
- 复用 `packages/ohbaby-agent/src/utils/project-env.ts:20`（`getGlobalEnvPath`）。
- 原子写沿用 `writer.ts` 中 `writeFileAtomically` 的 tmp + rename 思路（可一并提取到此模块共享）。
- 目的：LLM（任务 A）与搜索（任务 B）共用同一套写入逻辑，避免重复。

#### A1. 核心行为变更（默认落盘改为全局）

文件 `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts:64`：

```ts
// 现在
const envPath = input.envPath ?? path.join(input.projectRoot, ".env");
// 改为
const envPath = input.envPath ?? getGlobalEnvPath();
```

- 该 `envPath` 同时驱动三处：写 key（`writer.ts:204-205`）、未重填 key 时回读
  （`apply-active-model-config.ts:66-70`）、写后 reload（`:114-118`）。改默认值即统一指向全局。
- 保留 `:111` 的 `process.env[apiKeyEnv] = input.apiKey`，保证当轮即时生效。
- “首次写入”问题随之解决：因为不再依赖项目目录是否已有 `.env`，统一写全局，文件不存在则按
  `writer.ts:184`（`fs.mkdir(dirname, { recursive: true })`）自动创建目录与文件。

#### A2. 兜底一致性（建议）

`packages/ohbaby-agent/src/config/llm/writer.ts:192-194` 的 fallback 由
`path.join(process.cwd(), ".env")` 改为 `getGlobalEnvPath()`，与 A1 语义统一。
（当前流程总会显式传 envPath，此项仅防未来误用。）

#### A3. 回显落盘路径

连接成功结果已含 `envPath`（`apply-active-model-config.ts:132`、面板读取见
`connect-panel.tsx` 的 `readConnectWarning` 同款机制）。在面板 saved 状态附带提示
“saved to ~/.ohbaby-agent/.env”，消除“没持久化”的误解。

#### A4. 不改动项

- 运行时读取路径 `packages/ohbaby-agent/src/core/llm-client/client.ts:51` 保持不变。
- `loadRuntimeEnvIntoProcessEnv` 已加载全局 `.env`，新进程可读到 key，无需改启动逻辑。
- 旧用户残留在项目 `.env` 的 key 不受影响（仍被读入 `process.env`）。

---

### 任务 B：新增 /connect-search 命令与面板（Tavily key 落全局 .env）

镜像 `/connect` 链路，新增一条平行的 `setSearchApiKey` 通路。

#### B1. 配置写入（新建 search writer）

新建 `packages/ohbaby-agent/src/config/tools/search/writer.ts`，导出
`setSearchApiKey(input: { apiKey: string; apiKeyEnv?: string; provider?: "tavily" })`：

- 解析 `apiKeyEnv`（缺省 `TAVILY_API_KEY`，见 `types.ts:44`）。
- 调 `writeGlobalEnvSecret(apiKeyEnv, apiKey)`（任务 A0）写全局 `.env`。
- 若 `~/.ohbaby-agent/tools/search.json` 不存在则创建一份最小配置（写入 `provider` 与
  `apiKeyEnv` 键名，不写真实 key），保证 search.json 的键名与 `.env` 对齐。
- 同步设置 `process.env[apiKeyEnv]`，当轮即时生效。
- 返回 `{ apiKeyEnv, provider, envPath, searchJsonPath }`（不回传明文 key）。

#### B2. SDK 契约（新增类型与方法）

- 新建 `packages/ohbaby-sdk/src/connect-search.ts`（仿 `connect-model.ts`）：定义
  `UiSetSearchApiKeyInput`（`apiKey`、可选 `apiKeyEnv`、可选 `provider`）
  与 `UiSetSearchApiKeyResult`（`apiKeyEnv`、`provider`、`envPath`、`searchJsonPath`）。
- `packages/ohbaby-sdk/src/index.ts`：再导出上述类型（仿 `:19-21` 对 connect-model 的导出）。
- `packages/ohbaby-sdk/src/client.ts`（`CoreAPI`，:43 旁）新增
  `setSearchApiKey(input: UiSetSearchApiKeyInput): Promise<UiSetSearchApiKeyResult>`，并 import 新类型（仿 :15-16）。
- `packages/ohbaby-sdk/src/rpc/types.ts`（`UiBackendClient`，:35 旁）同步新增同名方法，import 新类型（仿 :19-20）。

#### B3. daemon JSON-RPC 透传

- `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts`：方法白名单加 `"setSearchApiKey"`。
- `packages/ohbaby-server/src/protocols/jsonrpc/client.ts`：新增代理方法（仿 `:171-174`）与
  CoreAPI 包装（仿 `:397-398`）。
- `packages/ohbaby-server/src/runtime/daemon/server.ts`：新增 dispatch case（仿 `:230-232`）。

#### B4. backend 实现与接线

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`：新增 `setSearchApiKeyInternal`，
  调任务 B1 的 `setSearchApiKey`；写后调用现有 search 配置失效 / reload（参照 LLM 的
  `runtimeController.resetRuntime()` 思路，确保搜索工具拿到新 key）。挂到 commandService 与导出对象。
- `packages/ohbaby-agent/src/adapters/ui-persistent.ts`：转发 `setSearchApiKey`。
- `packages/ohbaby-agent/src/host/core-api-factory.ts`：在 core 对象上接线（仿 `:76-78`）。

#### B4 补充：保存后的生效机制（无需 resetRuntime）

`web_search` 工具在每次执行时都会调用 `options.loadConfig()` 取配置
（`packages/ohbaby-agent/src/tools/web.ts:174`），即读 `SearchConfigManager`（单例带缓存，
`packages/ohbaby-agent/src/config/tools/search/manager.ts:28-47`）。因此 `setSearchApiKeyInternal`
保存后只需：

- 设 `process.env[apiKeyEnv] = apiKey`（当轮即时生效）；
- 调 `reloadSearchConfig()`（`packages/ohbaby-agent/src/config/tools/search/index.ts:24`）使缓存失效。

注意：`SearchConfigManager.load` 的缓存键含 `env` 引用，`process.env` 引用不变 → 仅设值不会失效缓存，
必须显式 `reloadSearchConfig()`。无需 `runtimeController.resetRuntime()`（与 LLM 不同，搜索工具按执行读配置）。

#### B5. 命令注册

- `packages/ohbaby-agent/src/commands/catalog.ts`：新增条目
  `id: "connect-search"`，`path: ["connect-search"]`，**`category: "tool"`（已决策）**，
  `parentBehavior: "interaction"`，`description: "Connect a web search provider"`。
  （`category` 为自由 string，见 `commands/types.ts:28`，新增值无需改类型；`/help` 不做 category
  白名单，会自然成为新分组。）
- `packages/ohbaby-agent/src/commands/builtin.ts`：新增 handler 调用新命令处理函数。
- 新建 `packages/ohbaby-agent/src/commands/connect-search.ts`：参数解析与
  `handleConnectSearch`。沿用 `connect.ts:48-55` 的安全约束：
  禁止通过 slash 参数传 `--api-key`（`UNSUPPORTED_SECRET_ARG`），密钥只能在面板输入。

#### B6. TUI 面板

- `packages/ohbaby-cli/src/tui/components/dialog/command-panel-state.ts`：
  - `InteractiveCommandPanelKind`（:10）增加 `"connect-search"`；
  - **同时把 `"connect-search"` 加入 `INTERACTIVE_COMMAND_IDS` 集合（:48-50）**，否则
    `interactivePanelKindForCommandId` 不会把命令映射到面板。
  - 约束：命令 catalog 的 `id` 必须与 panel kind 字符串完全一致（都为 `"connect-search"`）。
- 新建 `packages/ohbaby-cli/src/tui/components/dialog/connect-search-panel.tsx`：
  复用 `connect-panel.tsx` 的 secret 掩码 / 保存交互，仅含字段
  “Provider”(默认 tavily，便于后续扩展)、“API key env”(默认 TAVILY_API_KEY)、“API key value”(secret)。
  保存调 `client.setSearchApiKey(...)`。
- `packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.tsx`：
  新增 `case "connect-search"` 渲染面板（仿 `:138`），`panelTitle` 增加分支（仿 `:439-440`）。

#### B7. 供应商可扩展性

面板与命令参数以 `provider` 字段为先导（当前仅 `"tavily"`），search.json schema 已是
`z.enum(["tavily"])`（`types.ts:43`）。后续新增供应商时，仅需扩 enum + 面板候选项，命令骨架不变。

---

## 批次二

### 任务 C：MCP 配置支持 ${ENV} 插值（使 MCP 密钥也集中放 .env）

目标：允许在 `mcp/settings.json` 的 `env` / `headers` 值里写 `${TAVILY_API_KEY}` 形式，
连接时从 `process.env`（已含 `.env`）解析为真实值，从而把 MCP 密钥也收敛到 `.env`。

方案要点：

- 在构建 transport 前增加解析步骤：新增
  `packages/ohbaby-agent/src/config/mcp/interpolate.ts`，
  `resolveMcpEnvReferences(config, env = process.env)` 递归替换 `env` / `headers` 中的
  `${VAR}`；未定义变量按策略报错或保留并告警。
- 接入点：在 `packages/ohbaby-agent/src/mcp/core/manager.ts` 创建 client / 构建 config 时调用，
  或在 `packages/ohbaby-agent/src/mcp/core/transport.ts:13` 进入前统一处理。
  注意 stdio 只传 `config.env`、不继承 `process.env`（transport.ts:13-21），
  因此插值后必须把解析出的真实值显式放进 `env`，子进程才能读到。
- schema 不变（仍是字符串）；可在校验阶段对明显未解析的 `${...}` 残留给出告警。
- 文档：在 README 的 MCP 段落补充 `${ENV}` 用法与“密钥写 .env、settings.json 用占位符”的推荐写法。

（批次二与批次一解耦，可独立排期；本文件先记录设计，待批次一验收后再细化到可执行清单。）

---

## 文档同步（随批次一一起改）

- `README.md:86-97` 与中文版：说明 `/connect`、`/connect-search` 默认把密钥写入全局
  `~/.ohbaby-agent/.env`，配置文件只存键名。
- `README.md:99-104` MCP 段落：批次二落地后补 `${ENV}` 用法。

## 风险与注意

- 行为变更集中在“默认 envPath 改全局”一处，运行时读取侧不动，回归风险低。
- 全局 `.env` 含明文密钥：位于用户主目录、repo 之外，默认安全；文档提示用户勿手动提交。
- 全局落盘意味着所有项目共用同一 key，符合“用户级配置”定位（与 model.json 一致）。
- `/connect-search` 涉及 SDK 契约改动，需同步 daemon 两端与各 mock 测试（见验收文档）。
