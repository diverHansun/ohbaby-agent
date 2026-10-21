# 3. 参考项目借鉴

> 2026-10-21 由子代理阅读 `/Users/hansun025/Projects/code-cli/` 下的本地仓库，主代理汇总。只记录与本议题相关的部分。

## 3.1 借鉴来源

| 项目 | 本地路径 | 调研范围 |
|---|---|---|
| dsh（deepseek-harness） | `code-cli/deepseek-harness` | `packages/sdk/{protocol,client,server}`、`typert/`、`api/gateway` |
| kimi-code | `code-cli/kimi-code` | `packages/klient`、`kap-server/src/protocol` |
| claude-code | `code-cli/claude-code` | `src/entrypoints/sdk`、`src/server` |
| ZCode | `code-cli/ZCode` | `packages/rpc`、`packages/shared`、`architecture-policy.yaml` |
| opencode（简要） | `code-cli/opencode` | `packages/{schema,protocol,client,server}` |

## 3.2 协议和客户端放在哪

| 项目 | 做法 |
|---|---|
| opencode | `schema → protocol → client | server`，协议单独成包，客户端和服务端都依赖它 |
| dsh | `sdk/protocol`、`sdk/client`、`sdk/server` 三个包；但 `protocol` 依赖 llm、session 等运行时包，并不是纯类型 |
| ZCode | `rpc` 包只是传输框架，客户端和服务端在同一个包里；类型放在 `shared` |
| kimi-code | REST/WS 的 wire 类型放在 server 内部（`kap-server/src/protocol/`，约 40 个文件）；进程内契约在 `klient/src/contract/` |
| claude-code | SDK 类型和 schema 放在应用内部的 `src/entrypoints/sdk/`，没有单独的包 |

**结论**：没有统一做法。协议单独成包的项目（opencode、dsh）有多个独立的客户端需要共享协议。kimi-code 和 claude-code 把 wire 类型留在服务端或应用内部，情况和我们更接近：本项目的 JSON-RPC 客户端只有 CLI 一个使用者，Web 有自己的 REST wire 层。

## 3.3 包内文件组织

| 项目 | 做法 |
|---|---|
| dsh | `sdk/protocol/src` 只有 3 个文件，`sdk/client/src` 5 个，全部平铺 |
| ZCode | `rpc/src` 平铺；`apps/zcode-cli/packages/contracts` 按关注点分子目录 |
| kimi-code | `klient/src` 分为 `contract/`、`core/`、`transports/` |
| opencode | `protocol/src` 有 `groups/`、`middleware/` |

**结论**：小包平铺，大包按职责分子目录。我们的 sdk 有 33 个源文件、约 5200 行，已经到了值得分组的规模。

## 3.4 文件大小约束

ZCode 的 `architecture-policy.yaml` 对受管模块规定 `maxFileLines: 400`、`maxContractLines: 300`，例外需要写明理由。我们不引入这样的检查工具，只把它当作拆分 `create-app.ts` 时的参考尺度。

## 3.5 取舍

| 借鉴点 | 取舍 | 说明 |
|---|---|---|
| kimi-code 的 `contract/` 子目录 | 采用 | sdk 的 `contract/` 目录 |
| 小包平铺、大包分目录 | 采用 | sdk 只分一层，不再往下细分 |
| ZCode 的文件行数上限 | 参考 | 作为 Stage 3 的目标尺度（新文件约 600 行内），不做强制检查 |
| opencode、dsh 的独立协议包 | 不采用 | 没有多个客户端共享 JSON-RPC 协议，与 00 §2 的决定一致 |
| ZCode 的 `architecture-policy.yaml` 自动检查 | 不采用 | 4 个包的规模用不上 |
| dsh 的 50 多个能力分组 | 不采用 | 那是插件体系团队的规模 |

## 3.6 对 02 的影响

- sdk 分目录和 `contract/` 命名来自 3.3、3.5（02 Stage 1）。
- JSON-RPC 留在 server 与 3.2 的 kimi-code、claude-code 做法一致（02 §2.2）。
- `create-app.ts` 拆分的行数目标参考了 3.4（02 Stage 3）。
