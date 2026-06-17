# 现有问题与代码分析

## 一、问题现象

v0.1.4 中，用户执行 `/connect` 命令进入连接面板，填好 LLM 配置（含 API key value）后：

- 配置只在“本轮窗口”生效；
- 重启后 API key 丢失，用户级配置文件 `~/.ohbaby-agent/.env` 仍为空，必须手动补写；
- 内置 Web 搜索 Tavily 的 key 也只能手动写 `.env`，交互界面没有入口。

用户预期：填一次 key 就持久化到用户级 `~/.ohbaby-agent/.env`（与 `model.json` 同目录），跨会话、跨项目复用。

## 二、根因：写入位置与读取 / 预期三者不一致

这不是写盘失败，而是“写到了项目目录、用户却在看全局目录”的设计错位。

### 2.1 保存时的落盘分布

| 数据 | 实际写入位置 | 代码位置 |
| --- | --- | --- |
| `model.json`（provider / model / baseUrl / apiKeyEnv 键名） | 全局 `~/.ohbaby-agent/model.json` | `packages/ohbaby-agent/src/config/llm/loaders.ts:26-29`（`getModelJsonPath`） |
| API Key 真实值 | 项目级 `<projectRoot>/.env` | `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts:64` |
| API Key（内存） | 当前 daemon 进程的 `process.env` | `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts:111` |

核心错位在 `apply-active-model-config.ts:64`：

```ts
const envPath = input.envPath ?? path.join(input.projectRoot, ".env");
```

connect 流程从不向全局 `~/.ohbaby-agent/.env` 写入，只写项目目录 `.env`。

### 2.2 为什么“只在本轮窗口生效”

`apply-active-model-config.ts:111` 把 key 直接设进当前进程的 `process.env`，因此本轮会话立即可用；
但持久化只落到项目 `.env`，没有落到用户级 `.env`。进程退出后内存丢失，下次重启只能依赖磁盘，
而用户级 `.env` 是空的，于是表现为“没持久化”。

### 2.3 读取侧本身是正确的（无需大改）

- 启动时 `packages/ohbaby-agent/src/utils/project-env.ts:28-42`（`loadRuntimeEnvIntoProcessEnv`）
  会把 **项目 `.env` + 全局 `~/.ohbaby-agent/.env`** 都灌入 `process.env`，
  优先级 shell > 项目 > 全局，与 README 文档一致。
- 配置管理器读取 key 时，`process.env` 覆盖 env 文件值：
  `packages/ohbaby-agent/src/config/llm/manager.ts:173-176`。

也就是说：只要写入侧把 key 落到全局 `.env`，新进程必然能从 `process.env` 读到，即可持久生效。
运行时读取路径 `packages/ohbaby-agent/src/core/llm-client/client.ts:51`
（仍按 `<projectDirectory>/.env` + `process.env`）无需改动，避免回归。

### 2.4 文档与预期

`README.md:86-97` 已明确：`.env` 可放全局 `~/.ohbaby-agent/.env` 或项目 `<project>/.env`，
优先级 shell > 项目 > 全局。用户预期与文档一致，唯独写入侧没有兑现“全局”。

## 三、Tavily 内置搜索现状

- 配置文件：`~/.ohbaby-agent/tools/search.json`
  （`packages/ohbaby-agent/src/config/tools/search/loaders.ts:10-17`）。
- 密钥范式：search.json 只存键名 `apiKeyEnv`，默认 `TAVILY_API_KEY`
  （`packages/ohbaby-agent/src/config/tools/search/types.ts:44`），真实值从 `process.env` 读取（即来自 `.env`）。
- 缺口：search.json 与 `.env` 都需要用户手动创建 / 编辑，交互界面没有任何入口；
  并且没有 writer（`config/tools/search/` 下只有 loaders/manager，无写入逻辑）。

结论：内置 Tavily 已经是“键名在 json、真实值在 `.env`”的间接范式，与 LLM 完全一致，
只缺一个交互入口把 `TAVILY_API_KEY` 写进全局 `.env`。

## 四、MCP 配置现状（影响后续批次）

### 4.1 配置文件位置（双层合并）

`packages/ohbaby-agent/src/config/mcp/loaders.ts:26-107`：

- 全局：`~/.ohbaby-agent/mcp/settings.json`
- 项目：`<project>/.ohbaby-agent/mcp/settings.json`
- 合并：项目覆盖全局（同名 server 项目级胜出）。

### 4.2 配置结构

`packages/ohbaby-agent/src/config/mcp/types.ts:104-182`，`{ mcpServers: { <name>: {...} } }`，三种传输：

- `stdio`：`command` / `args` / `env`（`Record<string,string>`）/ `cwd`
- `http` / `http_streamable`：`url` / `headers`
- `sse`（已废弃）：`url` / `headers`

### 4.3 关键差异：MCP 密钥目前是“明文内联”

- stdio 把密钥写在 `env`，http/sse 写在 `headers`，均为字面量字符串。
- 全代码库没有 `${ENV}` 插值机制。
- 且 stdio 传输只把 `config.env` 传给子进程、不继承 `process.env`
  （`packages/ohbaby-agent/src/mcp/core/transport.ts:13-21`，由
  `packages/ohbaby-agent/src/mcp/__tests__/transport.unit.test.ts:33-34` 证实
  `OHBABY_MCP_SECRET` 不会被转发）。因此即便把 key 放进 `.env`，MCP 子进程当前也读不到。
- MCP 配置没有 writer，也没有让 agent 自助配置的命令 / 工具；只有只读的 `/mcps`
  （`packages/ohbaby-agent/src/commands/catalog.ts:135-144`）。agent 目前只能用文件工具直接改 JSON，无校验兜底。

### 4.4 三套密钥范式对照

| 能力 | 配置文件 | 密钥存放方式 | 是否走 .env |
| --- | --- | --- | --- |
| LLM | `~/.ohbaby-agent/model.json` | 存键名 `apiKeyEnv`，值在 `.env` | 是（间接） |
| 内置搜索 Tavily | `~/.ohbaby-agent/tools/search.json` | 存键名 `TAVILY_API_KEY`，值在 `.env` | 是（间接） |
| MCP server | `~/.ohbaby-agent/mcp/settings.json` | 明文内联 env / headers | 否（直接，待改造） |

目标态：三者统一为“配置文件存键名 + 非密钥配置，真实值统一在 `.env`”。
LLM 与 Tavily 在批次一完成；MCP 通过 `${ENV}` 插值在批次二完成。

## 五、`/connect` 的完整链路（供 `/connect-search` 镜像参考）

1. SDK 契约：`packages/ohbaby-sdk/src/client.ts:43`（`CoreAPI.connectModel`）、
   `packages/ohbaby-sdk/src/rpc/types.ts:35`（`UiBackendClient.connectModel`）。
2. daemon JSON-RPC 方法白名单：`packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts:11`。
3. daemon JSON-RPC 客户端代理：`packages/ohbaby-server/src/protocols/jsonrpc/client.ts:171-174`
   及 CoreAPI 包装 `:397-398`。
4. daemon 服务端分发：`packages/ohbaby-server/src/runtime/daemon/server.ts:230-232`。
5. backend 实现：`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:1281-1321`（`connectModelInternal`），
   经 `applyActiveModelConfig` 写盘；`ui-persistent.ts` 转发；
   `packages/ohbaby-agent/src/host/core-api-factory.ts:76-78` 接线。
6. 命令注册：`packages/ohbaby-agent/src/commands/catalog.ts:47-58`（catalog 条目）、
   `packages/ohbaby-agent/src/commands/builtin.ts:617-621`（handler）、
   `packages/ohbaby-agent/src/commands/connect.ts`（参数解析 + `handleConnect`）。
7. TUI 面板：`packages/ohbaby-cli/src/tui/components/dialog/command-panel-state.ts:10`
   （`InteractiveCommandPanelKind = "connect"`）、
   `packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.tsx:138,439`（渲染 + 标题）、
   `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx`（面板组件）。
