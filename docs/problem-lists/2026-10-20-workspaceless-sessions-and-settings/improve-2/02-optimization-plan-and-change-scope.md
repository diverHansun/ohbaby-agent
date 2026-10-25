# 2. 优化方案与改动面

> 2026-10-22 已确认的规划，尚未实施。决策见 [00](00-discussion.md)，现状见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。产品取舍已确认，内部函数名可按代码风格调整。

## 2.1 方案总览

设置按数据性质放在两层。全局配置文件由 daemon 全局层读写；随目录变化的运行状态由各目录实例提供。所有写入只改全局文件，写完通知已加载的实例；实例在下一轮开始前发现配置变了，就重建运行时，必要时重连 MCP。

```
Web/客户端
  │
  ├─ 不带目录头 ──▶ daemon 全局层  /v1/settings/models | search | mcp/servers | about
  │                   │ 1. 调 agent 的写入函数改全局文件（按文件排队、先读后改、整体校验、原子写）
  │                   │ 2. 通知所有已加载实例 → 各实例发布 settings.changed 事件
  │
  └─ 带目录头 ────▶ 目录实例      /v1/settings/mcp/status | mcp/reconnect | skills | agents
                      │
                      └─ 每轮开始前比较设置版本（各配置文件的哈希）
                           变了：空闲 → 重建运行时（MCP 配置变了才重连）；忙 → 提示并稍后再试
```

这套设计不新增存储，不加文件监听。生效机制复用现有的模型版本检查，只扩大它覆盖的文件。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 接口分层 | 全局配置放全局层，目录相关的放实例层 | 全局文件和目录无关；全局层可以一次通知所有实例 | 全部放实例层（improve-1 方案） | Web 要区分两类请求，是否带目录头 |
| 接口形态 | 按分区的独立资源接口 | 各分区文件、校验、凭据规则都不同；一个分区出错不影响其它 | 单个 `GET /v1/settings` 聚合快照；通用的键路径 PATCH | 接口数量多一些 |
| 写入范围 | 只写全局文件，项目配置只读 | API 不需要判断写到哪一层 | 允许写项目配置 | 项目配置仍需手改 |
| 多模型存储 | 连接字段直接放在 `models[]` 条目里，provider 只是条目字段；顶层保留当前模型快照 | 现有档案已有大部分字段，模型之间互不影响；LLM 只接收当前配置投影 | 按 provider 共享连接；另建 `providers` 连接表并保留删除后的孤立连接；新开配置文件 | 写当前模型时需要同步顶层快照 |
| 保存与切换 | 新增候选模型独立保存，不查重；显式选择时切换全局当前项，删除当前模型时自动切到下一个 | 新增配置不改变当前选择，删除当前项不要求先手动切换；查重需比较 key 原文，不划算 | 新增模型时自动切换；要求先切换才能删除当前模型；按凭据查重 | 用户可能保存出内容相同的条目，靠备注和前端提示区分 |
| 保存与能力获取 | 本地校验与写入成功后返回，后台自动获取能力；未知时使用上游默认 Reasoning 行为 | 不让上游连通性成为保存配置的前提 | 必须上游验证成功才保存；能力未知时反复警告或阻止使用 | 保存成功不代表已确认上游可用 |
| 推理能力 | 保留内置规则但去掉 provider 名称条件；候选模型只读元数据，主动探测只在选为当前模型或手动 probe 时进行；结果按条目记录 | 自定义名称也能命中官方规则；避免每保存一个模型就付费探测 | 去掉内置规则、每个条目都主动探测；新增手填能力接口 | 候选模型在被选用前可能停留在 unknown |
| 生效时机 | 配置写入在下一轮开始前通过版本检查生效；MCP 可按需显式重连当前项目；Skill 沿用动态读取和刷新机制 | 不打断当前轮，不要求用户为 Skill 变化重启 | 通用文件监听；保存 MCP 后自动重载所有空闲实例 | 已初始化项目的 MCP 连接状态在下一轮或显式重连前仍反映旧配置 |
| 并发写 | 进程内排队，写前重读，只改目标条目；共用 `.env` 的写入与回滚统一协调 | 复用现有队列，避免模型和搜索的 key 互相覆盖 | 新事务框架、跨进程锁或乐观锁 | 不承诺与其它 CLI 进程或手改文件的同时写入隔离 |
| 凭据 | 每个模型可独立配置 key，保存模型级变量引用；只返回变量名和是否已配置，key 三态更新 | 保留 `/connect` 的输入能力，切回模型时恢复正确凭据 | 同厂商强制共用 key；回传原文 | 模型写入和切换需要同步凭据引用 |

## 2.3 数据模型

### model.json 的模型条目

每个模型条目自带完整连接配置，直接放在 `models[]` 里。provider 只是条目上的一个字段，用来分组展示和整组删除，不另建 `providers` 结构或连接表。

```jsonc
{
  "activeProfileId": "profile-work",     // agent 的当前选择
  "provider": "my-provider",             // 以下顶层字段是兼容当前运行时的快照
  "defaultModel": "model-x",
  "apiConfig": {
    "baseUrl": "https://api.example/v1",
    "interfaceProvider": "openai-compatible",
    "apiKeyEnv": "OHBABY_MODEL_PROFILE_WORK_API_KEY"
  },
  "llmParams": { "maxTokens": 8192 },
  "models": [                            // 顺序就是模型列表顺序
    {
      "id": "profile-work", "provider": "my-provider", "model": "model-x", "label": "工作用",
      "baseUrl": "https://api.example/v1", "interfaceProvider": "openai-compatible",
      "apiKeyEnv": "OHBABY_MODEL_PROFILE_WORK_API_KEY", "contextWindowTokens": 128000
    },
    {
      "id": "profile-personal", "provider": "my-provider", "model": "model-x", "label": "个人用",
      "baseUrl": "https://api.example/v1", "interfaceProvider": "openai-compatible",
      "apiKeyEnv": "OHBABY_MODEL_PROFILE_PERSONAL_API_KEY", "contextWindowTokens": 128000
    }
  ]
}
```

现有 `ModelJsonModelProfile` 已经有 `id`、`provider`、`model`、`label`、`baseUrl`、`interfaceProvider`、预算和能力字段。agent 侧的条目类型在此基础上只增加 `apiKeyEnv`、`promptCache` 和历史迁移用的 `needsConfiguration`，`ohbaby-llm` 的类型不变。`ohbaby-llm` 不校验条目上的 `apiKeyEnv`，所以 agent 写入前要检查它是合法的环境变量名。`contextWindowTokens` 在档案里是必填，新增时未提供就把现有默认值写进文件。

规则：

1. **每个条目独立。** 地址、协议、`apiKeyEnv`、`promptCache` 只属于这个条目，不从其它条目继承。修改只影响目标条目，不联动同 provider 的其它条目。新增模型直接追加条目，不需要先创建服务商。
2. **当前快照只从所选条目生成。** `activeProfileId` 定位条目，生成顶层 `provider/defaultModel/apiConfig` 和当前上下文预算。文件结构、无默认模型状态均由 agent 读取和校验。`ohbaby-llm` 只接收当前配置投影，`models[]` 只附带所选条目一条档案。不能把磁盘上的全部 `models[]` 交给 `resolveModelProfiles`：同路由不同 key 的两个条目会混用能力。
3. **所有入口用同一套条目写入逻辑。** 改造 agent 的读取、`buildModelJson` 和 `setActiveLLMConfig` 路径，保留所有非目标条目和全局生成偏好。新增、编辑、删除、选择是不同操作；旧 `/connect` 的“保存并启用”是这些操作的兼容组合。后台元数据写回只更新目标条目，不能借 `setActiveLLMConfig` 顺带激活它。
4. **条目 id 稳定，列表顺序稳定。** 复用已有档案的 `id`，新条目由后端生成唯一 id。编辑名称、地址、协议、key、备注、provider 或切换当前项，都不改 id、不重排。新增追加到末尾，读取顺序与文件一致。`label` 是可选备注，不改变上游模型名。
5. **保存与选择分开。** 新增或编辑非当前条目不改变当前快照或全局生成参数；没有当前项时，新增第一条也不自动启用。编辑当前条目时同步当前快照，当前轮继续完成，下一轮使用新配置。显式选择只接受已保存且配置完整的条目，下一轮对所有会话生效。
6. **独立 key 仍存全局 `.env`。** 每个条目保存自己的 `apiKeyEnv`；通过设置接口给新 key 时，默认生成与条目 id 对应的独立变量名（如 `OHBABY_MODEL_<ID>_API_KEY`）。用户明确填写的变量名照常使用。替换或清除目标条目的 key 时，不能改动其它条目或搜索仍在引用的变量：有共享引用时为目标条目分配独立变量，清除时只解除目标引用。具体三态见下文。
7. **新接口不查重。** 每次新增都是独立条目，同 provider、同模型名可以因 key 或协议不同分别保存，用备注区分。不读取、不比较 key 原文或指纹。旧 `/connect` 的匹配规则见 §2.4。
8. **单删模型就是移除整个条目。** 只保留 `.env` 中的 key，不保留连接。删除非当前条目不切换；删除当前条目时，同一次文件写入按原列表顺延、末尾循环，选择下一条配置完整的条目。当前轮不中断，下一轮生效。
9. **删除服务商就是删除 `provider` 等于它的全部条目。** 同一次写入完成；若包含当前条目，按原列表跳过本次所有被删条目顺延循环。其它条目顺序不变，所有 `.env` key 保留。后台晚到的元数据结果不能恢复已删除的条目。
10. **没有可选择模型时没有默认模型。** 清除 `activeProfileId`、顶层 `provider/defaultModel/apiConfig` 和 `llmParams.contextWindowTokens`，保留其余条目、全局生成偏好和 key，读取返回 `active: null`。已有会话历史仍可读取，正在执行的轮次继续完成；新轮次不得沿用旧缓存中的已删除模型。新增后仍需明确选择。

### 旧文件读取与首次写入

- 设置读取先在内存规范化，不要求先保存才能使用新接口。保留有效且唯一的旧 id；缺失或重复时，用旧条目顺序与非敏感路由字段生成确定性 id。同一旧文件多次 GET 返回相同 id。首次写入在同一协调队列中重读、规范化并固化 id、连接字段和当前选择，不另建迁移命令。
- **定位当前档案用预算匹配器** `activeModelBudgetProfiles`（`ohbaby-llm/src/config/model-profile.ts:29`），它在全部档案中选最具体的一条。用顶层 `apiConfig` 补齐它的连接字段（含 `apiKeyEnv`、`promptCache`）并写入 `activeProfileId`；没有匹配档案时按顶层合成当前条目。顶层缺 `interfaceProvider` 时用 `inferConnectModelInterfaceProvider` 推断，与 `manager.ts` 一致，不用写入函数的 `openai-compatible` 默认值。预算与全局生成偏好保留，迁移不能切换模型。
- **能力档案不能在迁移中悄悄改变。** 旧代码的能力匹配（`capabilitiesFor`，`reasoning.ts:81`）只看带能力的档案，并且可以命中缺 provider 或 `baseUrl` 的通配档案。迁移后只投影所选条目，这些通配档案不再生效。所以迁移时，把能匹配当前配置的通配档案上的显式能力合并进当前条目；缺 provider、`baseUrl` 或 `interfaceProvider` 的通配档案本身标记为 `needsConfiguration`。
- 旧文件的 `models[]` 是“最近使用”顺序（当前档案每次被移到末尾），规范化时按文件现有顺序固定下来，此后不再重排。
- 其它历史档案由 `buildModelProfiles` 写入，带 `provider/model/baseUrl/interfaceProvider/contextWindowTokens`，但从没有 `apiKeyEnv` 和 `promptCache`。`promptCache` 不从顶层继承，缺省即默认策略。没有 `apiKeyEnv` 就无法区分“无 key 模式”和“缺 key”，因此标记 `needsConfiguration: true`，响应中 `configurationComplete: false`。不猜测旧 key，不自动发现或选用。用户通过 PATCH 补齐（可明确传 `apiKeyEnv: null` 表示无 key 模式）后清除标记。只在选择未补齐条目时返回 `MODEL_CONFIG_INCOMPLETE`，不反复通知。缺 `baseUrl` 或 `interfaceProvider` 的更早档案同样处理。
- 删除后的自动顺延只跳过配置不完整的条目；网络状态、推理能力未知或上游暂时不可用不影响顺延资格。只剩不完整条目时 `active: null`，条目保留供补齐。
- 旧 TUI/Web 接口的读取也经过同一个 agent 规范化和投影边界；无当前项时返回原有的未配置结果。`ohbaby-llm` 不学习条目列表、迁移标记或磁盘读取。
- 不能只替换设置 GET：`writer`、配置 `manager`、`apply-active-model-config` 的前台与后台读取，以及 `ui-inprocess` 的当前模型与能力读取，都要经过同一边界，不能再直接对磁盘文件调用旧 `validateModelJson`。

### 推理能力

能力按条目 id 分别记录。来源按优先级：

| 来源 | 什么时候用 | 成本 |
|---|---|---|
| 内置规则（`ohbaby-llm/src/providers/reasoning.ts`） | 命中即用，不再探测 | 无网络请求 |
| 上游模型元数据 | 保存任何条目后在后台读取 | 一次便宜的元数据请求 |
| 主动探测（`reasoning-active-probe.ts`） | 条目被选为当前模型、或调用 `POST /v1/settings/models/probe` 时，且前两者都没有给出结果 | 每个档位真实发一次聊天请求 |

- **内置规则保留，只去掉 provider 名称条件。** 现有规则同时检查 provider 名称、官方地址和模型名，例如 `provider === "openai"` 加 `https://api.openai.com/v1`。改为只按官方地址 + 模型名 + 协议匹配，用户给官方地址起任何名字都能命中。`reasoning-active-probe.ts` 中按 `provider === "openai"` 选择请求字段的分支，改为按地址或协议判断。规则内容本身不扩充。
- **候选模型不主动探测。** 保存先完成本地校验和文件写入，立即返回，再在后台读元数据。超时、鉴权失败或上游没有能力字段，不撤销已保存的配置，也不反复发布警告。当前模型切换沿用 `deferMetadata: true` 的现有流程，必要时才主动探测。
- **结果按条目写回。** 后台任务按条目 id 区分，不沿用“整个文件只保留一个发现任务”的调度。写回前重读文件，确认目标 id 仍存在、路由未变（`provider + model + baseUrl + interfaceProvider`，复用 `modelProfileRouteKey`），并且条目的**配置代数**没变，才只更新该条目的档案。配置代数是进程内按条目 id 记的计数器，任何连接字段或 key 的修改（包括在同一个变量里换 key 值）都会加一；任务启动时记下代数，写回时比较。只比较 `apiKeyEnv` 名称拦不住“变量名没变、值换了”的情况。保存其它条目不取消本条目的任务，也不改变当前项。
- **配置变了，旧结果失效。** 修改目标条目的地址、协议或 key 后，清除它的自动能力结果并重新读取；旧配置发出的请求不能回写。重新获取的结果替换旧的自动结果，不能让旧缓存一直盖过新元数据。
- **未知时用上游默认。** 能力未确认时标为 `unknown`、`efforts` 为空，请求沿用现有 `service-default`：不注入未经确认的推理开关或强度。不据名称补出选项，也不把 unknown 当成“确定不支持”。
- 不另建能力服务，不新增手填能力接口。`ohbaby-llm` 只调整规则匹配条件，不读取条目列表、不承担网络发现。

### 凭据三态

模型与搜索接口从不回传 key 原文，只返回引用名和 `apiKeyConfigured`。表中的“保持”针对已保存目标条目，不从 provider 或其它模型补 key。

| 请求里的 `apiKey` | 含义 |
|---|---|
| 不传 | 保持该条目已保存的凭据；新增时未提供 key 或引用则沿用现有无 key 模式 |
| `""` | 清除目标条目的 key 使用；不删除其它配置仍引用的变量 |
| 非空字符串 | 为目标条目写入或替换 key；若旧变量被其它配置引用，改用该条目的独立变量名 |

`apiKeyEnv` 未传时保留原引用，`null` 表示解除引用；非空名称表示明确改用该引用。新 key 给值时优先为目标条目落入可独立修改的全局变量。清空后未再使用的受管变量可从全局 `.env` 和 ohbaby 设置的进程环境中一起移除；引用仍被其它条目或搜索使用时只解除目标引用，不清变量。删除模型或服务商本身从不清理 key。

`apiKeyConfigured` 表示目标引用实际解析后是否存在值。外部 shell 的变量不由设置接口删除；解除模型引用后，该模型不再使用该变量。搜索保持其现有变量解析约定，接口响应按实际解析结果报告状态。共享引用的检查在写入前完成，不通过先改 `.env` 再找目标条目的方式判断。

模型、搜索和旧入口共用全局 `.env`，涉及它的读取、写入及失败回滚必须纳入同一进程内协调范围；不能各自只锁 `model.json` 或 `search.json`，也不能用旧备份回滚掉另一项已成功的写入。搜索改 key 时同样不得覆盖模型仍引用的值。复用现有串行队列风格即可，不新增事务框架；跨进程同时写不在本轮保证范围内。

MCP 的 `env` 和 `headers` 值经常是 token，读取时只返回键名。修改用补丁形式：`{ set?: Record<string, string>; unset?: string[] }`，未提及的键保持不变。`args` 原样返回；敏感字段、上游错误、发现失败原因和校验错误统一脱敏，不把原始请求体放进响应或日志。

## 2.4 接口

所有接口沿用 daemon 的 token 鉴权和 `{ ok: false, error: { code, message } }` 错误格式。写接口的成功响应返回该分区更新后的读取结果，客户端不必再查一次。

> 2026-10-24 补充（Web 改版 improve-4 Stage A）：全局设置路由的所有错误响应都带 code（`UNAUTHORIZED`、`INVALID_JSON`、`REQUEST_TOO_LARGE`、`MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE`、`MCP_SERVER_NOT_FOUND`、`VALIDATION_FAILED`、`SETTINGS_ACCESS_FAILED`）。`VALIDATION_FAILED` 另带 `fields: [{ path, message }]`：`path` 是请求体里的字段路径，`message` 由后端按校验类型生成固定文案，不回显提交的值。类型见 SDK `UiSettingsErrorResponse`。实例层设置路由、MCP 重连的错误格式不变。详见 [Web 改版 improve-4 02](../../../ohbaby-web/redesign-2026-10/improve-4/02-plan-and-change-scope.md)。

全局与实例接口共用 `/v1/settings/` 前缀，全局路由必须按精确路径注册，不能用前缀通配，否则会截走 `mcp/status`、`search-api-key` 等实例请求。全局路由只在有 `InstanceStore` 时挂载，生产环境的 daemon 总是满足。

### 全局层（不需要目录头）

模型配置统一按稳定条目 id 定位，读取返回每个条目的完整连接。没有服务商级的连接编辑接口；provider 分组由客户端按条目的 `provider` 字段完成。

| 接口 | 请求 | 响应与规则 |
|---|---|---|
| `GET /v1/settings/models` | - | `active: { id, provider, model } \| null`、`params`，按保存顺序的 `models[]`（`id/provider/model/label?/baseUrl/interfaceProvider/promptCache?/apiKeyEnv?/apiKeyConfigured/configurationComplete/contextWindowTokens/maxOutputTokens?/reasoning`）。不完整历史条目的缺失字段可省略。`reasoning` 复用 `UiReasoningCapabilityView`。读取不触发网络请求 |
| `POST /v1/settings/models/profiles` | `provider`、`model`、`baseUrl`、`interfaceProvider`、`promptCache?`、`label?`、`apiKeyEnv?`、`apiKey?`、`contextWindowTokens?`、`maxOutputTokens?` | 追加一个独立条目，不查重。缺上下文预算沿用现有默认值；保存后在后台读取元数据，不主动探测，不改变当前选择 |
| `PATCH /v1/settings/models/profiles/:id` | 需修改的字段；key 三态；`label: null` 清除备注；`apiKeyEnv: null` 表示无 key 模式 | 按 id 修改条目，未传字段保留，id 与顺序不变。改了地址、协议或 key 时清除该条目的自动能力并重新读取元数据。当前条目同步顶层快照，下一轮生效；其它条目不变，不存在返回 404 |
| `DELETE /v1/settings/models/profiles/:id` | - | 移除整个条目，保留 `.env` 中的 key。当前模型按原列表顺延循环，无可选择条目则 `active: null`；下一轮生效，不存在返回 404 |
| `DELETE /v1/settings/models/providers/:providerId` | - | provider 名称是自由文本，路径参数须 URL 编码（可能含 `/`）；按规范化后的 provider 比较（旧条目缺省值已在规范化时补齐）。同一次写入删除 `provider` 等于它的全部条目，保留所有 key；当前项被删时跳过本次被删条目顺延循环，无可选择条目则 `active: null`；下一轮生效，没有匹配条目返回 404 |
| `POST /v1/settings/models/active` | `id` | 选择已保存且完整的模型，生成全局当前快照，下一轮生效；不存在返回 404，旧档案未补齐返回 400 `MODEL_CONFIG_INCOMPLETE`；不先做网络验证，不改条目顺序 |
| `POST /v1/settings/models/probe` | `id` | 按目标条目的完整配置获取上下文窗口和推理能力：先查内置规则和元数据，都没有结果时主动探测。结果写回该条目并返回 `UiReasoningCapabilityView`，不改变当前项；未补齐的历史条目返回 400 `MODEL_CONFIG_INCOMPLETE` |

全局层没有目录，配置读写、凭据解析与发现使用全局配置；调用现有需项目根的辅助函数时传默认工作区，不能回落到 `process.cwd()`。后台发现写入成功也接入全局通知，使所有已加载实例收到变更；当前模型的后台写回不得覆盖更晚的选择。

| 接口 | 请求 | 响应与规则 |
|---|---|---|
| `GET /v1/settings/search` | - | `provider`、`apiKeyEnv`、`apiKeyConfigured`、`baseUrl?`、`defaults` |
| `PUT /v1/settings/search` | `provider?`、`apiKeyEnv?`、`apiKey?`（三态）、`baseUrl?`（`null` 清除）、`defaults?`（按字段合并） | 只改请求中出现的字段，保留其它配置，修复 B1 |
| `GET /v1/settings/mcp/servers` | - | 全局 MCP 文件中的服务器：`name`、`transport`、`enabled`、`trust`、`timeout`、`includeTools?`、`excludeTools?`、`command?`、`args?`、`cwd?`、`url?`、`envKeys[]`、`headerKeys[]` |
| `PUT /v1/settings/mcp/servers/:name` | 服务器字段；`env`、`headers` 为补丁 | 新增或修改，启用/停用也走这里。响应另带 `overriddenIn: string[]`：已加载实例中项目配置覆盖该名称的目录；不扫描或启动其它项目 |
| `DELETE /v1/settings/mcp/servers/:name` | - | 只删全局文件中的条目；不存在返回 404 |
| `GET /v1/settings/about` | - | `version`、`ohbabyHome`、`logDirectory?`、`diagnosticsFile?`、`defaultWorkspace` |

### 实例层（需要 `x-ohbaby-directory`）

| 接口 | 响应与规则 |
|---|---|
| `GET /v1/settings/mcp/status` | 该目录生效的服务器：`name`、`origin`（`global`、`project`、`plugin`）、`enabled`、`status`、`error?`（已脱敏）、`toolCount`、`tools[]`（`name`、`description`、`mcpToolName`）。工具数按过滤后的列表计算 |
| `POST /v1/settings/mcp/reconnect` | 通过现有运行准入协调重载该目录的 `McpManager`，等待连接与工具刷新后返回最新状态。轮次、子代理或后台工具等活动尚未结束时返回 409 `INSTANCE_BUSY`；忙碌检查与重连同属一个协调范围，避免检查后新轮次插入。旧路由的错误契约保持原样 |
| `GET /v1/settings/skills` | `name`、`description`、`source`、`scope`、`location`、`userInvocable`、`modelInvocable`。通过共享 Skill 加载与刷新逻辑读取最新列表，并使运行时注册表同步，避免设置与模型各维护一份列表 |
| `GET /v1/settings/agents` | `name`、`description`、`mode`、`hidden`、`origin`（`builtin`、`global`、`project`）。来源在加载时记录，不在设置层重新推算合并 |

实例层沿用 improve-1 的规则：Web 按会话实际执行目录发请求；草稿按所选项目或默认工作区发请求。

### 现有接口

`GET/POST /v1/model`、`POST /v1/model/context-window-probe`、`POST /v1/settings/search-api-key` 和对应的 JSON-RPC 方法保留，供旧 Web 和 TUI 使用。它们改为调用与新接口相同的 agent 写入函数，因此模型保存会更新或新增目标条目，保存搜索时只改相关字段。旧接口挂在实例层，只在本实例发布事件，其它实例的界面不会立即刷新；运行时仍会在下一轮通过版本检查生效。等 Web 迁到新接口后再决定是否下线，不在本轮。

旧 `/connect` 输入没有条目 id，适配层按 provider + 模型名 + 规范化地址匹配已有条目。比较前先规范化：条目缺 `provider` 时按迁移后的值（即当时的顶层 provider），地址用 `modelProfileRouteKey` 同样的规范化方式，缺 `baseUrl` 的条目不参与匹配。匹配键不含协议，这是 00 确认的“只改协议就编辑原条目”。旧文件里可能有只差协议的多条，多条命中时取列表中第一条。命中的条目即使是用户在设置里加过备注的，也照样更新，因为 `/connect` 的语义就是“编辑这份配置”。命中则更新这个条目（包括只改协议或换 key）并设为当前项；没命中则追加新条目并设为当前项。写 key 时若该条目的变量被其它条目或搜索引用，先为它分配独立变量，不能先覆盖共用变量。想为同一模型保存两把 key，走设置接口新增。新设置接口仍严格分开新增、编辑和选择。

### SDK

在 `ohbaby-sdk/src/contract/settings.ts` 定义上述请求、响应和事件类型，从 `index.ts` 导出。SDK 目前没有 HTTP 客户端，本轮不新增；Web 重构时按这些类型写调用代码。

## 2.5 变更传播

### 设置版本

把 `modelConfigVersion` 扩展为设置版本：按分区分别计算哈希。版本函数接收实例目录，项目文件路径必须与各加载器实际解析的一致（MCP 用实例工作目录，Agents、Skills 用 `resolveProjectOhbabyRoot`）。

| 分区 | 文件 |
|---|---|
| model | `model.json` |
| env | 全局 `.env`（模型与搜索的 key 都在这里） |
| search | `tools/search.json` |
| mcp | 全局和该目录的 `mcp/settings.json` |
| agents | 全局和该目录的 `agents/settings.json` |
| skills | 全局和该目录的 `skills/settings.json` |

`InProcessRuntimeController` 改为保存各分区的哈希（现在只存一个 `runtimeVersion` 字符串），检查流程不变：任一分区变了，空闲就重建运行时，忙就提示后重试。提示文案从 “Waiting to switch model” 改为 “Waiting to apply settings”。变化的分区列表传给重建逻辑：

- `model` 或 `env` 变了：重新加载 LLM 配置（现有行为）。
- `search` 或 `env` 变了：调用 `reloadSearchConfig()`。搜索配置是进程级缓存，运行时重建不会自动重读。
- `mcp` 变了：调用 `McpManager.reload()`。只改模型或搜索时不重连 MCP。
- Skills：对实例共享的注册表执行带配置目录的 `reload()`，不另建第二份注册表（同时修复 B2）。设置读取和模型工具用的是同一份。
- Agents 随运行时组装重新加载，组装时传入带目录的加载器（`new AgentManager({ registry: new AgentRegistry({ configLoader }) })`，同时修复 B3）。

**注入 LLM 客户端时也要检查。** 目前 `getConfigVersion` 只在没有注入 `llmClient` 时接线（`ui-inprocess.ts:1007-1014`），而 daemon 集成测试和部分宿主都会注入。改为始终接线并协调各分区；提供 `llmClient` 或 `createLLMClient` 时保持现有客户端解析优先级，不因 model 或 env 变化调用默认 `reloadLLMConfig()`。env 仍刷新搜索，MCP、Skills、Agents 照常应用。固定注入的客户端不会因保存模型配置自动变成另一客户端；模型切换验收使用正常加载路径和本地假上游，不能与其它分区的注入客户端测试混为一谈。

**`McpManager.reload()` 与完成边界**：复用 `invalidateAfterConfigChange()` 和 `notifyChanged()`。运行时组装通过 `mcpManager.onChange` 刷新 MCP 工具，不通知就会留下指向已断开客户端的工具。现有通知是异步触发，不能把“通知已发出”当成重连完成；重连接口须在现有运行准入协调内等待初始化及工具刷新完成，才返回状态并记录已应用的 mcp 哈希。复用或暴露现有刷新 promise，不新增后台任务系统。组装的 `dispose` 要取消 MCP 与 Skills 两个订阅，避免重建后监听堆积。

手改配置文件也会在下一轮被发现。Skill 文件更新、增删不依赖 `skills/settings.json` 的版本变化：正文继续每次调用读盘；目录列表及元数据复用 `SkillRegistry.reload()`、失效和 `onChange` → 工具刷新链路。正常触发点是每轮组装模型可用工具前、设置或命令读取列表前、显式按名称查找 Skill 前。刷新后等待工具目录同步，不能要求先打开设置页才能发现新增 Skill，也不能以测试里手动调用 reload 代替生产触发。复用现有扫描，只在列表或元数据变化时发布变更，避免每次读取都重注册工具；刷新入口与注册表缓存读取分开，避免 onChange 再读列表造成循环。不加通用文件监听或后台轮询，不要求重启或点击刷新，不新增 Skill 编辑功能。

“检查有没有变化”要便宜：先比较各 Skill 目录下 `SKILL.md` 的路径和修改时间组成的签名，签名没变就直接用缓存，不重新解析 frontmatter；签名变了才 `reload()`。Skill 列表一变，Skill 工具的描述随之改变，会让模型的提示缓存失效一次。这只在真的有增删或改描述时发生，可以接受。

### MCP 状态的读取代价

`getStatus()` 会触发 `ensureInitialized()`，第一次读状态会启动或连接该目录的全部 MCP 服务器。这与模型第一次使用 MCP 的代价相同，可以接受，Web 只在打开 MCP 页时请求。

全局写入 MCP 后，只保存配置并通知已加载实例，不自动重载任何实例。已初始化实例的 MCP 连接和状态在下一轮或显式重连前仍反映旧配置；尚未初始化的实例首次读取状态时，按最新配置连接。需要立即验证时，客户端调用当前项目的重连接口。重连完成后记下该实例新的 mcp 哈希，避免下一轮再重连一次。

### 写入后通知

全局层写入成功后，遍历 `InstanceStore` 中已加载的实例，调用实例 backend 上的内部方法 `notifySettingsChanged(domains)`。该方法不加入 JSON-RPC 协议。实例收到后：

1. 通过现有事件流发布 `{ type: "settings.changed", domains }`。
2. `domains` 含 `model` 时，同时发布现有的 `model.invalidated`，TUI 和 Web 的现有监听不用改。只改搜索 key 时 `domains` 只含 `search`，不发 `model.invalidated`。

`notifySettingsChanged` 只发布事件，不重载 MCP，也不把新的配置哈希标记为已应用。

`notifySettingsChanged` 作为实例 backend 上的可选方法，沿用现有 `adoptSessionProjectMove?` 的接法，通过 `instanceStore.get(scopeKey)` 取得实例。

未加载的实例启动时会读取最新文件，无需通知。通知只负责让界面刷新；配置是否生效仍以下一轮的版本检查为准，所以通知丢失不会导致运行时用错配置。

## 2.6 分阶段实施

五个 Stage（1、2、3、4a、4b）都属于 improve-2，每个 Stage 结束时跑对应的 04 用例。

### Stage 1：修缺陷，打通生效机制

- 修 B1–B4（见 [01 §1.6](01-problem-analysis-and-current-state.md)），每个先补失败测试。
- `McpManager` 公开 `reload()`，复用私有的 `invalidateAfterConfigChange()`。
- 设置版本扩展到六个分区；运行时重建时按分区重连 MCP、重建 Skills 注册表、按目录加载 Agents。
- 保留 Skill 正文按需读盘，复用注册表刷新机制补齐普通目录增删、描述等元数据变化的触发，确保设置列表和模型可用列表同步。
- MCP 命令摘要补齐 `error`、`toolCount`，旧字段保持兼容。
- **完成标准**：T1–T4、T12、T23 通过；TUI 的 `/mcps`、`/status`、`/connect` 回归通过。

### Stage 2：实例层只读接口

- agent 新增设置读取模块，组装 MCP 状态（带来源和工具列表）、Skills、Agents 的读取结果，并提供错误脱敏函数。
- MCP 加载时保留来源；Agents 注册表记录来源。
- server 新增实例层路由，SDK 新增类型。
- **完成标准**：T5–T7 通过。

### Stage 3：全局层的搜索、MCP、关于和通知

- 搜索写入改为字段级合并，新增 MCP 全局文件写入函数（按文件排队，写前重读，整体校验，原子写入）。
- server 新增全局层路由模块，在 `mountRoutes` 中挂到工作区分发之前；新增写入后通知。
- `POST /v1/settings/search-api-key` 改用新的写入函数。
- **完成标准**：T8–T10、T13、T14 通过；T11 中搜索和 MCP 部分通过。

### Stage 4a：模型条目与凭据

- agent 侧条目类型、规范化、迁移及校验；所有读取入口统一投影当前 LLM 配置。`buildModelJson` 只更新目标条目及必要的当前快照，保留稳定顺序。
- 条目新增、编辑、删除、选择当前项及按 provider 整组删除的写入函数和全局路由；删除当前项按列表自动顺延。旧 `/connect` 按 §2.4 匹配规则接入。
- 条目级 key 隔离，兼容旧共享变量引用；与搜索共用 `.env` 的协调写入及回滚。
- 保存后按条目在后台读取元数据并写回，任务按 id 区分，写回比较配置代数；候选条目从不主动探测；PATCH 改了地址、协议或 key 时清除该条目的自动能力。能力未知时沿用上游默认行为，不反复提示。
- **完成标准**：T11 全部、T15–T17、T19–T22 通过；`/connect` 保存后目标条目及其它条目、顺序均保留。

### Stage 4b：推理能力获取

- `ohbaby-llm` 内置规则去掉 provider 名称条件，改为按官方地址 + 模型名 + 协议匹配；`reasoning-active-probe.ts` 的名称分支同样改为按地址或协议判断。
- 新增 `POST /v1/settings/models/probe` 路由：规则和元数据都没有结果时才主动探测，结果写回该条目。选为当前模型时的主动探测沿用现有流程。
- 重新获取的结果替换旧的自动结果，不能让旧缓存一直盖过新元数据。
- **完成标准**：T18 通过；现有推理能力相关测试按新匹配条件更新后通过。

最后同步 §2.11 中 D1、D2 两份文档，跑 04 §4.4 的回归。

## 2.7 按包的改动面

| 包 | 新增 | 修改 |
|---|---|---|
| `ohbaby-agent` | 设置读取模块（建议 `src/settings/`）；agent 模型文件规范化与投影；`config/mcp/writer.ts`；模型条目写入函数；凭据脱敏 | `config/llm/loaders.ts`、`manager.ts`、`writer.ts`、`apply-active-model-config.ts`、`reasoning-active-probe.ts`、`config-coordination.ts`、`config/secrets/env-secrets.ts`、`config/tools/search/writer.ts`、`mcp/core/manager.ts`、`skill/registry.ts`、`adapters/ui-inprocess.ts`、`adapters/ui-inprocess/runtime-controller.ts`、`adapters/ui-runtime/composition.ts`、`agents/registry.ts`、`config/mcp/loaders.ts`、`index.ts` 导出 |
| `ohbaby-llm` | - | `src/providers/reasoning.ts`：内置规则去掉 provider 名称条件，改按官方地址 + 模型名 + 协议匹配；规则内容不扩充；不增加条目列表读写职责 |
| `ohbaby-server` | 全局设置路由模块；实例设置路由 `protocols/web/routes/settings.ts` | `runtime/daemon/server.ts` 挂载与通知；`protocols/web/routes/model.ts` 改用共享写入函数；OpenAPI 文档 |
| `ohbaby-sdk` | `contract/settings.ts` | `contract/session-view.ts` 增加 `settings.changed` 事件；`index.ts` 导出 |
| `ohbaby-cli` | - | 不改交互；确认 TUI 能忽略新事件类型 |
| `apps/ohbaby-web` | - | 不改；确认能忽略新事件类型 |

## 2.8 风险与回滚

| 风险 | 应对 |
|---|---|
| 新文件与旧版本的兼容有边界 | 有当前项时顶层快照仍可供旧版本读取；旧版保存时会按旧逻辑重写 `models[]`，丢掉条目的 `apiKeyEnv` 等新字段和 `activeProfileId`；`active: null` 也不符合旧版必填配置。Stage 4a 回退前保留新文件备份，并恢复升级前配置；发布说明写明 |
| 版本检查覆盖的文件变多，运行时重建更频繁 | 只在对应分区变化时重连 MCP；模型和搜索变化只重建运行时，与现在相同 |
| 写入 MCP 文件会重新格式化 | 文件是普通 JSON，不含注释，内容不丢 |
| 凭据从错误信息漏出 | 统一脱敏函数，04 用整个响应文本检查测试 key |
| 当前快照与保存的配置不一致 | 只有 `buildModelJson` 一处按目标条目组装顶层；不能以当前条目覆盖其它条目 |
| Skill 列表变化让提示缓存失效 | 只在签名变化时刷新，正常对话中不发生 |

前三个 Stage 和 4b 可按代码回退；4a 涉及文件结构，回退须同时处理上述配置兼容边界，不能宣称任意新文件都可被旧版本直接使用。

## 2.9 与 00 边界对齐

- 只改全局默认模型，不加会话级模型字段（00 §3）。
- 每个模型条目独立保存完整连接配置，修改只影响该条目，下一轮生效；不另建 provider 连接表，不做继承或批量覆盖。
- 保存候选模型不切换当前项，显式选择后下一轮生效；切换接口不限定来自 Settings 或输入区，前端入口不在本轮。
- 模型删除入口统一在 Settings；本轮只交付删除接口，删除即移除整个条目，保留 API key；删除当前模型后自动切换。
- 删除服务商即删除该 provider 的全部条目，按同一顺延规则自动选择剩余条目，下一轮生效，保留 API key。
- 新接口只走 HTTP，TUI 交互不变，`/connect` 通过共享写入函数更新或新增目标条目（00 §3）。
- 新设置接口不查重；内置推理规则保留，只去掉名称条件（00 §3）。
- 项目配置只读；MCP 同名覆盖写全局并提示 `overriddenIn`（00 §3）。
- 不加文件监听，不做 Web 页面（00 §4）。

## 2.10 不在本轮

- 会话级模型选择与保存。
- 项目级配置编辑、Skills/Agents 启用停用或编辑。
- MCP OAuth、单个服务器重连（本轮重连整个目录的 MCP）。
- 从 provider 远程拉取模型列表。
- 生成参数（温度、`maxTokens`）的编辑接口。现有推理开关不变。
- 手动填写推理能力的设置接口。
- 权限默认值、代理、日志、主题的配置文件；hooks、插件、快捷键；文件监听。
- 下线旧的 `/v1/model` 和 `search-api-key` 接口。
- Web 设置页面，待 Web 重构规划后安排（原 improve-1 T23）。

这些都是后续候选。是否新开一轮，等本轮 05 闭环后再定。

## 2.11 关键改动清单

> 行号为 `main@231eb8e1` 的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。路径省略 `packages/` 前缀。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码 | `ohbaby-agent/src/config/llm/writer.ts` | `buildModelJson` | L199–217 | 按 id 原位修改条目、组装当前快照；保留未涉及内容 | 否则会丢条目、重排列表或混用同名模型的 key |
| C2 | 代码 | `ohbaby-agent/src/config/llm/config-coordination.ts` | `modelConfigVersion` | L61–75 | 扩展为按分区的设置版本，带目录参数 | 所有分区“下一轮生效”都依赖它 |
| C3 | 代码 | `ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.ts` | 准入检查、`runtimeVersion` | L66–90、L177 | 保存各分区哈希；重建时传变化分区；显式 MCP 重连纳入同一准入协调并覆盖后台活动 | 生效时机与重连不会和新轮次交错 |
| C4 | 代码 | `ohbaby-agent/src/adapters/ui-inprocess.ts` | `getConfigVersion` 接线、`createRuntime`、`getSkillRegistry` | L1007–1014、L1018–1024、L2424–2433 | 注入 LLM 客户端时也接线；按分区重载搜索与 MCP；重建时丢弃 Skills 缓存并加载配置目录 | B2、注入客户端宿主与各分区生效 |
| C5 | 代码 | `ohbaby-agent/src/mcp/core/manager.ts` | `invalidateAfterConfigChange` | L365 | 公开重载；与组装层约定可等待的初始化和工具刷新完成边界 | MCP 生效与手动重连不能只等通知发出 |
| C6 | 代码 | `ohbaby-agent/src/adapters/ui-runtime/composition.ts` | `mcpStatusToSummary`、`new AgentManager()`、`mcpManager.onChange` 订阅 | L259–264、L291、L1159 | 补 `error`、`toolCount`；Agents 加载器传入目录；`dispose` 时取消 MCP 与 Skills 订阅 | B3、B4、避免监听堆积 |
| C7 | 代码 | `ohbaby-agent/src/config/tools/search/writer.ts` | `setSearchApiKey` | L23–68 | 改为字段级合并，支持三态 key | B1 |
| C8 | 代码 | `ohbaby-agent/src/agents/registry.ts` | `initialize`、`loadDefaultAgentConfig` | L21、L92–114 | 记录来源；不再依赖 `process.cwd()` | B3 与 Agents 来源 |
| C9 | 代码 | `ohbaby-server/src/runtime/daemon/server.ts` | `mountRoutes` | L259–275 | 在工作区分发前挂全局设置路由；写入后遍历已加载实例通知 | 分层设计的落点 |
| C10 | 代码 | `ohbaby-server/src/protocols/web/routes/model.ts` | 四个现有路由 | L16–146 | 改调共享写入函数 | 新旧入口行为一致 |
| C11 | 代码 | `ohbaby-agent/src/config/llm/loaders.ts`、`manager.ts` | 文件读取与当前配置加载 | - | 建立统一规范化与当前投影；旧 writer、发现任务、UI 读取一并接入 | 旧文件首次读取、同名独立条目、无当前项都不能落回旧磁盘校验 |
| C12 | 代码 | `ohbaby-agent/src/config/secrets/env-secrets.ts` | 全局凭据读改写 | - | 模型和搜索的 key 写入/回滚共同协调；共享引用先隔离目标 | 防止影响其它模型或覆盖另一项成功写入 |
| C13 | 代码 | `ohbaby-agent/src/skill/registry.ts`、`adapters/ui-runtime/composition.ts` | 注册表刷新与 Skill 工具同步 | - | 在正常轮次与读取入口扫描变化，复用 reload/onChange 并等待同步 | 更新、增删无需重启，且不会只刷新设置列表 |
| C14 | 代码 | `ohbaby-llm/src/providers/reasoning.ts`、`ohbaby-agent/src/config/llm/reasoning-active-probe.ts` | 内置规则匹配、探测请求字段选择 | L124、L186、L227；probe L25 | 去掉 `provider ===` 条件，改按地址 + 模型 + 协议 | 自定义名称命中官方规则，避免不必要的付费探测 |
| D1 | 文档 | `docs/ohbaby-server/hono-app/02-web-api-surface.md` | 接口清单 | - | 加入全局与实例设置接口 | 接口权威文档 |
| D2 | 文档 | `docs/ohbaby-server/hono-app/04-multi-project-runtime.md` | 全局层与实例层 | - | 说明设置的分层与写入后通知 | 多目录运行时权威文档 |

### 连带影响面

- `ohbaby-agent/src/config/mcp/loaders.ts`：分别读取全局与项目文件以标注来源。
- `ohbaby-agent/src/commands/types.ts`、`commands/normalize.ts`：MCP 摘要新字段。
- `ohbaby-sdk/src/contract/session-view.ts`：新增事件类型。
- `ohbaby-server/src/app/openapi.ts`：新路由的文档。
- `ohbaby-server/src/runtime/daemon/main.ts`：把 ohbaby home、诊断文件路径（约 L623）等关于页数据传给 `DaemonHttpServerOptions`，目前选项里没有这些字段。
- `ohbaby-agent/src/config/tools/search/index.ts`：`reloadSearchConfig()` 供重建和全局写入调用。
- `adapters/ui-inprocess.ts` 的 `connectModelInternal`、`setSearchApiKeyInternal`：改调共享写入函数。
- `ohbaby-agent/src/config/llm/apply-active-model-config.ts`：后台发现按条目 id 区分任务并定向写回；候选条目只读元数据；配置变化后旧结果不回写。
