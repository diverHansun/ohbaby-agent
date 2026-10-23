# 5. 实施验收文档

> 2026-10-23 独立验收。实施方在提交 `a183d429` 中写过一版实施记录，本文在其基础上重写：保留实施方的分批结果和测试证据，加入独立复核得到的差异、问题和结论。同日按用户指示修复了 G1–G5，修复与复跑记录见 §5.8；提交前补充复核及 SDK 凭据隔离修正见 §5.9。

## 5.1 元信息

| 项 | 值 |
|---|---|
| 议题 / 轮次 | 无工作区会话与设置后端 / improve-2 |
| 规划文档 | 本目录 00–04，随 `a183d429` 提交；代码基线 `231eb8e1` |
| 实施范围 | 分支 `codex/settings-backend-2026-10-22`，`231eb8e1..a183d429`，共 6 个提交、84 个文件、约 +9.8k / −0.8k 行 |
| 验收日期 | 2026-10-23 |
| 验收方式 | 主代理复跑类型检查、lint 和三组回归；三个子代理分别只读审查 Stage 1–3 规格、Stage 4a/4b 规格、代码质量与越界；主代理逐条核对关键发现 |
| 结论 | **通过**。G1–G6 与 `6f334142` 的 SDK 凭据修复一并纳入；提交前发现的四处遗漏已补齐，组合回归、独立子代理与 Pi 复核通过（§5.9）。低严重性建议保留，不扩展本轮范围 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
|---|---|---|---|
| Stage 1：修 B1–B4，打通生效机制 | 完成 | 六分区设置版本，按分区重载搜索、MCP、Skills、Agents；注入 LLM 客户端时也接线；`McpManager.reload()` 等待工具刷新；组装 `dispose` 取消订阅；Skill 按“路径 + 修改时间”签名自动刷新 | `ed66177e`；`adapters/settings-refresh.integration.test.ts`、`config/llm/__tests__/settings-version.unit.test.ts` |
| Stage 2：实例层只读接口 | 完成 | MCP 状态（来源、过滤后工具数、脱敏错误）、Skills、Agents（内置/全局/项目来源）；SDK 契约 | `cc6f43a5`；`server:app/settings-read.integration.test.ts`、`services/settings/reader.unit.test.ts` |
| Stage 3：全局层搜索、MCP、关于、通知 | 完成 | 精确路径注册的全局路由；`notifySettingsChanged` 只发布事件；MCP `env`/`headers` 补丁与只返回键名；搜索字段合并与 key 三态；模型与搜索共用 `.env` 协调 | `4b7fae97`；`server:app/settings-global.integration.test.ts`、`config/mcp/__tests__/writer.integration.test.ts` |
| Stage 4a：模型条目与凭据 | 完成 | 连接字段直接放在 `models[]` 条目；只投影当前条目给 `ohbaby-llm`；稳定 id 与顺序；保存与选择分开；条目级 key 隔离；删除顺延；迁移按预算匹配器定位并合并通配能力；`/connect` 按路由匹配；进程内配置代数防过期写回 | `504ec6f2`；`config/llm/__tests__/model-settings.integration.test.ts`、`model-document.integration.test.ts`、`model-entry-discovery.integration.test.ts` |
| Stage 4b：推理能力获取 | 完成 | 内置规则全部保留，只去掉 provider 名称条件；探测字段改按官方地址判断；probe 路由；主动探测只在选为当前或手动 probe 时进行 | `8ea31752`；`model-entry-probe.integration.test.ts`、`ohbaby-llm/src/providers/reasoning.unit.test.ts` |
| D1、D2 文档同步 | 完成 | `02-web-api-surface.md`、`04-multi-project-runtime.md` 已更新 | `a183d429` |

路径省略 `packages/ohbaby-agent/src/`，`server:` 表示 `packages/ohbaby-server/src/`。

**越界扫描**：没有文件监听、后台轮询、新 JSON-RPC 方法、项目配置编辑或 Web 包改动。

## 5.3 规划 vs 实际差异

| 维度 | 规划（02） | 实际 | 原因 | 影响 |
|---|---|---|---|---|
| 配置锁的粒度 | 复用现有按路径排队的队列，模型和搜索共用 `.env` 的写入要协调 | `coordinateModelConfig` 改成全进程一把 `settings-publication` 锁，所有设置读写、回滚和每轮准入共用 | 实施方为防止不同路径的队列丢 key，选了最简单的单锁 | 写入安全。MCP 连接曾在这把锁里进行（G1），已修复：锁内只做版本快照和配置重读 |
| 推理能力优先级 | 未明确内置规则与旧自动结果的先后 | 显式能力 → 内置规则 → 自动结果（元数据、主动探测） | 内置规则经过人工核对，比旧的自动结果可靠 | 合理。已有自动结果的官方模型会改用内置规则 |
| 注入 LLM 客户端时的 model 分区 | 只跳过 `reloadLLMConfig` | `reloadLLMConfig` 已跳过，但 model/env 变化仍会让固定客户端的运行时等待空闲后重建 | 实现时没有把 model 分区从比较中去掉 | 小问题：固定客户端的宿主会无谓重建 |
| MCP 状态读取 | 已初始化实例在下一轮或显式重连前反映旧配置 | 首次读取在协调锁内认领配置版本，再在锁外等待连接 | 慢连接不阻塞全局设置，且后续新一轮能识别等待期间的配置变化 | §5.9 补充覆盖首次状态初始化与首次 prompt 并发的情况 |
| 搜索 key 变量改名 | 未规定旧变量如何处理 | 改 `apiKeyEnv` 保留旧变量；清除时只删除搜索受管且未被模型引用的变量，其余解除引用 | 避免删除用户自管变量 | G4 已修复，见 §5.8 |
| 新增模型的上下文窗口 | 02 未规定 | 上游探测值优先，用户填写值只在探测失败时使用 | 沿用改动前 `/connect` 的 `resolveContextWindow` 规则 | 合理。首轮把它记成缺陷有误；真正的缺陷是只改预算的 PATCH 也会重启探测（G5，已修复） |
| 显式 `apiKeyEnv` 被共享时 | 规则 6 同时写了“隔离共享引用”和“用户填写的变量名照常使用” | 优先隔离：PATCH `{apiKeyEnv: "SHARED", apiKey: "new"}` 会改写到 `OHBABY_MODEL_<ID>_API_KEY` | 规划两句话有冲突，实施方选了更安全的一边 | 可以接受，建议在 02 里写清 |
| 数据结构、接口路径、错误码、文件结构 | 02 §2.3–§2.4 | 与规划一致 | - | - |
| 依赖 | 不新增 | 未新增依赖 | - | - |

## 5.4 实施理由与注意事项

- 职责划分沿用规划：文件规范化、凭据和后台发现在 agent 配置模块；`ohbaby-llm` 只接收当前条目的投影和协议规则；server 负责校验和适配；SDK 只加类型。
- 配置代数是进程内计数器，只能拦住本进程的改动。其它进程或手改 `.env` 换了 key 值，拦不住过期写回。规划已把跨进程隔离排除在外。
- 模型文件结构改了以后，旧版本保存会丢新字段，也不支持 `active: null`。回退前要备份新文件并恢复升级前配置。
- 旧 `/connect` 的上下文窗口探测（`apply-active-model-config.ts:149`）仍会比较 key 原文是否相同。这是存量逻辑，不在新接口路径上。
- 托管变量在清除后不会从 `.env` 删除（02 写的是“可移除”），`.env` 可能慢慢积累不再使用的变量。

## 5.5 实施成果（对照 04）

### 5.5.1 首轮验收项结果（历史记录）

实施方逐项列出的测试证据见提交 `a183d429` 中本文件的上一版。首轮独立复核结果如下；修复后的当前结果见 §5.8–§5.9：

| 验收项 | 结果 | 说明 |
|---|---|---|
| T1–T4、T12、T23 | 通过 | 规格审查逐项核对代码；回归通过 |
| T5–T7 | 通过 | 同上 |
| T8–T10、T13、T14 | 通过，附问题 | T8 的字段合并和三态正确，但改变量名会删旧变量（G4）；T14 的忙碌检查正确，但锁范围过大（G1） |
| T11 | 通过，附问题 | 设置接口响应已脱敏；但 `/mcps` 等命令路径上的 MCP 错误未脱敏（G2）。stdio `args` 按契约原样返回 |
| T15–T17、T19、T21、T22 | 通过 | 迁移、顺序、顺延、`/connect` 匹配、不查重、key 隔离均与 02 一致 |
| T18 | 通过 | 内置规则保留，名称条件已去掉；未命中时才探测 |
| T20 | 通过，附问题 | 先保存、候选不主动探测、过期写回被拦住；但后台元数据会覆盖用户手填的上下文窗口（G5） |

**复跑结果**（2026-10-23，本机，顺序执行）：

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors / 122 warnings，与基线一致 |
| 设置定向回归（19 个路径，实施方 05 中的第一组命令） | 72 / 73 文件通过，857 / 858 测试通过。唯一失败见下 |
| 旧入口、TUI、SDK、RPC 兼容回归 | 29 文件 / 449 测试通过 |
| improve-1 工作区回归 | 10 文件 / 89 测试通过 |

失败的用例是 `adapters/model-settings-runtime.integration.test.ts`。本机 shell 设置了 `ANTHROPIC_AUTH_TOKEN`，Anthropic SDK 没有收到显式 `authToken` 时会自动读取它，并作为 `Authorization: Bearer` 发出；测试优先读 `authorization` 头，于是拿到了 shell 里的 token。去掉该变量后重跑通过。这说明：

1. 首轮把 G7 归为测试未隔离环境；提交前复核确认生产 SDK 确实会读取宿主凭据，因此通过生产修复和带伪造宿主变量的回归解决，不能仅靠清空环境规避。
2. 存在一个**存量风险**，不是本轮引入的：用户 shell 里的 `ANTHROPIC_AUTH_TOKEN` 会随请求发给 ohbaby 中配置的任何 anthropic 协议上游，包括第三方代理（`ohbaby-llm/src/providers/anthropic.ts:719` 创建客户端时未传 `authToken: null`）。

没有调用收费上游，没有浏览器走查（本轮不含 Web）。

### 5.5.2 SWE 层面评估

整体看，这轮改动守住了规划定下的边界：复用了运行准入、原子写入、加载器、注册表和事件流，没有新增存储、框架或监听器。模型条目直接放进 `models[]`、只投影当前条目给 `ohbaby-llm`，这两点让 LLM 包保持干净。规格层面没有发现漏做或做错。

问题集中在两类：一是为了“安全”把锁放得太大；二是凭据处理在几个角落不一致。

| 发现 | 严重性 | SWE 依据 | 建议 |
|---|---|---|---|
| 全局设置锁里连接 MCP（G1，已修复） | 中高 | 锁里不应包含慢速、不可控的外部 I/O；一个项目的故障会扩散到所有项目 | 锁内只取版本快照，连接放到锁外；准入只协调版本比较 |
| 命令路径 MCP 错误未脱敏（G2，已修复） | 中 | 同一份数据在两条路径上的安全处理不一致 | 在 `mcpStatusToSummary` 里调用同一个脱敏函数 |
| baseUrl 脱敏误伤（G3，已修复） | 中 | 把 `.env` 里所有值都当密钥做字符串替换，短值会误匹配 | 只用被引用为 `apiKeyEnv` 的值；明确凭据不能因长度短而跳过脱敏（§5.9） |
| 搜索改变量名删旧变量（G4，已修复） | 中 | 删除操作超出了“只解除自己引用”的规则，与模型删除保留 key 不一致 | 只解除引用，不删变量 |
| 只改预算的 PATCH 被后台改回（G5，已修复） | 中 | 非连接字段的编辑不应重启后台探测 | 只在连接字段变化时重启 |
| 改备注会取消当前模型的主动探测（G6，随 G5 修复） | 低 | 同上 | 同上 |
| SDK 读取宿主凭据（G7，§5.9 纳入修复） | 存量风险 | 模型已配置的凭据应是实际请求的唯一来源 | 显式关闭 SDK 凭据回退，并用伪造宿主变量验证实际请求 |
| 错误码不统一 | 低 | `MCP_SERVER_NOT_FOUND` 等没有 `code`；部分校验失败返回 500；全局 MCP 文件本身损坏时所有 PUT 都失败，无法通过接口修复 | 统一错误信封；配置校验错误返回 400 |
| MCP 服务器名没有校验 | 低 | `PUT /v1/settings/mcp/servers/__proto__` 返回 500（没有原型污染） | 加名称格式校验 |
| Skill 签名扫描在热路径上 | 低 | 每步、每次加载 Skill 都递归扫描目录 | 观察实际耗时；必要时按轮缓存签名 |
| 重复代码与手写 OpenAPI | 低 | 变量命名循环在模型和搜索写入里各写一遍；`openapi.ts` +599 行手写，可能与 SDK 类型漂移 | 抽公共函数；后续考虑由类型生成 |
| `writer.ts` 职责偏多（+713 行） | 低 | 请求校验、凭据命名、持久化回滚、响应投影都在一个文件 | 拆出投影和持久化 |

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|---|---|---|
| [config/llm/model-document.ts](../../../../packages/ohbaby-agent/src/config/llm/model-document.ts) | 模型文件规范化、迁移、当前投影 | 新增 |
| [config/llm/writer.ts](../../../../packages/ohbaby-agent/src/config/llm/writer.ts) | 条目增删改选、key 隔离、元数据写回、配置代数 | 修改 |
| [config/llm/apply-active-model-config.ts](../../../../packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts) | 按条目的后台发现与主动探测 | 修改 |
| [config/llm/config-coordination.ts](../../../../packages/ohbaby-agent/src/config/llm/config-coordination.ts) | 六分区设置版本；全局单锁 | 修改 |
| [adapters/ui-inprocess.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) | 版本接线、分区重载、实例设置读取、通知 | 修改 |
| [adapters/ui-inprocess/runtime-controller.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.ts) | 分区哈希、MCP 重连准入 | 修改 |
| [mcp/core/manager.ts](../../../../packages/ohbaby-agent/src/mcp/core/manager.ts) | 公开 `reload()`，等待工具刷新 | 修改 |
| [config/mcp/writer.ts](../../../../packages/ohbaby-agent/src/config/mcp/writer.ts) | 全局 MCP 文件写入 | 新增 |
| [config/tools/search/writer.ts](../../../../packages/ohbaby-agent/src/config/tools/search/writer.ts) | 字段合并、key 三态 | 修改 |
| [config/secrets/redaction.ts](../../../../packages/ohbaby-agent/src/config/secrets/redaction.ts) | URL 与错误脱敏 | 新增 |
| [services/settings/reader.ts](../../../../packages/ohbaby-agent/src/services/settings/reader.ts) | MCP 状态、Skills、Agents 读取 | 新增 |
| [skill/registry.ts](../../../../packages/ohbaby-agent/src/skill/registry.ts)、[skill/loader.ts](../../../../packages/ohbaby-agent/src/skill/loader.ts) | 签名比较与自动刷新 | 修改 |
| [agents/registry.ts](../../../../packages/ohbaby-agent/src/agents/registry.ts) | 来源记录，按目录加载 | 修改 |
| [ohbaby-llm/src/providers/reasoning.ts](../../../../packages/ohbaby-llm/src/providers/reasoning.ts) | 内置规则去掉名称条件；优先级调整 | 修改 |
| [ohbaby-server/src/protocols/web/routes/global-settings.ts](../../../../packages/ohbaby-server/src/protocols/web/routes/global-settings.ts) | 全局设置路由 | 新增 |
| [ohbaby-server/src/protocols/web/routes/settings.ts](../../../../packages/ohbaby-server/src/protocols/web/routes/settings.ts) | 实例设置路由 | 新增 |
| [ohbaby-server/src/runtime/daemon/server.ts](../../../../packages/ohbaby-server/src/runtime/daemon/server.ts) | 挂载全局路由与通知 | 修改 |
| [ohbaby-sdk/src/contract/settings.ts](../../../../packages/ohbaby-sdk/src/contract/settings.ts) | 设置契约类型 | 新增 |

## 5.7 首轮问题与建议顺序（历史记录）

首轮验收时只记录、不修复。用户随后指示修复 G1–G5，结果见 §5.8；G6 随 G5 一并修复，G7 最初在独立分支修复，随后经用户授权纳入本次组合验收（§5.9）。

| 顺序 | ID | 问题 | 复现条件 | 位置 |
|---|---|---|---|---|
| 1 | G1 | MCP 连接时占着全局设置锁 | 项目 A 有一个慢或卡住的 stdio MCP；第一次打开 A 的 MCP 状态页，或 A 的运行时因 MCP 配置变化重建。连接超时前，daemon 内所有项目的新一轮准入和全部 `/v1/settings/*` 读写都在排队 | `config-coordination.ts` `coordinateModelConfig`；`ui-inprocess.ts` `getSettingsMcpStatus`、`reconnectSettingsMcp`、`createRuntime` |
| 2 | G2 | 命令路径上的 MCP 错误未脱敏 | HTTP MCP 地址或 header 带 token 且连接失败；`/mcps`、`/status` 输出和命令结果事件中出现原始错误文本 | `adapters/ui-runtime/composition.ts` `mcpStatusToSummary`；`commands/normalize.ts` |
| 3 | G3 | baseUrl 被误脱敏 | 全局 `.env` 有 `PORT=8080` 之类的短值；`http://localhost:8080/v1` 显示成 `http://localhost:[REDACTED]/v1`。另外 `redactSettingsError` 遇到非法百分号编码的用户名会抛错，导致 500 | `config/llm/writer.ts` `projectSettings`；`config/secrets/redaction.ts` |
| 4 | G4 | 搜索设置会删除不相关的变量 | `PUT /v1/settings/search {"apiKeyEnv":"NEW"}` 删除旧变量；`{"apiKeyEnv":"GITHUB_TOKEN","apiKey":""}` 删除 `GITHUB_TOKEN` | `config/tools/search/writer.ts` 约 L157–163 |
| 5 | G5 | 后台元数据覆盖手填的上下文窗口 | PATCH `{contextWindowTokens: 64000}` 后，上游元数据报告 200000，文件被改回 | `config/llm/writer.ts` `updateModelEntry`、`writeModelEntryMetadata` |
| 6 | G6 | 改备注取消主动探测 | 选中条目 X 后立刻改 X 的备注；探测被取消，X 停在 unknown | `apply-active-model-config.ts` `startModelEntryDiscovery` |
| 7 | G7 | 测试受宿主环境影响 | shell 设置了 `ANTHROPIC_AUTH_TOKEN` 时 `model-settings-runtime.integration.test.ts` 失败 | 该测试文件 |
| 8 | - | 低严重性项 | 见 §5.5.2 表中“低”级条目 | - |

**首轮记录的存量风险（本次已纳入，见 §5.9）**：Anthropic 客户端会自动带上 shell 里的 `ANTHROPIC_AUTH_TOKEN`（见 §5.5.1）。这不属于本轮范围，但涉及凭据外泄，建议另开一项修复：创建客户端时显式传 `authToken: null`。

首轮要求：G1–G5 修完后补对应的先失败后通过的测试，重跑回归并独立复核；执行结果见后两节。

## 5.8 修复记录（2026-10-23）

每项先补测试并确认失败，再改代码，测试转为通过。

| ID | 先失败的测试 | 修复 | 位置 |
|---|---|---|---|
| G1 | `settings-refresh.integration.test.ts` 新增 3 项：项目 A 的 MCP 连接卡住时，读状态、运行时创建、手动重连期间设置锁都应空闲，项目 B 能完成一轮 | 运行时创建拆成两步：锁内只做版本快照和需要与版本一致的配置重读（LLM、搜索）；组装运行时（含 MCP 连接）放到锁外。读 MCP 状态只在取版本时短暂拿锁。手动重连靠实例自己的准入屏障挡住新一轮，不再拿全局锁 | `runtime-controller.ts` `getRuntime`、`reconnectMcp`，新增 `prepareRuntime` 选项；`ui-inprocess.ts` |
| G2 | `composition.unit.test.ts`：header 值和 Bearer token 出现在命令摘要中 | `mcpStatusToSummary` 调用与设置页相同的 `redactSettingsError`；`McpManagerPort` 增加可选的 `getServerDetails` | `adapters/ui-runtime/composition.ts` |
| G3 | `redaction.unit.test.ts`（新）与 `model-settings.integration.test.ts`：`.env` 有 `PORT=8080`、`DEBUG=1` 时地址被改成 `localhost:[REDACTED]/v[REDACTED]`；非法百分号编码抛 `URIError` | 首版修复用 8 字符过滤，但会漏掉真正的短 key；§5.9 已收窄到通用 stdio 环境值。模型设置只把条目实际引用的 key 当作密钥；URL 解码失败时保留原文 | `config/secrets/redaction.ts`；`config/llm/writer.ts` `projectSettings` |
| G4 | `settings-writer.integration.test.ts` 新增 2 项：改变量名丢掉旧 key；清除操作删掉 `GITHUB_TOKEN` 和用户自管变量 | 改变量名不再删除旧变量；清除只删除搜索自己管理的变量（`TAVILY_API_KEY`、`OHBABY_SEARCH_API_KEY[_n]`）且模型未引用，其它情况只把 `apiKeyEnv` 置空 | `config/tools/search/writer.ts` |
| G5、G6 | `model-entry-discovery.integration.test.ts`：只改上下文窗口和备注也发出新的元数据请求 | 只有连接字段变化才重启后台发现。避免启动额外任务或替换正在进行的主动探测；已有元数据请求延迟返回时的预算保护由 §5.9 补齐 | `config/llm/writer.ts` `updateModelEntry` |

G1 的判断需要修正：改动前，运行时创建（会等待 MCP 连接）本来就在 `model.json` 的配置锁里，而所有实例共用这把锁，所以“一个项目的 MCP 卡住会挡住其它项目的新一轮”在改动前就部分存在。本轮新增的是读状态、重连和全部设置读写也进入了这把锁。这次修复把两部分一起解决了。

新的取舍：版本快照在前、读文件在后。组装期间如果有人改了配置，记录的版本会偏旧，下一轮会多重建一次，但不会用错配置。

**修复后复跑**（本机，顺序执行）：

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors / 122 warnings，与基线一致 |
| 设置回归（第一组，另加 `adapters/ui-inprocess`、`composition.unit.test.ts`、`config/secrets`） | 87 文件 / 1173 测试通过 |
| 旧入口、TUI、SDK、RPC 兼容回归（`commands` 改为整个目录） | 31 文件 / 482 测试通过 |
| improve-1 工作区回归 | 10 文件 / 89 测试通过 |

设置回归在去掉 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 的环境下运行，以排除 G7。G7 与 Anthropic SDK 读取 shell 凭据的存量问题已在独立分支修复：`refs/heads/claude/priceless-jennings-b88b8b` 的提交 `6f334142`，让 provider SDK 不再从宿主环境读取凭据和请求头。这是 §5.8 当时的状态；提交前已按用户授权用 `cherry-pick --no-commit` 纳入该修复，并修正其中自定义头与认证头冲突的问题，见 §5.9。没有 merge 或 push。

§5.8 记录的是用户修复完成、尚未提交时的结果。


## 5.9 提交前补充复核（2026-10-23）

用户授权将 `6f334142` 与 G1–G6 一并验收后，本节复核当前工作树。独立子代理检查后由主代理逐条复现；发现以下四处未完整覆盖的实际问题，均补失败测试后作局部修正，没有新增持久化状态、依赖或服务。

| 问题 | 修正与验证 |
|---|---|
| G1：首次读状态正在连接旧 MCP，此时保存新配置并启动首次 prompt，可能把旧连接标成新版本 | 在短暂协调锁内认领首次初始化版本，再在锁外等待连接。回归阻塞旧连接、保存新配置、启动 prompt，检查实际运行时工具目录使用新 MCP，并在下一轮保持正确。原修复失败，补充修正后通过。另将三个慢连接测试改为等待实际进入连接，去掉用于猜测时序的 sleep |
| G3：统一忽略短于 8 字符的密钥会漏出真实短 key | 模型引用 key、HTTP header、URL 凭据与明确的 stdio 凭据变量不设长度豁免；只对未标明凭据的普通 stdio 环境值做长度过滤。覆盖短 `X-Api-Key`、短 `API_KEY`、URL 路径中的 key，同时保持 `PORT=8080`、`DEBUG=1` 不误伤地址 |
| G5/G6：不重启发现仍无法阻止已发出的元数据请求覆盖稍后手填的预算 | 回填时比较任务开始的预算快照；预算已改则只保存能力结果，不覆盖预算，也不取消主动探测。覆盖元数据等待期间修改预算，以及实际主动探测等待期间同时修改备注和预算 |
| G7：`6f334142` 用 null 头屏蔽宿主自定义头，若名字恰好是 `Authorization` / `X-Api-Key`，会同时删掉模型自己的认证头 | 保留显式 `authToken: null`、OpenAI admin/org/project 的 null 设置；仅在 SDK 同步构造期间临时移除对应 `*_CUSTOM_HEADERS`，用 `finally` 恢复，无 await，也不修改持久环境。三种协议均捕获实际请求，检查配置 key、标准协议头、环境恢复；另覆盖构造抛错恢复。原补丁的三项冲突头测试失败，修正后 7 项全部通过 |

该 SDK 方案依赖当前安装版本在同步构造时读取自定义头；不访问 SDK 私有字段，也不手工复制 SDK 的认证/协议头生成规则。升级 SDK 时保留这些实请求捕获测试。

**组合验证**：在独立测试进程中排除宿主真实 `ANTHROPIC_*` / `OPENAI_*` 值，注入伪造的 auth token、admin key、org/project，以及与认证/协议头同名的 custom headers，再运行回归。这样验证的是生产隔离行为，而不是依靠清空变量让测试通过。测试使用本地 fixture 或 fetch 捕获，不调用收费模型上游。

最终运行均顺序执行；Vitest 使用 `--no-file-parallelism`。分组存在重叠，下表不是去重后的全仓测试总数。

| 检查 | 最终结果 |
|---|---|
| `pnpm typecheck`、`pnpm build` | 通过 |
| `pnpm lint` | 0 errors / 122 warnings，与原有告警数量一致 |
| LLM 包全部测试 | 23 文件 / 633 测试通过 |
| 设置回归（§5.8 的扩展组） | 87 文件 / 1177 测试通过 |
| 旧入口、TUI、SDK、RPC 兼容回归 | 31 文件 / 482 测试通过 |
| improve-1 工作区回归 | 10 文件 / 89 测试通过 |
| 编译产物模型契约 `compiled-model-contract.integration.test.ts` | 1 文件 / 5 测试通过 |

独立子代理复核了最终 19 个包文件及对应红绿证据，确认四项发现均闭环，没有新的直接回归；组合运行前后源码哈希一致；最终格式检查仅调整一个测试函数的换行与可选尾逗号，已逐字核对没有语义变化。19 个修改的包文件通过定向 Prettier 检查，`git diff --check` 通过。

通过 `calling-pi-agent` 调用 `google/gemini-4-argon`（medium）只读复核，Pi 确认 G1–G7 修复成立，认可当前 SDK 同步构造方案，结论为可提交。主代理复核其关键判断后采纳；不扩展首轮低严重性建议。

提交按 SDK 凭据隔离与 Settings 修复/文档两批组织；原 SDK 提交以内容纳入并附修正，对应本地提交 `f9183e82`。仅本地提交，不 merge、不 push，等待用户审查。
