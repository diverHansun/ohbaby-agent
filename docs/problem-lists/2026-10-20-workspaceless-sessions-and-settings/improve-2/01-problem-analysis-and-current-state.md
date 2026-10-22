# 1. 现状与问题分析

> 代码基线为 `main@231eb8e1`，2026-10-22 调研。本文只写现状和缺口，方案见 [02](02-optimization-plan-and-change-scope.md)。行号是读取时的快照，定位以符号为准。包路径省略 `packages/` 前缀，例如 `ohbaby-agent/src/...`。

## 1.1 问题陈述

1. **完整设置后端还不存在。** daemon 只有零散的模型和搜索 key 入口，没有按分区的设置读写接口。Web 通过斜杠命令弹窗改模型和搜索 key，没有统一的设置页查看 MCP、Skills、Agents。
2. **多套模型配置尚不能完整保存和切回。** `/connect` 已允许为本次配置的模型填写自己的地址、协议、key 和 key 变量名，但 `model.json` 只在顶层保存当前连接及凭据引用，历史模型档案没有保存各自的 key 引用。
3. **MCP 只能手改文件，改完要重启。** 没有写入接口，`McpManager` 没有公开的重载方法，运行时重建也不会重建它。
4. **跨实例通知和配置刷新不完整。** 只有保存模型的那个实例会发出 `model.invalidated`。MCP、Agents 和 Skills 配置文件不在每轮版本检查中；Skill 正文已按需读盘，但目录列表和元数据变化缺少自动刷新触发，不能把两者一概归为必须重启。
5. **四个已证实的缺陷**会直接影响设置页面显示的内容（见 §1.6）。

## 1.2 配置文件一览

| 配置 | 位置 | 读取 | 写入 |
|---|---|---|---|
| 模型 | `~/.ohbaby/model.json` | `ohbaby-agent/src/config/llm/loaders.ts:28`，进程级单例缓存 `manager.ts:65-118` | `config/llm/writer.ts:219` `setActiveLLMConfig` |
| 凭据 | `~/.ohbaby/.env`，另读项目 `.env` | `manager.ts:193-209`：先查 `process.env`，再查全局 `.env` | `config/secrets/env-secrets.ts` `writeGlobalEnvSecret`，只写全局 |
| 联网搜索 | `~/.ohbaby/tools/search.json` | `config/tools/search/loaders.ts:15` | `config/tools/search/writer.ts:23`，有缺陷 |
| MCP | 全局 `~/.ohbaby/mcp/settings.json` + 项目 `.ohbaby/mcp/settings.json` | `config/mcp/loaders.ts:33,41,117`，同名按项目覆盖（`:105`） | 无 |
| Skills | 默认目录 + `skills/settings.json` 额外目录 | `config/skill/loaders.ts:140-207` | 无 |
| Agents | 内置 + 全局/项目 `agents/settings.json` | `config/agents/loaders.ts:32-48,114` | 无 |
| 权限 | 只在内存 | `permission/state.ts:33-34` | `PATCH /v1/permission`，不落盘 |
| 代理、日志、主题 | 只读环境变量 | `utils/network-proxy/policy.ts`、`observability/process-logger.ts`、`ohbaby-cli/src/tui/theme/detect.ts` | 无 |

配置文件都是普通 JSON（`JSON.parse`，如 `config/mcp/loaders.ts:95`），不保留注释，写回时重新格式化不会丢信息。

## 1.3 模型配置

### 数据结构

`ModelJsonConfig`（`ohbaby-llm/src/config/types.ts:43`）的顶层字段是 `provider`、`defaultModel`、`apiConfig{baseUrl, apiKeyEnv?, interfaceProvider?, promptCache?}`、`llmParams` 和可选的 `models[]`。

`models[]` 的元素是 `ModelJsonModelProfile`（`:83`），带 `provider`、`model`、`baseUrl`、`interfaceProvider`、`contextWindowTokens`、`maxOutputTokens`、推理能力等字段，**用于预算和推理能力判断**。其中 `baseUrl` 和 `interfaceProvider` 只是匹配条件，档案不含 key 变量名，也没有办法切换过去，所以它不能直接当作“多套连接”用，但可以当作“某个 provider 下登记过的模型”。档案缺 `provider` 时按顶层 provider 处理（`ohbaby-llm/src/config/model-profile.ts:19,45`）。

校验在 `ohbaby-llm/src/config/validation.ts:177` `validateModelJson`。`ohbaby-llm` 使用顶层当前连接，并读取匹配的 `models[]` 档案用于预算与能力；它不认识 provider 分组或独立连接列表。档案虽有可选 `id`、`label`，现有校验不保证 id 唯一，写入也主要按路由匹配并移到末尾，不能直接保证条目身份和稳定顺序。

`/connect` 面板的 `buildPayload`（`ohbaby-cli/src/tui/components/dialog/connect-panel.tsx:499-535`）同时提交模型和 `apiKey`、`apiKeyEnv`，后端允许不同模型填写不同 key。缺口在保存与恢复：`writer.ts:205-211` 只把 `apiKeyEnv` 写入顶层，历史档案没有该字段；未指定变量名时还会使用仅由 provider 生成的默认名（`writer.ts:233`），无法自动隔离同厂商不同模型的 key。新规划应补齐模型级凭据保存与切换，不能限制为同厂商共用一把 key。

### 写入与生效

- `setActiveLLMConfig`（`writer.ts:219`）在进程内的配置队列 `coordinateModelConfig`（`config-coordination.ts:14`）里执行：读现有文件、合并（`buildModelJson`，`:199`）、原子写入、写 `.env`；失败时回滚，回滚也失败就标记配置不一致。
- `applyActiveModelConfig`（`config/llm/apply-active-model-config.ts:252`）在它外面加了校验、key 解析、上下文窗口探测和后台补充元数据。
- 实例侧 `connectModelInternal`（`adapters/ui-inprocess.ts:3764`）去重相同的保存请求、串行执行，再发布 `model.invalidated`（`:1994`）。
- 对外入口：`GET/POST /v1/model`、`POST /v1/model/context-window-probe`（`ohbaby-server/src/protocols/web/routes/model.ts:16,32,67`），JSON-RPC 的 `getCurrentModel`、`connectModel`，TUI 的 `/connect`。
- `listModelsFromOptions`（`ui-inprocess.ts:2610`）只返回当前模型；`CommandModelProvider.switchModel` 定义了但没有实现。
- **`buildModelJson` 每次保存都按已知字段重新组装整个对象**（`writer.ts:199-217`），只保留 `provider`、`defaultModel`、`apiConfig`、`llmParams`、`models`。文件里的其它字段会在下一次保存时被静默删除。新加的字段（如 `activeProfileId`、条目上的 `apiKeyEnv`）如果不改这里，第一次 `/connect` 就会把它们清掉。另外，`buildModelProfiles`（`writer.ts:137-195`）每次保存都把当前档案移到末尾，所以旧文件的 `models[]` 实际是“最近使用”顺序，不是稳定顺序。
- 现有写入都是“保存并设为当前模型”，没有只保存候选模型的操作。后台 `startModelDiscovery` 也调用 `setActiveLLMConfig` 回写，且按整个配置文件只保留一项发现任务；不能原样用于多个候选模型，否则可能在后台完成时改变当前模型，或互相取消发现任务。
- 模型写入失败时会还原 `.env` 整体备份，搜索的 `writeGlobalEnvSecret` 则直接读改写文件，二者尚未共用同一个协调范围。只分别锁各自 JSON 文件不足以保护这份共用凭据文件。

### 推理能力自动获取的现状补充

`modelProfileRouteKey`（`ohbaby-llm/src/config/model-profile.ts`）已用 provider、模型、接口协议和规范化地址区分档案。`probeContextWindow` 从当前上游的模型元数据读取能力，`startModelDiscovery` 在必要时调用 `probeReasoningCapabilities` 主动探测，并用配置版本检查防止过期结果回写。

但当前自动获取仍有名称依赖：`ohbaby-llm/src/providers/reasoning.ts` 的内置规则同时要求 provider 名称（`openai`、`anthropic`、`zenmux`，约 L124、L186、L227）、官方地址和模型名匹配，用户给官方地址起别的名字就命中不了；`reasoning-active-probe.ts` 按 `provider === "openai"` 选择部分探测字段。`startModelDiscovery` 也会因已有档案或内置能力而跳过主动探测。主动探测会针对每个强度档位真实发送聊天请求（`reasoning-active-probe.ts`），有费用和耗时；OpenAI 等上游的模型元数据不提供推理档位，去掉内置规则会让这些官方模型退回 unknown。新增自定义名称和多模型管理时，需要让设置返回的能力依据当前完整配置的上游证据，不能仅由名称或另一配置的旧结果决定。

### 版本检查：已有的生效机制

每个实例的 `InProcessRuntimeController` 在每轮开始前比较配置版本（`adapters/ui-inprocess/runtime-controller.ts:66`）。版本是 `model.json` 和全局 `.env` 的哈希（`config-coordination.ts:61` `modelConfigVersion`，接线在 `ui-inprocess.ts:1011`）。版本变了：空闲就重建运行时；忙就提示 “Waiting to switch model” 并稍后再试。

这套机制已经能保证“下一轮生效、不打断当前轮”，而且对手改文件同样有效。缺口有三处：

- 只覆盖模型和 `.env` 两个文件。
- 注入 LLM 客户端时整个检查不接线（`ui-inprocess.ts:1007-1014`），daemon 集成测试和部分宿主就是这种情况。
- 重建运行时只重新加载 LLM 配置。搜索配置是进程级缓存（`config/tools/search/index.ts`），只有保存搜索 key 时才重读。运行时组装订阅了 `mcpManager.onChange`（`composition.ts:1159`）和 Skills 注册表的变化，`dispose` 时不取消订阅。

## 1.4 MCP

- 配置字段（`config/mcp/types.ts:103-150`）：通用的 `enabled`、`trust`、`timeout`、`includeTools`、`excludeTools`；stdio 有 `command`、`args`、`env`、`cwd`；http/sse 有 `url`、`headers`。`env` 和 `headers` 里经常放 token。
- 合并后不保留来源，无法知道某个服务器来自全局还是项目。
- `McpManager`（`mcp/core/manager.ts:37`）按目录取单例（`getInstance`，`:78`），只在 daemon 关闭时 `disposeAll`（`host/core-api-factory.ts:125`）。运行时重建复用同一个 manager（`adapters/ui-runtime/composition.ts:1062`）。
- `getStatus()` 状态完整：`connected` 带 `toolCount`，`failed` 带 `error`。`getAllTools()` 返回按 `includeTools/excludeTools` 过滤后的工具。
- 已经有完整的重载逻辑，但是私有：`invalidateAfterConfigChange()`（`manager.ts:365`）断开全部客户端、清空状态，下次使用时按最新配置重新连接。目前只在插件变化时调用。
- `notifyChanged()` 与组装层的变化回调是异步触发；公开重载方法还需接到现有运行准入协调，并等待工具刷新完成，不能只在发出通知后就报告重连完成。
- 命令层摘要 `mcpStatusToSummary`（`composition.ts:259`）只留下 `{ name, status }`，丢掉了错误和工具数（`commands/types.ts:52`、`commands/normalize.ts:54`）。

## 1.5 Skills 与 Agents

- `SkillInfo`（`skill/types.ts:25-39`）保留了 `source`、`scope`、`location`、`userInvocable`、`disableModelInvocation` 等信息，设置页需要的数据都在。已有 Skill 的正文由 `SkillLoader.loadContent()`（`skill/loader.ts:589`）每次从磁盘读取，正文修改无需重启；名称、描述、调用权限和条目列表仍由 `SkillRegistry.getCache()`（`skill/registry.ts:30`）缓存。
- 注册表已有 `reload()`、插件注册/移除时的失效与通知，`composition.ts:1043-1050` 也订阅变化并刷新 Skill 工具。当前生产源码未找到调用这些刷新 API 的外部触发者，也未找到普通 Skill 文件变更监听。因此不能笼统说“没有动态加载”，也不能把“正文实时读取”当成“目录列表已自动刷新”。
- 实例为每个目录缓存一个 `SkillRegistry`（`ui-inprocess.ts:2424`），它只用默认目录，并作为参数传给运行时组装，绕过了 `loadConfiguredSkillDirectories`（`composition.ts:1032-1041`）。这个缓存跨运行时重建保留。TUI 与 daemon 都经 persistent → in-process backend 使用这条链路，不能将此缺口仅归于 Web。
- 2026-10-22 用显式限定目录的真实 `SkillLoader`/`SkillRegistry` 做临时目录验证：正文修改能立即读到，description 仍是缓存；新增、删除目录后列表不变，读取已删正文失败；显式 `reload()` 后列表更新；调用插件注册/移除 API 可使列表刷新。断言全部通过，临时目录已清理；没有修改实际 Skill 或业务代码。本轮应复用现有机制补齐普通目录变化触发，不把重启作为产品要求。
- `AgentConfig` 有 `disabled`、`hidden`、`mode`、`description`、`permission` 等字段（`config/agents/types.ts:113-128`）。`AgentRegistry.initialize`（`agents/registry.ts:92`）把内置与用户配置合并后不保留来源。
- 运行时组装用 `new AgentManager()`（`composition.ts:291`），注册表默认加载器调用 `loadAgentConfig()` 时不传目录（`registry.ts:21`），项目路径回落到 `process.cwd()`（`config/agents/loaders.ts:40`）。

## 1.6 已证实的缺陷

| ID | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| B1 | 保存搜索 key 时只写回 `{apiKeyEnv, provider}`，丢掉已有的 `baseUrl` 和 `defaults` | `config/tools/search/writer.ts:42-45,54` | 用户手配的搜索参数被静默删除 |
| B2 | 共享 in-process backend 的 Skills 注册表只用默认目录，忽略 `skills/settings.json` 里的额外目录 | `ui-inprocess.ts:2424-2433` 与 `composition.ts:1032-1041` | TUI 与 daemon 都可能遗漏额外目录，与未注入注册表的备用组装路径不一致 |
| B3 | Agents 的项目配置按 `process.cwd()` 查找 | `composition.ts:291`、`registry.ts:21`、`config/agents/loaders.ts:40` | 多目录 daemon 里，项目 A 可能读到启动目录的 Agents 配置 |
| B4 | MCP 摘要丢掉错误和工具数 | `composition.ts:259` | `/mcps`、`/status` 和设置页看不到失败原因 |

B2、B3 是根据代码路径确认的，没有用真实 daemon 复现，实施时先写失败测试再修。

## 1.7 服务端与 SDK

- daemon 全局层路由在 `ohbaby-server/src/runtime/daemon/server.ts:259-275`，目前有 scopes、目录选择、连接列表和 improve-1 新增的全局会话接口。全局接口的业务逻辑放在 `coordination/` 等模块，`server.ts` 只负责挂载，例如 `moveSessionProject`（`:654`）。
- 其余 `/v1/*` 按 `x-ohbaby-directory` 分发到实例（`server.ts` `dispatchWorkspaceRequest`）。设置相关的实例路由只有 `routes/model.ts` 里的四个。
- `InstanceStore`（`runtime/instance-store.ts:16`）可以列出已加载的 scope（`loadedScopeKeys`）并取得实例，没有通知钩子。
- SDK 只有契约类型和进程内 RPC，没有 HTTP 客户端；Web 自己的 HTTP 客户端在 `apps/ohbaby-web/src/api/daemon/http.ts`。设置相关类型目前有 `contract/connect-model.ts`、`contract/connect-search.ts`。
- 关于页需要的数据都已存在：`getAgentPackageVersion()`（`ohbaby-agent/src/package-version.ts:15`）、诊断文件路径（`ohbaby-server/src/runtime/daemon/main.ts:623`）、默认工作区（improve-1 已实现）。`/status`（`commands/builtin.ts:258`）有现成的汇总，但它是命令输出，不是结构化接口。

## 1.8 Web 现状（只为框定范围）

Web 没有设置页。模型通过 `ConnectOverlay.tsx` 修改，搜索 key 通过同文件的 `ConnectSearchOverlayBody` 修改，二者都从斜杠命令面板打开。`ReasoningControl.tsx` 监听 `model.invalidated` 刷新。本轮不改 Web。

## 1.9 SWE 原则审视

| 发现 | 判断 |
|---|---|
| 配置按领域分文件，各自有加载器和校验 | 关注点分离合理。不建统一的“设置存储”，按领域加写入函数即可 |
| 运行时已有“每轮开始前比较配置版本”的机制 | 好的设计，直接扩大覆盖范围，比加文件监听简单 |
| MCP 已有失效和工具刷新链路 | 复用并补齐公开入口、运行准入和等待完成，不需要新重连系统 |
| 来源信息在合并时丢失（MCP、Agents） | 边界处丢信息，下游补不回来；需要在加载时保留 |
| 全局配置写入放在实例层 | 写的是全局文件，却挂在某个目录上，导致只有一个实例知道变化。这是“改完别的实例不知道”的根因 |
| 运行时依赖 `process.cwd()` | 单目录 CLI 时代的隐含假设，在多目录 daemon 里是错的 |

## 1.10 与既有文档的关系

- [improve-1 02 §2.4](../improve-1/02-optimization-plan-and-change-scope.md) 的设置方案被本轮取代，见 [00 §5](00-discussion.md)。
- [多项目运行时](../../../ohbaby-server/hono-app/04-multi-project-runtime.md)：本轮新增全局设置路由后需同步。
- [ohbaby-llm 抽包](../../2026-10-21-llm-package-extraction/README.md)：`ohbaby-llm` 只负责按当前连接调用模型，不读配置文件。`validateModelJson` 和 `validateModelProfile`（`ohbaby-llm/src/config/validation.ts:101`）都不拒绝多余字段。本轮条目上新增的 `apiKeyEnv`、`promptCache`、`needsConfiguration` 和顶层 `activeProfileId` 只在 agent 侧定义、校验和读写，不进入 `ohbaby-llm`。
