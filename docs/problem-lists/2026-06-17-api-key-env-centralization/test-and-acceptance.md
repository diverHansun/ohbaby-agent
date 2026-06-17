# 测试与验收标准

## 一、需更新的现有测试

### 任务 A 相关

- `packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts`
  - 未显式传 `envPath`、依赖“默认写到项目 `.env`”的用例（如 L50-71 等）需改为断言写入
    全局 `.env`（通过注入 home 目录或显式 `envPath` 隔离临时目录）。
  - 显式传 `envPath` 的用例不受影响，保持原状即可。
- `packages/ohbaby-agent/src/config/llm/__tests__/connect-model.real.e2e.test.ts`
  - 涉及落盘路径的断言改为全局 `.env`。
- `packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts`
  - 若涉及任务 A2 的 fallback 默认值，更新对应断言。

### 不应改动（防回归基线）

- `packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts`
  （`envPath: "D:\\repo\\.env"` 走运行时读取侧，不改）。
- `packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts`
  （`envPath: "D:/repo/.env"` 同上）。
- `packages/ohbaby-agent/src/utils/project-env.unit.test.ts`
  （全局 + 项目 `.env` 加载与优先级保持通过）。

## 二、需新增的测试

### 任务 A0 / A1

- `config/secrets/env-secrets`：单测 `writeGlobalEnvSecret`
  - 文件不存在时按 `key=value` 新建（含目录创建）；
  - 已存在同名键时就地替换、不重复追加；
  - 含空格 / 特殊字符的值被正确引用（沿用 `env-file` 的 `quoteValue` 行为）；
  - 返回的 `envPath` 指向 `~/.ohbaby-agent/.env`（注入 home 目录）。
- `apply-active-model-config`：新增“未传 envPath 时写入全局 `.env`”用例，并验证
  `process.env[apiKeyEnv]` 当轮被设置。

### 任务 B（search writer + RPC + 命令）

- `config/tools/search/writer`：单测 `setSearchApiKey`
  - 把 `TAVILY_API_KEY` 写入全局 `.env`；
  - search.json 不存在时创建最小配置（只含 `provider` 与 `apiKeyEnv` 键名，不含明文 key）；
  - search.json 已存在时保留其它字段、不覆盖非密钥配置；
  - 返回结果不含明文 key；`process.env` 当轮被设置。
- `commands/connect-search`：参数解析单测
  - 通过 slash 参数传 `--api-key` 时返回 `UNSUPPORTED_SECRET_ARG`（与 `connect.ts` 一致）；
  - 缺省 provider / apiKeyEnv 时使用默认值。
- daemon RPC 契约：
  - `protocols/jsonrpc/protocol.unit.test.ts` 方法白名单包含 `setSearchApiKey`；
  - server / client 集成测试新增 `setSearchApiKey` 往返（仿现有 `connectModel` 用例）。
- backend：`ui-inprocess` 契约 / 单测覆盖 `setSearchApiKey` 调用写盘，并断言保存后调用了
  `reloadSearchConfig()`（缓存失效）与设置 `process.env`。
- TUI：
  - `command-panel-state`：单测 `interactivePanelKindForCommandId("connect-search")` 返回
    `"connect-search"`（验证已加入 `INTERACTIVE_COMMAND_IDS`、id 与 kind 一致）。
  - `connect-search-panel` 组件测试（secret 掩码、保存调用 `client.setSearchApiKey`）。
  - `command-panel-manager` 渲染 `connect-search` 分支与标题。
- 命令分组：`/help` 输出含 `category: "tool"` 的 `connect-search`，分组正常显示（无白名单遗漏）。

### 任务 C（批次二，先列占位）

- `config/mcp/interpolate`：`${VAR}` 在 `env` / `headers` 中被正确解析；未定义变量按既定策略
  报错 / 告警；无占位符时原样返回。
- 解析后的真实值确实进入 stdio `config.env`（结合 `transport` 测试验证子进程可见）。

## 三、验收标准（功能层）

### 批次一验收

1. 首次使用：全新环境（`~/.ohbaby-agent/.env` 不存在），`/connect` 面板填入 api-key 并保存后，
   `~/.ohbaby-agent/.env` 被创建且包含 `<apiKeyEnv>=<value>`。
2. 持久化：完全退出并重启 `ohbaby`（含 daemon 重启）后，无需重填即可正常对话，key 来自全局 `.env`。
3. 跨项目：切换到另一个项目目录启动，LLM 仍可用（全局 key 生效）。
4. 即时生效：保存后无需重启，当轮即可对话。
5. 落盘提示：面板保存成功提示写入路径为 `~/.ohbaby-agent/.env`。
6. Tavily：`/connect-search` 面板填入 Tavily key 并保存后，`~/.ohbaby-agent/.env` 含
   `TAVILY_API_KEY=<value>`；内置 Web 搜索工具当轮及重启后均可用。
7. 安全：任何错误回显与日志均不出现明文 api-key（沿用 `connect-panel` 的 `sanitizeError`）。
8. 兼容：旧用户已写在项目 `.env` 的 key 仍可正常读取，不被破坏。

### 批次二验收

1. 在 `mcp/settings.json` 用 `${SOME_KEY}` 占位、真实值放 `.env` 后，MCP server 能正常连接并鉴权。
2. 未定义变量时给出清晰报错 / 告警，不把字面量 `${...}` 当作真实密钥发送。

## 四、回归与质量门禁

- 全量类型检查与 lint 通过。
- `ohbaby-agent`、`ohbaby-sdk`、`ohbaby-server`、`ohbaby-cli` 四个包的单测 / 集成测试通过。
- 重点回归：现有 `/connect` 行为（除落盘位置外）保持不变；daemon RPC 往返不破坏既有方法。
- 手动验收：按“批次一验收”1-8 项在真实环境逐条走查。
