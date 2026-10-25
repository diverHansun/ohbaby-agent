# 06 数据、API 与状态

> 会话接口以 [improve-1 02 §2.5](../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-1/02-optimization-plan-and-change-scope.md) 和 SDK 的 `packages/ohbaby-sdk/src/contract/global-sessions.ts` 为准；设置接口以 [improve-2 02 §2.4](../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-2/02-optimization-plan-and-change-scope.md) 和 `packages/ohbaby-sdk/src/contract/settings.ts` 为准。本文不复制字段。

## 1. API 到界面的映射

### 1.1 全局层（第一批，不带目录头）

| 接口 | 谁用 | 怎么用 |
|---|---|---|
| `GET /v1/scopes` | Sidebar（工作区分组）、WorkspacePicker、SessionMenu 的工作区列表 | 服务端已返回 `defaultDirectory.directory` 和可见工作区列表（隐藏工作区已过滤，默认目录不在其中），按服务端顺序显示。Web 的 `WorkspaceScopesResponse` 类型还没有 `defaultDirectory`，要补上 |
| `POST /v1/scopes/open` | 打开文件夹 | 成功后刷新工作区列表；从草稿打开时，草稿选中新工作区 |
| `POST /v1/scopes/hide` | 工作区菜单 › Hide workspace | 成功后刷新工作区和会话列表，清除该工作区已缓存的侧栏行；主区正在看的会话保持打开 |
| `GET /v1/sessions?limit&cursor` | Sidebar 会话树 | 一页 100 条，跨所有工作区，按更新时间倒序；前端按 `workspaceDirectory` 分组 |
| `GET /v1/sessions/search?q&limit&cursor` | SidebarSearch | 直接渲染结果；分页用 `nextCursor` |
| `GET /v1/sessions?status=archived&limit&cursor` | ArchivedSection | 一页 50 条，按归档时间（`updatedAt`）倒序，包括隐藏工作区里的会话；列表只存在分区组件里 |
| `POST /v1/sessions/:id/unarchive` | ArchivedSection › Restore | 用返回的会话信息写入全局列表并刷新，被隐藏的工作区随之重新出现；`404` 或 `SESSION_NOT_ARCHIVED` 时直接移除这一行 |
| `DELETE /v1/sessions/:id` | ArchivedSection › Delete | 只对已归档的根会话有效，子代理会话一起删除；错误处理同上 |
| `POST /v1/sessions/:id/workspace` | SessionMenu › Move to workspace / Remove from workspace | 成功后用返回的会话信息替换列表里这一项；当前打开的会话只更新缓存的请求目录，顶栏在下一轮开始后更新 |

SDK 目前只有这些接口的类型，还没有 HTTP 客户端方法（无工作区议题 improve-1 的 05 记录）。本次在 Web 的 `api/daemon/global-sessions.ts` 实现调用、复用 SDK 类型，与 improve-2 的改动面一致；不为这次改版另造一套 SDK HTTP 客户端。

共用 HTTP 传输只负责鉴权、序列化、取消和错误解析，已支持设置需要的 PUT、PATCH、DELETE。`http.ts` 目前抛错只保留 `code` / `status`，improve-2 要增加 `targetDirectory`，improve-4 要增加结构化 `fields`；不让各功能客户端复制一份传输实现或解析错误 message 猜字段。

### 1.2 实例层（带目录头，沿用现有）

| 接口 | 谁用 | 说明 |
|---|---|---|
| `/v1/sessions/:id/view`、`/history`、SSE `/v1/events` | SessionScreen | 不变。目录取 `globalSessionRequestDirectory(session)`（有待生效目录时用它） |
| `POST /v1/prompts` | 草稿首发 | 草稿 client 连在草稿所选工作区，没有选就连 `defaultDirectory.directory`；不带会话 ID 发送，服务端接纳时创建会话（improve-2 调整，不再先调 `POST /v1/sessions`） |
| `/v1/sessions/:id/archive`、`/export` | SessionMenu | 目录取该会话的执行目录；操作其他目录的会话不能切换当前 SSE 或覆盖当前选择。归档运行中的会话返回 `409 SESSION_RUNNING`，通知显示 `Stop the chat before archiving.` |
| `GET /v1/model` | 实例模型状态、ReasoningControl | improve-4 继续保留；`BrowserDaemonClient.refreshModel` 和 `model.invalidated` 仍依赖它 |
| `POST /v1/model`、`/v1/settings/search-api-key` | 第一批的 `/connect` 浮层 | improve-4 移除 Web 写调用，改走全局设置接口；服务端旧接口保留给 TUI |
| `/v1/sessions/index` | 会话行的运行状态（见 §3.4） | 只对当前已连接的实例 |

### 1.3 设置接口（第二批）

全局层（不带目录头）：

| 接口 | 谁用 | 怎么用 |
|---|---|---|
| `GET /v1/settings/models` | ModelsSection、ModelMenu、草稿“没有模型”判断 | 进入 Models 或打开模型菜单时读取；`active === null` 即没有默认模型 |
| `POST /v1/settings/models/profiles` | ModelEditor（新增） | 成功返回完整列表，直接替换缓存；返回的 `active` 为 `null` 时，紧接着对新条目调用 `POST /v1/settings/models/active`（D20）。按当前 `createModelEntry` 在同一写锁内追加并返回快照的契约，取本次 POST 响应的末项 ID；不能对提交前的旧缓存做差集后取第一项，其他窗口可能已经新增过模型。第二步失败时模型已保存，按设为默认失败处理（04 §2.6） |
| `PATCH /v1/settings/models/profiles/:id` | ModelEditor（编辑） | 只提交改过的字段（见 §2.2 的映射）；Needs setup 条目保存后变为完整，此时如果 `active` 为 `null`，同样紧接着设为默认（D20） |
| `DELETE /v1/settings/models/profiles/:id` | 行菜单、ModelEditor | 返回的列表里已经按顺延规则换好默认 |
| `DELETE /v1/settings/models/providers/:providerId` | provider 组菜单 | provider 名做 URL 编码 |
| `POST /v1/settings/models/active` | 行菜单 Set as default、ModelMenu | `{ id }`；返回完整列表 |
| `GET /v1/settings/search`、`PUT /v1/settings/search` | SearchSection | PUT 只提交改过的字段 |
| `GET /v1/settings/mcp/servers` | McpSection、McpDetails | 只读全局配置；env 和 header 只有名字，URL 使用服务端脱敏结果；进入 MCP 或 Refresh 时读取 |
| `GET /v1/settings/about` | AboutSection | 进入时读取一次 |

实例层（带目录头，目录见 §3.7）：

| 接口 | 谁用 | 怎么用 |
|---|---|---|
| `GET /v1/settings/mcp/status` | McpSection 的状态列、McpDetails | 进入 MCP 或 Refresh 时读取；按名字和全局列表合并，不看 `origin`（全局服务器被项目同名覆盖时，显示的是实际连接的状态）；全局列表里没有的名字不显示 |
| `GET /v1/settings/skills` | SkillsSection | 只显示 `scope === "user"` 的条目（D13）。已知限制：全局 Skill 被项目里同名 Skill 覆盖时，列表里看不到它 |

不使用：`POST /v1/settings/models/probe`（推理能力由后端在设为默认时自动探测，设置页不显示，D14）、`GET /v1/settings/agents`（没有 Agents 分区，D12）。

MCP 只读（D25）：Web 不调用 MCP 配置 PUT / DELETE 或 `POST /v1/settings/mcp/reconnect`。这些现有服务端接口保留，不为本次改版下线；前端不实现配置补丁、清空字段或重连流程。

**后端前置（D19）**：目前校验失败只返回 `Invalid settings`，没有错误码和出错字段。第二批需要让 Models / Web search 写接口的校验失败返回 `{ code: "VALIDATION_FAILED", fields: [{ path, message }] }`（不含字段值），并让全局设置路由的错误都带 code；不统一整个 daemon 的错误格式。实例层设置路由、MCP 写入、名称校验和重连接口的改进不是前置条件，细节见 improve-4 02 Stage A。这是对 improve-2 接口的小补充，需要在后端文档里登记。

## 2. ViewModel

转换放在对应 store 切片的纯选择器里（全局会话、设置各自组织），组件不直接读 DTO，也不让 store 反向依赖 `ui/session`。

### 2.1 侧栏

```typescript
interface SidebarWorkspace {
  directory: string;          // 身份
  name: string;               // 根目录名
}

interface SidebarSessionItem {
  id: string;
  title: string;
  workspaceDirectory: string | null;   // 分组依据
  workingDirectory: string;          // 当前轮执行目录；顶栏、当前流与审批沿用它
  requestDirectory: string;          // 重新打开和下一轮请求用：待生效目录优先
  updatedAt: string;                 // 显示为相对时间
  pinned: boolean;                   // 来自本地 session-pins
  activity: "idle" | "running" | "awaiting";  // 见 §3.4
}

interface SidebarGroups {
  pinned: SidebarSessionItem[];
  workspaces: { workspace: SidebarWorkspace; sessions: SidebarSessionItem[]; visibleCount: number }[];
  recents: SidebarSessionItem[];
}
```

规则：

- 工作区分组只看 `workspaceDirectory`；Recents 汇总全部全局目录会话，包括 `null`、有工作区和置顶会话。工作目录是什么不影响分组（improve-1：无工作区不等于默认目录）。
- 隐藏工作区的会话由服务端从列表里排除（improve-1 T8），前端不做隐藏过滤。
- `workspaceDirectory` 不在工作区列表里（比如 TUI 刚建的目录还没登记，或工作区列表读取失败）时，用目录名临时建一个分组，不丢会话。
- 置顶的会话在 Pinned 和 Recents 中均显示，不在原工作区分组重复出现。Recents 的顺序和分页不受置顶影响。

### 2.2 设置

```typescript
interface SettingsModelGroup {
  provider: string;                    // 组标题
  models: SettingsModelRow[];          // 保持服务端返回的顺序
}

interface SettingsModelRow {
  id: string;
  model: string;
  label?: string;
  isDefault: boolean;                  // id === active?.id
  needsSetup: boolean;                 // !configurationComplete
}

interface SettingsModelOption {        // ModelMenu 用，只含配置完整的条目
  id: string;
  provider: string;
  title: string;                       // "model-x · Work"，没有备注时只有模型名
}

interface ModelForm {                  // 与 UiSettingsModelCreate / UiSettingsModelPatch 对应
  provider: string;
  model: string;
  baseUrl: string;
  interfaceProvider: "openai-compatible" | "openai-responses" | "anthropic";
  label: string;                       // 空字符串表示没有备注；编辑时清空 → PATCH 传 null
  secret: SecretChange;                // 见下
  apiKeyEnv: string;                   // More options；空 = 由后端生成
  contextWindowTokens: string;         // More options；空 = 后端默认
  maxOutputTokens: string;
  promptCache: "" | "auto" | "enabled" | "disabled";
}

type SecretChange = "keep" | "clear" | { replace: string };

interface McpServerRow {
  name: string;
  enabled: boolean;
  status: "connected" | "failed" | "off" | "not-connected" | "unknown";
  toolCount?: number;
  error?: string;                      // 服务端已脱敏
}
```

规则：

- 分组按 provider 第一次出现的位置排序，组内保持服务端顺序；不按名字重新排序。
- 模型和搜索表单只提交改过的字段。`SecretChange` 的映射：`keep` 不传 `apiKey`；`{ replace }` 传新值；`clear` 传 `apiKey: ""`（后端里清除 key 与无 key 模式相同，没有单独选项）。MCP 没有表单。
- 新增模型时 Label 为空就不传（传空字符串会保存成空备注）；编辑时把已有备注清空，PATCH 传 `label: null`。
- 已支持的清空：备注传 `label: null`，key 传 `apiKey: ""`，搜索 Base URL 传 `baseUrl: null`。Key variable 的 `null` 会解除凭据引用，不能把普通空输入自动解释为“生成一个新变量名”；清除凭据统一走 SecretField。
- 模型的 Context window、Max output、Prompt cache 没有清除协议。本次暂采用前端校验：已有值被清空时在字段下说明并阻止保存，提供恢复原值；新增时可选字段留空则省略。不能静默忽略用户的清空操作后报告保存成功。这是模型表单的处理建议，不涉及 MCP。
- MCP 的 URL、命令、参数和其他配置都只用于展示；Environment / Headers 只列名字，不回显值，不构造任何配置写请求。
- 数字字段为空就不传；不在前端补默认值，以服务端返回为准。
- MCP 状态由全局列表和实例状态按名字合并：配置里 `enabled === false` → `off`；配置启用但状态是 `disabled` 或 `disconnected` → `not-connected`；状态里没有这个名字或状态读取失败 → `unknown`，显示 `—`。
- MCP 的 Args 每行显示一个参数，Include / Exclude tools 显示为只读名称列表。
- 单位和范围跟后端一致：MCP 的 Timeout 是毫秒（默认 10000）；搜索的 Timeout 是秒（1–600，默认 60），Max results 是 1–20。标签里写明单位。

## 3. 服务端状态策略

### 3.1 列表加载与分页

- 首次加载拉第一页（100 条）和工作区列表。
- 每个分组先显示 6 条，Pinned 先显示 8 条（03 §4.4）。点 `Show more` 先展开已经加载的部分；不够 20 条并且全局还有 `nextCursor` 时，继续串行翻页，直到该组凑够、游标耗尽或用户取消。全局游标未耗尽时，空工作区分组和尚未加载到条目的 Pinned 区也要保留加载入口，不能因为当前页中没有该组数据就永远无法加载。
- 接口不返回每组总数。分组计数只表示已加载条数，`Show more · N` 的 N 也只表示已加载但折叠的条数；还有未知页时用 `Show more`，不伪造总数。
- 服务端没有按工作区过滤的接口，所以一个不常用工作区的旧会话，可能要多拉几页才会出现。这一版接受这个代价：找旧会话可以直接搜索，搜索覆盖全部历史。如果以后发现明显不够用，再给 `GET /v1/sessions` 加工作区过滤参数。

### 3.2 什么时候刷新

| 时机 | 做法 |
|---|---|
| 创建会话、改归属、归档、隐藏工作区 | 用接口返回值或已知结果原地更新，再重新校验已加载范围 |
| 当前实例 SSE 报告会话标题或状态变化 | 原地更新这一项 |
| 窗口重新激活、SSE 重连 | 重新拉工作区列表，从首页串行重取至少先前已加载的条数；使用本轮返回的新游标。完整成功后按 ID 去重并替换已加载范围，保留分组展开数量与滚动位置 |
| 打开搜索 | 不预加载；输入后防抖 250ms 再请求 |

刷新失败时保留旧数据，不提示；只有完全没有数据时才显示原因和 Retry（04 §2.3）。

刷新期间不清空屏幕，但完成后不能只把新首页与旧页做永久并集，否则别处归档、隐藏或换工作区的旧行不会移除。若刷新过程中本窗口有写操作，以操作后的新一轮刷新收敛，旧响应不得覆盖已确认的操作。

### 3.3 并发与乱序

- 搜索：每次新请求都中止上一次；只认最后一次查询的结果。
- 切换会话：沿用现有的 client generation 规则，旧 client 的响应和事件不会写进新会话。
- 列表刷新：同一时刻只有一个在飞的刷新请求；新的触发会合并到下一次。
- 列表归档是明确的先改后确认例外，需防重复和失败回滚。改归属、模型删除等操作等服务端确认再更新；MCP 只读。

### 3.4 会话行的运行状态

全局列表只有 `active` / `archived`，没有“运行中”“等待审批”。所以：

- 当前已连接实例里的会话，从该实例的会话索引和审批状态得到 `running` / `awaiting`。
- 其他目录里的会话一律显示为 `idle`（显示时间）。

这是一个已知限制。在多个目录同时有会话运行的情况下，侧栏只能看到当前目录的运行状态。如果需要，后续给全局列表加一个运行状态字段（需要后端配合，不在本轮）。

### 3.5 草稿

- 存储：沿用 `draft-storage` 的 sessionStorage（按标签页隔离，刷新保留）。
- key：现在的草稿 key 含 `selectedDirectory` 和会话 ID（`SessionScreen.tsx` 的 `draftScopeKey`），换工作区会换 key、读不到原文字。改为：草稿用固定的 `new`，已有会话用会话 ID，都不含目录。
- 所选工作区：和草稿文字放在一起，只保存目录。打开页面时，如果该目录已不在工作区列表里，就回到 No workspace。
- 点“New chat”总是从 No workspace 开始，并清空上一份草稿的工作区选择，不沿用旧的 `selectedDirectory`（improve-1 T19）。从工作区分组的 `[+]` 进入时预选该工作区。
- 第一次发送成功后，`new` 草稿清空。
- 草稿连着草稿目录的实例，模型是否配置沿用实例的 `GET /v1/model`；读取失败时不当成未配置。`GET /v1/settings/models` 的客户端随 improve-4 的设置页一起做（improve-2 调整）。
- 首发一步完成：在不绑定会话的实例里发 prompt，服务端接纳时创建会话。被明确拒绝时不留下会话，超时走现有未知结果恢复，不盲目重发；保留 `clientRequestId` 和冻结正文规则。请求期间用户切到其他草稿/会话时，晚到的结果不得抢回选择或清空新输入。
- 改 key 时同步考虑已有草稿和排队编辑租约。能从当前目录及会话 ID 唯一定位的旧 key 可迁入；多个旧 `new` 草稿有歧义时不合并，保留旧 key。不能把旧租约误绑到新会话。

### 3.6 置顶

- 现在的 `session-pins` 按 origin + 目录分 key，侧栏按目录挂载。改成全局侧栏后，用一个新的全局 key（只按 origin）。
- 迁移：第一次读取全局 key 时，把 localStorage 里所有旧的按目录 key 合并进来（会话 ID 全局唯一，直接合并；同一会话取较早的置顶时间），旧 key 保留不删，方便回退。
- 置顶的会话已被归档或不在列表里时，不显示，也不主动清理。

### 3.7 设置数据（第二批）

- **读取**：进入某个分区时读取该分区的数据，不预加载其他分区。模型列表在 store 里缓存，ModelMenu 打开时如果缓存超过 30 秒就重新读取。
- **写入**：模型和搜索设置等服务端返回后再更新，不做乐观更新；写接口返回的结果直接替换缓存。MCP 没有写入流程。
- **别处的改动**：当前实例的 SSE 收到 `settings.changed` 时，按 `domains` 让对应缓存失效；当前在看的分区立即重新读取。编辑子页有未保存的输入时只刷新只读区，不覆盖输入。`model.invalidated` 同样让模型缓存失效。
- **实例层用哪个目录**：打开设置前所在会话的请求目录（有待生效目录时用它）；在草稿里用所选工作区，没选用 `defaultDirectory.directory`。目录只用于请求，页面上不显示。
- **设置分区记忆**：上次停留的分区存在 localStorage，刷新页面后第一次打开用它。同一次页面内，关闭弹窗只是隐藏，再打开时分区、编辑子页和未保存输入原样恢复（D2、04 §2.6）；编辑子页不写进 localStorage。
- **从草稿跳来再回去**：草稿点发送发现没有模型时，打开设置弹窗并直接进入 Models（覆盖弹窗之前停留的位置，手机上也直接进 Models），同时在内存里记一个“来自草稿发送”标记。标记还在时，只要默认模型从无变有（D20 自动设为默认，或手动 Set as default），就关闭弹窗，下面就是原来的草稿，文字还在。用户自己关闭弹窗时清除标记。“没有模型”的判断沿用现有的 `GET /v1/model`（`SessionScreen` 的 `modelMissing`），读取失败不算没有模型。
- **不能只靠 `settings.changed`**：草稿态连着草稿目录的实例，能收到该实例的事件；但 agent 直接改配置文件、或改动发生在别的进程时，不一定有事件。所以除了事件，每次进入分区、窗口重新激活时也重新读取当前分区。
- **事件接线**：检查并补齐 BrowserDaemonClient 到 runtime 的 `settings.changed` 转发；模型失效仍要更新实例模型状态。缓存按 domain 分开，MCP 状态和 Skills 再按设置目录分 key；迟到的读取不能覆盖写接口的新结果或另一个目录的数据。
- **MCP 文件变更**：ohbaby 直接改配置文件后，前端不能只等待 `settings.changed`；进入分区、窗口重新激活、Refresh 都重读配置和状态。Refresh / Retry 只调用两个 GET，不触发重连。配置与实际状态分别缓存，配置读取成功不代表运行时已应用；配置删除后清除对应展开详情。

## 4. 错误到界面的映射

| 错误 | 来源 | 界面表现（04） |
|---|---|---|
| `SESSION_MOVED` | 实例层，发送或续跑时 | runtime 换到返回的目标目录重发并切换 SSE，不提示；同一次发送最多重发 2 次，仍失败按发送失败处理（04 §2.2） |
| 执行目录不存在或不可读 | 实例层，打开会话时 | 消息区原因 + `Move to workspace…`（04 §2.2） |
| 模型未配置 | 第一批：`/v1/model` 返回空；第二批：`GET /v1/settings/models` 的 `active` 为 `null` | 点发送时打开配置入口，不提前提示（04 §2.1） |
| `VALIDATION_FAILED`（需后端补，§1.3） | 设置写接口 | 按 `fields[].path` 写在对应输入框下；找不到对应字段时写在 Save 旁 |
| `MODEL_NOT_FOUND` | 模型写接口 | 条目已被别处删除：回到列表并刷新，不另外提示 |
| `MODEL_CONFIG_INCOMPLETE` | 设为默认 | 打开该条目的编辑子页（04 §2.6） |
| 改归属失败（目标工作区无效等） | 全局层 | 行留在原处 + 右上角错误通知（04 §2.5） |
| `INVALID_QUERY` | 搜索、列表 | 按未知错误处理（前端不会构造非法参数，出现就是 bug） |
| 401 token 失效 | 任意 | 沿用现有处理 |
| 网络断开 / daemon 停止 | 任意 | 对话区顶部断开提示，自动重连（04 §2.1） |
| 其他未知错误 | 任意 | 在原地显示 `Something went wrong.` + 错误信息原文（开发者工具，用户能看懂原文）+ `Retry`；不静默吞掉 |

错误文案遵循 03 §6.3：写原因和下一步。服务端的 message 是给开发者看的，界面上作为补充信息显示，不作为主文案。

## 5. Mock 场景

开发时在浏览器里构造状态，复用测试里已有的假 runtime（`App.unit.test.tsx` 中的 `createFakeRuntime`）。把它抽到 `src/dev/` 下，只在 `vite dev` 时通过 `?mock=<场景>` 启用，生产构建不包含。

先做 4 个关键场景，其余在需要时再加，不一次铺满：

| 场景 | 内容 | 对应 | 优先级 |
|---|---|---|---|
| `fresh` | 无工作区、无会话、模型已配置 | 04 §2.3 全新用户，UC-DRAFT-01 | 先做 |
| `typical` | 3 个工作区（其中一个 30 条会话）、5 条无工作区会话、2 条置顶 | UC-SIDEBAR-01/02，侧栏和菜单走查 | 先做 |
| `running` | 当前会话运行中，含工具调用和插话；可切换为等待审批 | UC-CHAT-01，审批浮层 | 先做 |
| `pending-move` | 当前会话运行中且已换工作区，待下一轮生效 | UC-PROJECT-01 | 先做 |
| `no-model` | 模型未配置 | 04 §2.1 | 按需 |
| `settings` | 3 个 provider、6 个模型（其中一个 Needs setup、一个是默认）；3 台 MCP 服务器（已连接、失败、停用）；若干全局 Skills；搜索已配置 key | UC-SETTINGS-02 至 05 | 第二批先做 |
| `settings-empty` | 没有模型、没有 MCP 服务器、搜索未配置 | 04 §2.6 空态 | 第二批先做 |
| `settings-errors` | 模型/搜索保存返回 `VALIDATION_FAILED`（4a 先做）；MCP 配置或状态读取失败（4b 补上） | 04 §2.6、§4 | 第二批先做 |
| `many` | 600 条会话，跨 4 个工作区，多页 | 分页、Show more | 按需 |
| `missing-dir` | 当前会话的执行目录不存在 | 04 §2.2 | 按需 |
| `search` | 标题命中、正文命中、无结果三种关键词 | UC-SEARCH-01 | 按需 |
| `errors` | 列表、搜索、改归属接口返回错误 | 04 各错误行 | 按需 |

网络控制：`&delay=<ms>` 给所有假请求加延迟，`&offline=1` 模拟 daemon 断开。单用户产品，不需要角色切换。

真实后端验收继续按 improve-1 04 §4.5 的走查顺序，在临时 `OHBABY_HOME` 下跑真实 daemon。
