# 5. 实施与验收记录

> 2026-10-23：后端实现、最终验证、独立子代理及 Pi 审查均已完成，等待用户最终审查。

实施分支：`codex/settings-backend-2026-10-22`。规划基线：`231eb8e1`。范围为设置后端、SDK 契约与接口文档；前端入口和页面留待后续。实施按当前 02/04 执行，原始规划不改写成进度表。

## 5.1 分批结果

| 批次 | 提交 | 实现与验证 |
|---|---|---|
| Stage 1 | `ed66177e` | 修 B1–B4；六分区设置版本、下一轮按需应用、共享 Skill 自动刷新、MCP 重载等待与订阅清理。最终定向 19 文件 / 206 测试；真实 daemon 10 测试在修复轮 1 通过。 |
| Stage 2 | `cc6f43a5` | MCP 状态、Skills、Agents 实例读取与来源；SDK 契约。初次 19 文件 / 355 测试及 daemon 10 测试；修复后分别 84、27 项受影响回归通过。 |
| Stage 3 | `4b7fae97` | 全局搜索/MCP/about、共享凭据协调与回滚、已加载实例通知、当前项目显式 MCP 重连。初次 34 文件 / 426 测试；最终脱敏修复后 4 文件 / 39 测试。 |
| Stage 4a | `504ec6f2` | 独立模型条目、迁移与当前投影、CRUD/选择/删除顺延、key 隔离、按条目发现与防止过期写回。初次 67 文件 / 926 测试；并发旧 connect 修复后 23 文件 / 357 测试。 |
| Stage 4b | `8ea31752` | 去除能力判断对 provider 名称的依赖、按条目 probe、三协议发现、当前模型推理偏好兼容、全量 Settings OpenAPI。初次 49 文件 / 728 测试；当前项 PATCH 修复后 24 文件 / 237 测试。 |

以上已提交批次都在测试、独立子代理审查和 Pi `google/gemini-4-argon`（`medium`）检查通过后提交；类型检查通过。完整 lint 仍为基线已有的 122 warnings、0 errors，未扩大到无关清理。表中批次计数存在重叠，不能相加作为独立测试总数。

## 5.2 T1–T23 验收证据

以下路径省略 `packages/ohbaby-agent/src/`；服务器路径以 `server:` 表示 `packages/ohbaby-server/src/`。每组由真实临时配置和现有测试机制验证，不把规划文字当作执行结果。

| 标准 | 主要证据 | 关键行为 |
|---|---|---|
| T1 | `config/tools/search/__tests__/writer.unit.test.ts`、`adapters/settings-refresh.integration.test.ts` | 保存搜索 key 保留自定义字段，包括旧路径的有效配置。 |
| T2、T3 | `adapters/settings-refresh.integration.test.ts` | 配置目录中的 Skill 进入模型工具；不同项目的 Agents 分别加载，启动 cwd 不串用。 |
| T4 | `adapters/ui-runtime/composition.unit.test.ts`、`commands/normalize.unit.test.ts` | MCP 命令摘要保留 error/toolCount，并兼容旧字段。 |
| T5–T7 | `server:app/settings-read.integration.test.ts`、`services/settings/reader.unit.test.ts` | 实际 MCP/Skill/Agent 来源及覆盖、过滤后工具数、目录隔离、缺目录头和错误脱敏。 |
| T8 | `config/tools/search/__tests__/settings-writer.integration.test.ts`、`server:app/settings-global.integration.test.ts` | 字段合并、key 三态和共享引用；下一次真实本地 web_search 请求使用新地址、key 与 defaults。 |
| T9、T10 | `config/mcp/__tests__/writer.integration.test.ts`、`server:app/settings-global.integration.test.ts` | 全局服务器补丁/启停/删除、非法配置不落盘、项目覆盖信息和实际 about 数据；全局请求不需要目录头。 |
| T11 | `services/settings/reader.unit.test.ts`、两个 settings HTTP 集成文件及模型设置测试 | 对完整响应检查 key/env/header 测试值，覆盖成功 URL 与错误脱敏。MCP args 按已批准合同原样返回。 |
| T12 | `adapters/settings-refresh.integration.test.ts`、`config/llm/__tests__/settings-version.unit.test.ts` | 当前轮不被打断；各设置分区下一轮应用；仅模型变化不重连 MCP；注入客户端仍刷新其它分区。 |
| T13、T14 | `server:app/settings-global.integration.test.ts`、`adapters/ui-inprocess/runtime-admission.unit.test.ts` | 真实 daemon A/B/C、SSE 和 stdio 子进程验证通知及连接次数；只重连请求目录，等待工具刷新，忙碌时拒绝且不与新轮次交错。全局模型保存后的后台发现及手动 probe 均通过实际 HTTP/SSE 验证双事件。T14 的子代理/后台活动由准入控制测试覆盖，不宣称每种活动都另跑完整 HTTP 场景。 |
| T15 | `config/llm/__tests__/model-document.integration.test.ts`、`model-settings.integration.test.ts` | GET 不写文件、稳定 ID、首次写入固化、保持原预算/能力匹配、历史条目补齐与空选择。 |
| T16 | `model-settings.integration.test.ts`、`config-commit.integration.test.ts`、`adapters/model-settings-runtime.integration.test.ts` | 独立 key/协议/地址，模型搜索共享引用隔离与失败回滚；正常 loader 下两项目旧 A 轮完成、下一轮用 B。 |
| T17 | `model-settings.integration.test.ts`、`profile-route.integration.test.ts`、原有 TUI/SDK/JSON-RPC 回归 | 旧 connect 首条规范化路由匹配、保存并启用、不丢兄弟条目；并发旧 connect 发现仍按各自保存的 ID。 |
| T18 | `model-entry-probe.integration.test.ts`、`reasoning-active-probe.unit.test.ts`、`ohbaby-llm/src/providers/reasoning.unit.test.ts`、实际全局 HTTP 测试 | 自定义 provider 名称仍命中官方规则；本地 HTTP 覆盖 Chat/Responses/Anthropic 元数据与主动探测、鉴权和控制请求、按 id 写回；重新加载后验证实际推理字段解析。显式覆盖保留，内置优先于旧自动结果。 |
| T19、T22 | `model-settings.integration.test.ts`、`model-entry-discovery.integration.test.ts`、正常 loader 运行时测试 | 新增不查重且不选择；各 ID 独立；切换、编辑和后台写回不改顺序；候选互不取消。 |
| T20 | `model-entry-discovery.integration.test.ts`、元数据/推理测试及运行时测试 | 保存先返回；候选只有元数据 GET；失败不撤销保存；unknown 不猜参数；同变量换 key 的旧响应不能回写。新结果替换旧自动结果；获取失败保留已有确认值；确认无推理能力时不再主动探测。准备阶段 I/O 失败不让后台任务产生未处理拒绝。 |
| T21 | `model-settings.integration.test.ts`、`model-entry-discovery.integration.test.ts`、正常 loader 运行时测试 | 单删/整组删除、原顺序循环、跳过不完整历史、保留 key；删完后新轮次拒绝旧缓存，晚到结果不复活条目。 |
| T23 | `adapters/settings-refresh.integration.test.ts`、`skill/registry.unit.test.ts` | 生产入口发现 Skill 正文/描述变化、增删，不需要打开设置或手动 reload；签名未变不重解析。 |

上述 `model-*.integration.test.ts`、`config-commit.integration.test.ts`、`profile-route.integration.test.ts` 未单独标目录时均位于 `config/llm/__tests__/`。更细的设计条件保留在 [04](04-test-and-acceptance.md)。

## 5.3 最终验证

在包含 Stage 4b 当前项 PATCH 修复的冻结源码上顺序执行，七组均返回 exit 0。没有同时运行会改写共享 dist 的任务。

| 命令/分组 | 结果 |
|---|---|
| `pnpm build` | 通过；Web 构建仍提示大 chunk，不属于本轮后端调整范围 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors / 122 warnings，与实施前基线一致 |
| Settings 定向回归 | 73 文件 / 858 测试通过 |
| 旧入口、TUI、SDK、RPC 兼容回归 | 29 文件 / 449 测试通过 |
| improve-1 工作区回归 | 10 文件 / 89 测试通过 |
| 编译产物模型合同 | 1 文件 / 5 测试通过 |

这些是下列范围的验证，不代表运行了仓库内所有测试。真实请求均访问本地测试上游；未调用收费厂商或测试前端页面。可复跑命令：

```sh
pnpm exec vitest run --no-file-parallelism \
  packages/ohbaby-server/src/app/settings-read.integration.test.ts \
  packages/ohbaby-server/src/app/settings-global.integration.test.ts \
  packages/ohbaby-agent/src/adapters/settings-refresh.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-admission.unit.test.ts \
  packages/ohbaby-agent/src/services/settings \
  packages/ohbaby-agent/src/config/llm/__tests__ \
  packages/ohbaby-agent/src/config/tools/search/__tests__ \
  packages/ohbaby-agent/src/config/mcp/__tests__ \
  packages/ohbaby-agent/src/config/skill/__tests__ \
  packages/ohbaby-agent/src/config/agents/__tests__ \
  packages/ohbaby-agent/src/services/search-providers/__tests__ \
  packages/ohbaby-agent/src/services/llm-model \
  packages/ohbaby-agent/src/mcp \
  packages/ohbaby-agent/src/skill \
  packages/ohbaby-agent/src/agents \
  packages/ohbaby-llm/src/config/__tests__/validation.unit.test.ts \
  packages/ohbaby-llm/src/providers/reasoning.unit.test.ts \
  packages/ohbaby-agent/src/adapters/model-settings-runtime.integration.test.ts \
  packages/ohbaby-server/src/app/create-app.unit.test.ts
```

```sh
pnpm exec vitest run --no-file-parallelism \
  packages/ohbaby-agent/src/commands/catalog.unit.test.ts \
  packages/ohbaby-agent/src/commands/service.unit.test.ts \
  packages/ohbaby-agent/src/commands/connect.unit.test.ts \
  packages/ohbaby-agent/src/commands/connect-search.unit.test.ts \
  packages/ohbaby-agent/src/adapters/model-switch.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-model-notifications.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-state/model-recovery.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts \
  packages/ohbaby-cli/src/tui/components/dialog/connect-panel.unit.test.tsx \
  packages/ohbaby-cli/src/tui/components/dialog/connect-search-panel.unit.test.tsx \
  packages/ohbaby-cli/src/tui/components/dialog/command-panel-state.unit.test.ts \
  packages/ohbaby-cli/src/tui/slash-commands \
  packages/ohbaby-cli/src/tui/fullscreen-panels.contract.test.tsx \
  packages/ohbaby-cli/src/tui/render/status-panel.unit.test.ts \
  packages/ohbaby-sdk/src/contract \
  packages/ohbaby-sdk/src/in-process-rpc/proxy.unit.test.ts \
  packages/ohbaby-server/src/protocols/jsonrpc \
  packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts \
  packages/ohbaby-server/src/runtime/daemon/client.integration.test.ts \
  packages/ohbaby-server/src/public-api.unit.test.ts
```

```sh
pnpm exec vitest run --no-file-parallelism \
  packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts \
  packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts \
  packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts \
  packages/ohbaby-server/src/runtime/instance-store.unit.test.ts \
  packages/ohbaby-server/src/protocols/global-sessions.unit.test.ts \
  packages/ohbaby-server/src/coordination/session-project-move.unit.test.ts \
  packages/ohbaby-agent/src/services/session/global-query.integration.test.ts \
  packages/ohbaby-agent/src/services/session/project-binding.integration.test.ts \
  packages/ohbaby-agent/src/adapters/session-project-move.integration.test.ts \
  packages/ohbaby-agent/src/paths/default-workspace.unit.test.ts
```

```sh
pnpm exec vitest run --no-file-parallelism \
  tests/integration/compiled-model-contract.integration.test.ts
```

## 5.4 审查结果与 SWE 取舍

分批审查修复了：有效搜索文件与版本路径不一致、Skill/搜索首轮缓存刷新、Agent 别名来源、成功 URL/错误中的凭据脱敏，并发旧 connect 发现目标被更晚选择覆盖，以及编辑当前模型后旧推理档位导致下一轮失败。每项使用针对性先失败后通过的回归，修复后复审；未把微优化建议扩展为额外架构改造。

遵循现有职责：文件规范化、凭据和发现留在 agent 配置模块；ohbaby-llm 只接收所选模型投影并负责协议规则；server 路由负责校验和适配；SDK 只增加类型。继续复用运行准入、配置协调队列、原子写入、加载器、注册表和事件流。没有新增 provider 连接表、通用事务框架、文件监听器、后台轮询或 SDK HTTP 客户端。新增的模型文档规范化层用于表达多条独立配置与无当前项，避免让 LLM 包承担磁盘迁移职责，符合单一职责和 KISS/YAGNI。

整轮独立代码审查结论为 Spec PASS、Quality/SWE APPROVED，没有剩余问题。独立文档审查纠正了两处旧搜索入口事件描述：旧模型入口发布本实例 `model.invalidated`，旧搜索 key 入口只写入并刷新配置，不发布 `settings.changed`；文档复审通过。Pi `google/gemini-4-argon`（`medium`）逐批检查，并确认最终文档及上述修正可提交。Stage 4b 当前项 PATCH 的代码修复也已通过独立复审与 Pi 检查。

## 5.5 使用与回退边界

- 配置在下一轮应用；保存 MCP 不主动重连其它项目，需要立即验证时只请求当前项目重连。
- 新模型先保存再选择；旧历史条目不猜 key，可通过明确无 key 或补充连接完成配置。
- Stage 4a 的文件结构不能任意交回旧版本继续保存：旧版可能丢失新增字段，也不支持 `active: null`。回退前备份新文件，并恢复升级前配置。
- 协调保证限单进程，不增加跨进程事务。自动能力未知时用上游默认；没有真实收费上游或浏览器页面走查结论。
- 用户最终审查待进行；本地分支保留，不 merge、不 push。
