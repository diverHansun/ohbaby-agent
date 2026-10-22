# 3. 参考项目借鉴

> 2026-10-22 由子代理只读调研 `code-cli/` 下的参考项目，主代理核对后整理。路径相对 `code-cli/`。最终方案以 [00](00-discussion.md) 和 [02](02-optimization-plan-and-change-scope.md) 为准。

## 3.1 参考范围

| 项目 | 客户端与服务端的关系 | 主要看点 |
|---|---|---|
| opencode（v2 布局） | HTTP 服务，`packages/server`、`packages/protocol` | 配置接口、凭据表、MCP 运行时管理 |
| codex | `codex-rs/app-server` JSON-RPC | 分层配置、键路径写入、覆盖提示 |
| kimi-code | `kap-server` REST | 凭据脱敏、provider 增删改、MCP 管理 |
| claude-code | SDK 控制协议，无 HTTP 配置接口 | 有效值与来源分开返回、自写回声过滤 |
| pi | 无配置 RPC | 写前重读、只改变化字段 |

## 3.2 各项目的做法

**opencode。** `GET /api/config` 返回未合并的配置文档列表，由各个领域自己合并（`opencode/packages/protocol/src/groups/config.ts:9-21`）。写入只有 `PATCH /api/experimental/config`，目前只能改 `shell`，并且总是写全局文件。凭据放在 SQLite 表里，但 `credential.list` 会返回明文（`packages/protocol/src/groups/credential.ts:14`）。MCP 的增删只改运行时，不落盘，重启后消失。配置变化靠文件监听，去抖 100 ms 后发 `config.updated`。

**codex。** 配置层次很多：系统、用户、profile、项目、命令行等（`codex-rs/config/src/loader/mod.rs:123-136`）。`config/read` 返回合并后的配置，以及每个键来自哪一层；写入用键路径补丁，只允许写用户的 `config.toml`。写入成功但被更高层覆盖时返回 `okOverridden`，并说明是哪一层覆盖了它（`app-server-protocol/src/protocol/v2/config.rs`）。用内容哈希做乐观锁。模型等会话级默认值只对新会话生效。

**kimi-code。** `GET /config` 对凭据脱敏：provider 只返回 `api_key_env` 和 `has_api_key`（`kimi-code/packages/kap-server/src/routes/config.ts:117-131`）。provider 有独立的增删改接口；`PUT` 里的 `api_key` 是三态：不传保持、空串清除、给值替换（`kimi-code/packages/kap-server/src/routes/modelCatalog.ts`）。MCP 有完整的增删改接口，只写用户级 `mcp.json`，插件和项目来源的条目只读。

**claude-code。** `get_settings` 同时返回合并后的有效值、各来源的原始内容，以及运行时实际使用的模型（`src/entrypoints/sdk/controlSchemas.ts:474-516`）。MCP 状态带 `error`、`scope` 和工具列表。文件监听会记录自己写入的时间，忽略自己引起的变化。

**pi。** 保存设置时加文件锁、重新读取文件，只覆盖本次会话改过的字段（`pi/packages/coding-agent/src/core/settings-manager.ts:596-626`），不会覆盖别处的修改。

## 3.3 借鉴与取舍

| 做法 | 来源 | 本轮怎么用 |
|---|---|---|
| 只写全局文件，项目配置只读 | codex、kimi | 采用（00 §3） |
| 按领域的独立接口，而非通用配置 PATCH | kimi | 采用（02 §2.4） |
| 凭据只返回变量名和是否已配置，key 三态更新 | kimi | 采用，并扩展到 MCP 的 `env`、`headers` |
| 写入成功但被覆盖时提示 | codex `okOverridden` | 采用为 MCP 写入响应的 `overriddenIn` |
| 返回来源 | codex、claude-code | 只在 MCP 和 Agents 的条目上标 `origin`，不做逐键来源 |
| 写前重读，只改目标条目 | pi | 采用；本轮用进程内队列，并协调共用 `.env` 的写入。CLI 也能写文件，不宣称跨进程隔离，不照搬文件锁 |
| 配置保存与运行时生效分开 | codex | 借鉴职责分离；其新会话生效时机不照搬，本项目按已确认的“下一轮生效” |
| MCP 状态带错误和工具列表 | claude-code | 采用 |
| 文件监听 + 自写回声过滤 | opencode、claude-code、kimi | 不采用，改为每轮开始前比较哈希 |
| 乐观锁版本号 | codex | 不采用，本地单用户场景收益小 |
| 多层配置、profile、管理员约束 | codex | 不采用，超出项目需要 |

## 3.4 明确避开的做法

- opencode 返回凭据明文：本轮所有读取接口都不回传 key。
- opencode 的 MCP 增删只在内存里：本轮所有修改都写入文件。
- opencode 把合并逻辑交给客户端：本轮在服务端合并，客户端拿到的是生效结果。
