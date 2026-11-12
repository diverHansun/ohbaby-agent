# 实施方案与前后端契约

状态：供审查的实施方案，产品代码未修改。U1–U8 来自 [00](00-discussion.md)；下文是为落实这些要求提出的具体设计。所有 Stage 均属于本次 improve-1。

## 0. 规则速查

下表是本方案的全部规则，每条一行，便于实施时逐条勾选、验收时逐条对照。规则的理由和细节见“章节”列；04 的每个测试项也标明了覆盖哪些规则。表中规则与正文不一致时，以正文为准，并同时修正本表。

| 编号 | 规则 | 章节 | 验收 |
| --- | --- | --- | --- |
| R1 | 普通请求的输出默认 32768，不随 effort 变化；三种协议都照常发送输出上限字段 | §2、§3.2 | T02、T03 |
| R2 | context 兜底 300000；优先级为用户覆盖 > 与当前路由匹配的检测值 > 300000 | §2、§3.2 | T01、T04 |
| R3 | `contextWindowTokens`、`maxOutputTokens` 只表示用户覆盖；检测值存在 `detectedContextWindowTokens`，所属路由存在 `detectedRouteKey` | §3.1 | T01、T04、T14 |
| R4 | 检测结果的身份是 routeKey，不含凭证；改路由时清掉检测结果并重新发现；只换 key 时保留 context、重探 reasoning；routeKey 不一致时检测结果视为不存在 | §3.1 | T15、T27、T28 |
| R5 | 有效数值由一个纯函数统一解析，运行层 maxTokens 仍必填；主、子代理共用解析结果；标题、摘要、probe 的专用上限不受影响 | §3.2 | T07、T08 |
| R6 | context 放不下输出预留时，条目照常保存和读取，视图带 `tokenBudgetIssue`，该模型的新 run 被拒绝 | §3.2 | T23 |
| R7 | 写入 API：省略表示不改，正整数表示设置覆盖，Patch 中的 null 表示清除覆盖，0、负数、小数、空字符串校验失败 | §4.1 | T05 |
| R8 | 读取视图分开给出覆盖值、检测值和有效值，不另传 source 字段；输入框只显示覆盖值 | §4.2 | T01、T19、T20 |
| R9 | 表单只提交脏字段；输入与检测值相同的数字也算覆盖；后台推送不改草稿和打开时基线 | §4.2、§7 | T14、T19 |
| R10 | connect/TUI 只预填覆盖值；从已填清空时发送 null；同时给出时 `maxOutputTokens` 优先于 `maxTokens` | §4.3 | T24 |
| R11 | 自动发现只由新建、改连接、能力未知时的有修改 Save、Detect again、设为默认触发；启动、读列表、准备新 run 都不发付费探测 | §5.1 | T09、T10、T29 |
| R12 | Save 落盘后立即返回，网络请求在配置锁外进行；探测失败不撤销保存；写入失败不启动探测 | §5.1、§5.2 | T09、T22 |
| R13 | 复用现有调度器：同一条目的新触发取消旧任务并重新开始（现有行为，不做去重）；旧回包由 generation 与 routeKey 拒绝；写回成功时同时写入 `detectedRouteKey` | §5.2 | T10、T15、T17、T28 |
| R14 | context 与 reasoning 分开记状态，所有结束路径都发通知；重新探测失败时保留旧值，状态保持 identified，原因写入内存中的 `reason`，不设 stale | §5.2 | T16、T17、T18 |
| R15 | metadata 中模型名的模糊子串命中不算容量证据 | §5.3 | T11 |
| R16 | 主动 probe 的 4 项行为修复（§6.1 第 5 项只记录限制）：Chat 只用 `reasoning_effort`（D12 去掉 `reasoning` 对象回退）；档位并发验证，总期限 60 秒；只有 400/422 算不支持，其他非 2xx 状态一律 unknown；每个请求带一个空工具；Responses 正式请求允许经过能力校验的 max；Anthropic adaptive 排除 minimal，清理不兼容旧偏好并通知 | §6.1、§6.4 | T11、T12、T13、T31、T32 |
| R17 | 新 run 不等待探测；能力未知时按 service-default 发送，用户偏好保留 | §6.3 | T25 |
| R18 | 前端：输入框默认为空，检测值以“自动”提示显示；探测动效必定结束；能力未知时不把已选 effort 显示为生效；配置标签统一为 Reasoning Effort | §7 | T19、T20、T21、T25 |
| R19 | 旧配置一次性迁移：context 转为检测值，恰好 8192 的输出值删除；混合格式中残留的顶层 `llmParams.maxTokens` 不再被条目继承；仅版本属性缺失时在 `readModelDocument` 中迁移，版本 2 只归一化，其他版本拒绝；首次落盘前备份并写入版本 2 | §3.1、§8 | T06、T25、T26 |
| R20 | 两个默认值只在 `modelProfiles.ts` 定义，任何路径都不把默认值写进覆盖字段 | §9.1 | T27、T30 |
| R21 | 凭证原文和派生值不进入设置视图、事件、日志、错误和 model.json；缺 key 时不发探测请求 | §3.1、§5.1 | T27 |

## 1. 总体方案

保存用户意图和自动识别结果，在后端统一解析有效数值；普通运行配置继续使用必填数字。保存完成后复用现有 discovery 调度器，自动补齐缺失的能力，Settings 和 composer 使用同一发现状态。

```text
模型表单 → 配置校验与原子保存 → 返回成功
                         ↓
                  后台 metadata / effort 发现
                         ↓
             按配置身份写回检测值 → 发布完成通知

用户覆盖 + 自动证据 + 产品默认 → 统一解析 → RunModel → 主 / 子代理请求
```

不把供应商调用移到 Web，不让表单猜默认值，不另建一套探测服务。

## 2. 固定决策与限制

| 决策 | 本方案 | 代价或边界 |
| --- | --- | --- |
| 普通请求输出默认 | 32768，所有现有协议仍发送对应上限字段 | 不保证任意第三方或旧模型接受；明确拒绝时提示用户修改，不静默换成另一个数字 |
| effort 与输出额度 | 独立；不因 low/high/max 调整默认输出上限 | Anthropic 显式 thinking budget 仍须通过已有合法性检查 |
| context fallback | 300000，十进制 | 只代表本地预算假设，不代表实际模型能力 |
| context 优先级 | 用户覆盖 > 与当前路由匹配的检测值 > 300000 | 不使用模糊模型名匹配的结果作为已识别值 |
| 数值清空 | Patch null 表示删除用户覆盖 | null 只用于配置 API，不能传到模型 API |
| Save | 先保存，再自动完成必要的发现 | 探测失败不撤销保存，不改变默认模型选择 |
| 覆盖与探测 | 分开持久化 | 比单一数字多两个可选字段和少量来源投影，但能避免长期竞态 |
| 主子一致性 | 共用统一解析后的 RunModel | 已在运行的模型快照不追溯修改 |

2026-11-12 补充真实短请求：18 个模型／协议组合都接受显式 32768，附带工具定义，Responses 还指定 medium。结果见本地 `.ohbaby/max-output-investigation/explicit-32768-results.json`。这是参数兼容证据，不是长上下文或流式工具闭环验收。

## 3. 持久化与运行投影

### 3.1 推荐的最小存储结构

沿用现有模型库结构，顶层新增一个 `schemaVersion: 2`（见 [00 §6](00-discussion.md) D8）。这一批本来就要把条目的 context 改为可选，旧版本程序读不了新文件，用版本号把这次格式变化标出来，也作为“已迁移”的标记。旧条目中的数字按 §8 一次性迁移，新增两个可选来源字段即可表达自动模式。旧顶层及混合格式同样按 §8 处理。

```typescript
// 仅为受影响字段的设计草图，不是完整类型。
interface ModelDocument {
  schemaVersion?: 2;                     // 缺失即旧格式，需要迁移
  activeProfileId?: string;
  models: ModelEntry[];
}

interface ModelEntry {
  contextWindowTokens?: number;          // 用户覆盖；缺失即自动
  maxOutputTokens?: number;              // 用户覆盖；缺失即 32768
  detectedContextWindowTokens?: number;  // 最后一次可靠检测值
  detectedRouteKey?: string;             // 检测结果所属路由，context 与 reasoning 共用
  // 保留现有 reasoningCapabilities / reasoningCapabilitySource / reasoning 等字段。
}
```

`normalizeModelDocument` 现在会重建文档对象，只保留 `activeProfileId` 和 `models`（`model-document.ts:164-169`），所以 `schemaVersion` 必须明确加进类型和归一化逻辑，否则一保存就会丢失。`ModelEntry` 不再直接继承“context 必填”的运行 profile；使用 Omit 或独立的存储类型。进入 `ohbaby-llm` 前，将其投影成已有的完整 `ModelJsonModelProfile` 和 `LLMConfig`。**运行层 maxTokens 继续必填**，本轮不做全链路 undefined 改造。

#### 检测结果的身份

用户已确认（见 [00 §6](00-discussion.md) D2）：检测结果的身份直接使用现有的 `modelProfileRouteKey`，即 provider、model、协议和规范化 baseUrl，不包含凭证。规则如下：

- `detectedRouteKey` 记录检测结果所属的路由。context 和 reasoning 共用这一个值，不分两套身份。
- 通过设置 API 修改 provider、model、协议或 baseUrl 时，同时清掉检测到的 context、自动 reasoning 能力和 `detectedRouteKey`，然后重新发现。现有代码只清 reasoning，这里补上 context。
- 只修改 key 时，沿用现有行为：清掉自动 reasoning 能力并重新探测；检测到的 context 保留，因为上下文窗口不随 key 变化。
- 读取时，如果 `detectedRouteKey` 与条目当前路由不一致（例如有人手改了 model.json），检测结果一律视为不存在。
- 在途任务的旧回包仍由现有的 generation 与 routeKey 双重校验拒绝，经设置 API 的 A→B→A 切换也包括在内。
- 直接修改 env 文件中的 key 不会被自动发现，下次 Save 或 Detect again 时更新。代价是，换成不同套餐的账号后，界面上的 reasoning 档位可能暂时是旧的。
- 修改 `apiKeyEnv` 或 `promptCache` 时，按“只修改 key”的规则处理：它们不在 routeKey 里，现有代码把它们算作连接变化，会清掉自动 reasoning 能力并重探。
- 用户覆盖不属于检测结果，始终保留。自动发现只写检测字段，不写用户覆盖字段。
- 过滤位置：`model-document.ts` 把条目投影成运行 profile 时，`detectedRouteKey` 缺失或与当前路由不一致的条目，既不带检测到的 context，也不带自动来源（model-metadata、active-probe）的 `reasoningCapabilities`。这样 `capabilitiesFor` 和预算计算拿到的都是已经过滤的数据，不需要在各个消费者里重复判断。
- Settings、composer、discovery 的已有能力判断和偏好兼容性校验也使用同一份过滤后的 profile，不直接把原始存储条目传给 `capabilitiesFor`。当前 `writer.ts:239` 仍直接使用原始条目，必须同步调整，否则运行已过滤而界面仍会显示旧能力。
- 校验位置：`model-document.ts` 的 `validateEntry` 现在把条目原样交给 ohbaby-llm 的 `validateModelJson`，后者要求 `models[].contextWindowTokens` 是正整数（`ohbaby-llm/src/config/validation.ts:148`）。改为先投影出有效值再校验，否则所有没有覆盖的条目都会校验失败。

这样，后端不计算也不保存任何凭证指纹，配置文件里只多一个路由字符串。

### 3.2 统一解析

所有入口都使用同一个小型纯函数解析数字。产品默认常量集中在 `services/llm-model` 的无 I/O 模块，并由 config 投影复用；不在 SDK、前端和各 provider 复制默认值。

```text
effectiveMaxOutputTokens = userMaxOutputTokens ?? 32768
effectiveContextWindowTokens = userContextWindowTokens
                            ?? detectedContextWindowTokens（仅当 detectedRouteKey 与当前路由一致）
                            ?? 300000
reservedOutputTokens = effectiveMaxOutputTokens
```

普通请求、活动模型摘要、压缩预算和子代理继承使用同一解析结果。保留现有安全余量和压缩策略，不照搬参考项目按每步剩余窗口调整 cap 的新策略。

标题、压缩摘要、主动能力探测等已有单次专用上限继续生效，不能被普通 32768 默认强制覆盖。配置文件中需要有效数字的旧消费者只接收投影，不反向回写 fallback 到用户配置。

数值结构校验与单模型可用性校验分开。正整数、类型和 schema 错误按现有保存规则拒绝；context 小于等于输出预留与必要余量时，条目仍可保存和读取，但设置视图返回 `tokenBudgetIssue`，该模型的新运行在 admission/preparation 阶段以 `MODEL_TOKEN_LIMITS_INCOMPATIBLE` 拒绝并提示修改输出或 context。不能把一项组合不合适变成整个模型库读取失败。

特别是保存时使用 300000、后台随后探测到 16384 的场景：可靠检测值照常保存，context 仍为 identified，停止动效，同时显示该条目的组合问题；不撤销保存、不把结果降成 unknown、不退回 300000、不擅自降低 32768。其他模型继续可用；用户修正覆盖后自动解除问题。`configurationComplete` 仍只表达连接信息完整，不承担数值可用性语义。可信元数据若明确表明输出上限不兼容，应提示用户选择有效值；本轮不实现自动扩大或按 effort 改写用户设置。

## 4. Settings API 与表单契约

### 4.1 写入

| 输入 | Create | Patch |
| --- | --- | --- |
| 省略数值字段 | 没有覆盖 | 不修改 |
| 正整数 | 保存用户覆盖 | 设置用户覆盖 |
| null | 不接受，创建时省略即可 | 删除用户覆盖，恢复自动 |
| 0、负数、小数、空字符串 | 校验失败 | 校验失败 |

context 的清空只删除用户覆盖，不删除同一身份的可靠检测值。清空后输入框恢复空，若有检测值，在该字段旁显示“自动：1000000 tokens”这类明确的自动值提示；没有检测值则不显示容量数字。max output 清空后输入框留空、有效值恢复 32768。

### 4.2 读取投影

Settings 字段读写含义统一：contextWindowTokens 和 maxOutputTokens 都只表达用户覆盖，有效数值使用独立 effective 字段。SDK、agent、Web 同批更新，运行消费者继续使用单独的完整 LLMConfig，不用 Settings 表单字段做预算。

```typescript
interface ModelSettingsNumericView {
  contextWindowTokens?: number;            // 用户覆盖；与 Patch 同义
  detectedContextWindowTokens?: number;    // 与当前路由匹配的检测值
  effectiveContextWindowTokens: number;
  maxOutputTokens?: number;                // 只表示用户覆盖
  effectiveMaxOutputTokens: number;
  tokenBudgetIssue?: {
    code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE";
    contextWindowTokens: number;
    maxOutputTokens: number;
  };                                      // 单模型可修正问题，不阻断 settings 读取
  contextDiscovery: {
    status: "detecting" | "identified" | "unknown";
    reason?: string;                      // 最近一次失败原因，仅内存，重启后清空
  };
  reasoningNotice?: "unsupported-anthropic-effort-cleared"; // 清理提示，仅内存
  // reasoning 继续复用 UiReasoningCapabilityView。
}
```

两个输入框只显示对应用户覆盖。context 检测值使用紧邻字段、带“自动”标记的只读提示，不写入表单值；这样满足“前端显示 probe 大小”，也不把检测结果变成用户输入。未检测到时保持输入空白，不用 300000 数字 placeholder 冒充识别结果。来源可以从 override/detected 是否存在推导，无需再传一个可能矛盾的 source 字段。

修改 label 等无关字段时，只提交脏字段；自动回填的 context 不进入 Patch。用户主动输入与检测值相同的数字，仍算手动覆盖；以交互意图判断，不以数值是否相等判断。

后台推送只更新只读检测提示和状态，不覆盖输入草稿。用户清空后下一次 Save 提交 null，后续仅显示自动提示，不能被再次保存成新覆盖。表单按既有打开时基线和实际编辑差异生成 Patch，不因检测回包重置基线。

### 4.3 connect / TUI 同步契约

`UiCurrentModelConfig` 同样将 contextWindowTokens/maxOutputTokens 定义为覆盖值，新增 detectedContextWindowTokens 与 effectiveContextWindowTokens/effectiveMaxOutputTokens，并携带 §6.4 的可选 reasoningNotice。`draftFromCurrentModel` 只预填覆盖值；没有覆盖时保持空，不拿运行有效值预填。TUI 由主代理负责，Pi 仅负责 Web。

`UiConnectModelInput` 的两个可选数字允许 null 表示清空；省略表示保持匹配旧条目的覆盖、对新条目表示无覆盖。`request-helpers.ts`、OpenAPI 和 connect 路由校验同步接受 null，禁止被数字转换吞掉。`setActiveLLMConfig` 的 maxTokens 旧别名仍可表达显式值；若同时传两个输出字段，以 maxOutputTokens（包括 null）为准，并记录同义字段优先级测试。

`applyActiveModelConfig` 不再把“检测 > 用户 > 默认”的合成数字作为用户输入传给 writer（现在 `:299` 把 `resolveContextWindow` 的结果写进 `contextWindowTokens`，其中可能是检测值，也可能是 `:381` 的默认值）。改为只传用户填写的覆盖值；connect 时的内联 metadata 结果不再写入条目，检测值统一由保存后的后台发现写入，并同时写入 `detectedRouteKey`。解析优先级统一为本方案 §2。`setActiveLLMConfig` 不把缺省 max output 自动落盘为 32768。connect 保存也使用先提交、后后台发现；保留独立只读 metadata probe 接口，但其结果不能被 connect 表单无意升为用户覆盖。

当前 probe 接口保持“unknown 也是成功返回”的语义。可维持只返回 reasoning 的现有响应，由模型设置变更事件触发重新读取完整 settings；不另建前端轮询系统。

## 5. 保存后发现流程

### 5.1 条件与触发

基本条件是模型 ID、有效 HTTP(S) base URL、协议和可解析凭证。保留现有明确无鉴权端点的兼容行为，不强迫本地服务填写假 key；引用了不存在的 key 时终止为缺凭证状态，不拿占位凭证进行付费探测。

以下操作触发自动发现：创建完整模型；修改 provider/model/base URL/协议/有效凭证；此前能力 unknown 时发生下一次真实配置保存。仅改 label、数值覆盖或 effort 选择且当前身份能力已知时，不重复付费探测。清空 context 且没有同身份检测值时，也应安排一次发现。

触发判断先检查整个条目是否有在途发现任务：有任务时，仅改 label、数值覆盖或 effort 不触发新任务，即使 context 阶段已 unknown、reasoning 阶段仍 detecting，也继续原任务。没有在途任务时，context 或 reasoning 至少一项 unknown 的真实 Save 才重试。Detect again、改连接和设为默认等明确触发仍按 §5.2 替换旧任务。

保留当前“无修改则 Save 禁用”的表单规则；原样重试用 Detect again，不为了重试制造空 Patch。这里没有基于时间的 TTL：“失效”指身份不匹配。unknown 在有脏字段的实际 Save 或手动重试时重新发现；已有旧值、只是重新探测失败的条目，由用户点 Detect again 重试。不新增定时刷新。

不设启动恢复队列（见 [00 §6](00-discussion.md) D3）。手改 model.json 导致 `detectedRouteKey` 与当前路由不一致时，检测结果视为不存在，之后由已有触发点补上：有修改的 Save、Detect again、设为默认时的主动探测。读取 Settings 列表、首次装载和准备新运行都不会发起付费探测。

Save 发布到磁盘成功后即返回，不等待网络。完整发现不是每次 Save 都无条件发一整轮主动请求：先读取 metadata、使用与身份匹配的可信内置/已有能力，缺失时才做主动验证。手动 Detect again 复用同一调度器，并允许重新验证已有自动结果；它不得覆盖用户显式能力配置。

这里的“已有能力”包括同路由已存的 model-metadata/active-probe 结果，普通 Save 和设为默认都复用；只有 Detect again 强制忽略这类自动缓存重新验证，显式能力与内置能力的现有优先级保持不变。当前 `apply-active-model-config.ts:565-582` 的 known 判断只带入显式条目，实施时需要改成使用已过滤的有效自动证据，否则 T10 仍会反复发付费请求。

metadata 缺字段、未找到模型或接口 404 不阻止必要的主动验证；metadata 已明确报告认证失败、限流或任务取消时，不继续发主动 POST，按对应原因结束。这与 T11 的停止条件一致。

### 5.2 调度与写回

复用 `startModelEntryDiscovery`、`coordinateModelConfig`、`modelEntryGeneration`、AbortController 和现有事件通知；不增加独立全局服务。

1. 保存后捕获条目、generation、routeKey 和凭证。同一条目的新触发一律取消旧任务并重新开始，这是现有行为（`apply-active-model-config.ts:527`），不另做去重；同一时刻每个条目最多一个在途任务。登记 detecting 后立即发布状态通知，不能只等最终结果。Save 响应可直接携带已登记状态；若任务稍后登记，则必须由开始事件让 Settings 与 composer 观察到它。
2. 在配置发布锁外发网络请求。Metadata 整体上限 15 秒；主动阶段整体上限 60 秒（见 §6.1），两种阶段均尊重取消信号。
3. 两类结果分开记状态：context 找到不代表 reasoning 已完成，反之亦然。使用现有 detecting/identified/unknown 状态，附有界错误原因；阶段结束而另一阶段仍在进行时也发布状态变更。
4. 写回时在配置锁内重新读取条目，比较捕获的 generation 与 routeKey（现有 `writeModelEntryMetadata` 已这样做），并检查条目仍存在。若存量 `detectedRouteKey` 缺失或不匹配，先清除旧检测 context 和自动 reasoning 能力，再写入本次成功的字段及新的 `detectedRouteKey`；不得仅更新共用身份，就把另一项未成功重探的旧证据变成有效。这个清理也覆盖手改 model.json 的路径。手动覆盖和显式能力不参与清理或自动写回；删除条目不能被旧回包重建。
5. 成功、未知、超时、网络错误都结束当前状态并发布 settings 更新。过期任务只清理自身，不能把新任务状态改成 unknown。
6. 同身份重新探测失败时保留上次可靠结果，状态保持 identified，失败原因写入 `reason`（只存在内存，不落盘）；没有任何旧值时才是 unknown。不设单独的 stale 状态（见 [00 §6](00-discussion.md) D4）。当前调度器失败时记录 unknown，但 `reasoning-view.ts:44-45` 有旧能力时仍输出 identified+stale；新方案要删除 SDK `connect-model.ts:138`、OpenAPI `app/openapi.ts:725` 和视图中的 stale，并让 identified 也携带 reason。CLI `components/prompt/footer.ts:29` 同步删除 stale→unknown 的判断，不能只改后端调度状态。进程重启后不得恢复永久 detecting；持久化有效能力可复用，缺失或失效的证据保持 unknown，不因读取而自动发请求。

输出/context 手动覆盖变化不应中止无关的 reasoning 发现，但返回的有效数值必须以写回时最新覆盖为准。

本轮不引入跨进程文件监听，外部修改 env 文件中的 key 不触发重新发现（见 §3.1）。设置 API 内的 A→B→A 仍由 generation 严格拒绝旧结果。

### 5.3 元数据范围

优先读取配置端点对应的模型元数据，按已核实协议处理 `/models` 路径、分页和字段。禁止把完整模型名的模糊子串命中当作容量证据；允许供应商有依据的精确别名规范化。

API key 有效不等于存在 `/models` 或返回 context。缺失时保持 unknown，后端 fallback 300000。未知 model 不通过发送巨量输入来试出容量，也不引入公共模型数据库作为本轮新依赖。

## 6. Reasoning Effort 主动验证

用户已确认把 probe 精度纳入本轮（见 [00 §6](00-discussion.md) D6），范围限定为下面 5 项修复。依据是 2026-11-12 对测试清单 18 条路由的实测，见 [01 §5](01-problem-analysis-and-current-state.md)。现有 `reasoning-active-probe.ts` 的整体做法保留：直接用 fetch 发请求，先用编造的档位做对照，再逐档验证，最后验证能否关闭，每个请求输出上限 32 tokens。

### 6.1 五项修复

**1. Chat 端点使用 OpenAI 标准的 `reasoning_effort`。** 所有 Chat 端点（wire 为 `openai`）都用 `reasoning_effort`：对照请求被 400/422 拒绝时继续验证，返回 2xx（字段被忽略）时直接返回 unknown。Responses 和 Anthropic 路由各用现有的一种格式。原方案在 Chat 上还会回退尝试 `reasoning` 对象，实测 18 条路由没有一条需要它，按 D12 删除；只认 `reasoning` 对象的网关会得到 unknown，按 §6.3 走 service-default，不会出错。探测得到的 wire 写进能力结果，正式请求按同一个 wire 序列化；关闭推理使用 serializer 中同一 wire 的写法，例如 Chat 上的 `reasoning_effort: "none"`。

**2. 档位并发验证，总期限 60 秒。** 对照请求通过后，按协议选择候选档位：Chat/Responses 最多 6 档，Anthropic adaptive 为 low/medium/high/xhigh/max 共 5 档、不探 minimal；这些候选和关闭请求一起并发发出，不再两个一批地串行。整次探测（含对照）的总期限从 30 秒改为 60 秒。单次探测最多 8 个 POST：一次对照，加 7 个验证请求。

**3. 只有 400/422 算“不支持该档位”。** 验证请求返回 2xx，记为支持；返回 400 或 422，记为不支持。其他任何结果，包括 401、403、404、408、413、429、3xx、5xx、网络错误、超时或取消，整次结果按 unknown 处理并记录原因，不拿残缺的档位列表充数。对照请求只有 2xx（字段被忽略，返回 unknown）和 400/422（字段被校验，继续验证）两种可用结果，其他结果同样直接返回 unknown。

主动 probe 的返回值必须包含能力或有界失败原因，不能继续只返回 `ReasoningCapabilities | undefined`：当前调度器在主动探测失败时沿用 metadata 原因，会把主动阶段的 429/超时误报成“缺字段”。实际进入主动阶段后，以该阶段的失败原因为准，用于终态通知及旧值保留时的 `reason`。probe 的 fetch 使用 `redirect: "manual"`，确保 3xx 不被自动跟随后误判为最终 200/400；正式模型请求不因此改变。

**4. 每个探测请求带一个最小的空工具。** 按协议的工具格式附带一个无参数的 `noop` 函数，不指定 tool_choice，也不执行工具。这样，探测请求和 agent 的真实请求形状一致，能发现“工具和 reasoning 不能同时使用”这类路由，例如 OpenAI 官方 Chat 接口。这类路由所有档位都会返回 400，结果是 unknown（现有代码在没有任何档位成功时也返回 unknown），之后的 run 按 §6.3 用 service-default 发送。

**5. 已知的限制写清楚，本轮不处理。**

- 接受不等于有区别：DeepSeek 对 7 个值都返回 200，但部分档位应该只是被映射到同一档。HTTP 状态码分不出这一点，界面可能多显示几个等效档位，不会导致请求出错。
- 内置能力表优先于 probe，命中就不再探测。表里过时的条目（例如 Zenmux luna Chat 只写了 low、medium、high）属于数据问题，单独更新，不改优先级机制。
- 网关确实忽略 reasoning 字段时（例如 Zenmux 的 DeepSeek Responses），结果就是 unknown，这是正确结果。

### 6.2 不做的事

实测没有出现需要以下设计的情况，本轮不做：

- 不尝试 `thinking`、`enable_thinking` 这类 binary 字段。所有 Chat 路由都接受 `reasoning_effort`。
- 不因预算不足而放大输出上限重试。32 tokens 在所有路由上都没有触发预算错误。
- 不另建“绕过本地 validator 的专用请求”。现有 probe 本来就直接用 fetch。
- 不按错误文案解析支持的档位列表。逐档验证已经能得到同样的结果，而且不依赖各家的错误措辞。

### 6.3 偏好与未知能力

用户的 effort 偏好与能力证据分开：发现成功不覆盖仍合法的手动偏好；能力证明其不兼容时，按已有规则清除，并发布更新；D10 已确认的 Anthropic adaptive minimal 属于已知协议不兼容，即使过滤后能力未知，也清理该不兼容旧偏好并通知。这里的“允许手动”包括重新探测、选择档位与现有能力覆盖，不增加一套任意 JSON 编辑器。

新 run 不等待能力探测（见 [00 §6](00-discussion.md) D3）。没有有效能力证据且处于“探测中”或“未识别”时，沿用现有行为：`resolveRequestReasoning` 按 service-default 发送，不带 effort；`compatibleReasoningPreference` 在能力未知时保留用户偏好，探测成功后偏好自动生效。已有同路由可信能力的重新探测不撤销旧能力：期间发起的新 run 继续按旧能力与偏好发送，失败后仍 identified 并附 reason。探测进行中不等于能力不存在，不能仅凭 UI 动效切换请求参数。不新增 `MODEL_REASONING_CAPABILITY_UNVERIFIED` 错误，也不在 run 准备阶段等待共享的发现任务。

这样做的代价是：刚改完连接就马上发出的消息，或探测失败的模型，可能没有用上用户选的 effort。界面必须如实显示，见 §7。已捕获模型快照的在途 run 不追溯修改。

### 6.4 探测档位与正式请求一致性

**Responses max：已确认，纳入 S2。** 用户选择见 00 D9。`ohbaby-llm/src/providers/openai-responses.ts:147-157` 的正式请求白名单加入 max，继续沿用现有能力校验：只有当前路由的有效能力允许 max 时，用户选择才可进入正式请求。不放行任意字符串，不把 max 自动加入所有模型能力，不改内置能力优先级。已安装的 OpenAI SDK 7.13.0 类型包含 max，无需为此升级依赖或绕过类型检查。

新 probe、metadata、内置与迁移后的有效能力含 max 时，正式请求均应正确发送 `reasoning.effort: "max"`。探测成功不自动替用户选择 max，也不改变普通输出上限 32768。验收覆盖探测结果落盘、重读、用户选择、能力校验和正式 provider 请求构造；同时覆盖原有 Zenmux luna Responses 内置 max、旧自动证据及偏好迁移，以及能力不支持 max 时仍拒绝选择。详见 T31。

**Anthropic minimal：已确认，纳入 S1/S2/S3。** 用户选择见 00 D10。当前正式 `output_config.effort` 只允许 low/medium/high/xhigh/max，本轮不放宽 serializer 或 SDK 类型：

1. 新的 Anthropic adaptive probe 不发送 minimal。metadata、内置、显式及持久化能力在同一有效能力解析出口按正式可发送范围投影，不能仅修改 probe 候选；保留其来源优先级、其他合法档位及关闭能力。过滤后 effort 列表为空时视为能力 unknown，不能伪造“模型不支持推理”，也不能让整个模型库读取失败。
2. 旧配置展开和版本 2 读取均应用这项兼容处理，不受“一次性数字迁移”限制。保留原始能力证据，由有效投影排除不可发送的档位。模型的旧 reasoning 默认偏好若实际会发送 minimal，沿用现有清理方式撤销该不兼容 reasoning 覆盖，回到已知能力的默认行为；能力未知时使用 service-default。未知能力通常保留偏好的规则不阻止这项已知不兼容清理。新 Create/Patch 明确选择不可发送的 minimal 时直接返回校验错误，不先保存再悄悄清除。
3. 清理属于模型配置层：读取时产生规范化结果与清理事实，不因读取而写盘；下一次成功的常规保存或探测写回持久化清理后的配置。运行投影和设置视图必须立即一致，不能继续使用已清理偏好。不改历史消息、在途 run 或批量重写会话偏好；会话/单次请求不新增特殊恢复规则：能力已知时按现有请求校验拒绝不兼容选择；能力 unknown 时仍按 D3 使用 service-default，不发送该 effort，并在 UI 如实显示未生效。不能声称 unknown 路径也会报校验错。已有明确 effortMap 映射到合法输出值的偏好，以及不发送 output_config.effort 的 budget/binary 配置，不属于此项误清理范围；不新增自动 minimal→low 映射。
4. 清理必须让用户可见。Settings 和 current-model 视图增加可选 `reasoningNotice: "unsupported-anthropic-effort-cleared"`，在产生清理的读取、Save 或 discovery 投影中携带；普通 settings 更新事件只负责通知重新读取，不能充当已展示提示的证据。该通知是固定码，不含原始配置或凭证；仅在当前进程内按模型保留，不落 model.json、不建持久通知队列，不能被后续 probe 状态覆盖。用户下一次成功保存该模型的明确 reasoning 选择后清除；同一次清理的保存不能立即清掉通知。Web 模型编辑器和 TUI 显示“此模型的 minimal 推理设置不受当前 Anthropic 请求格式支持，已清除该覆盖并恢复默认行为”。清理后重启无需重复历史提示；原文件尚未保存、再次读取仍需清理时，可以再次提示。

§6.1 的六档是跨协议候选上限，各协议候选与本节一致，最多 8 个 POST 的上限不增加。D9/D10 不引入通用供应商框架，不改变普通输出默认值或已有能力优先级。T31/T32 覆盖完整请求与用户通知；本节已无待定行为取舍。

## 7. 前端实施契约与分工

主代理先实现并验证 API/SDK 契约，再由 Pi 实现 Web 交互，避免双方各猜一次空值含义。

Pi 使用本机已确认的 `magpie` provider、`claude/claude-opus-5-5` model、`xhigh`；这是用户指定模型在本机的准确路由，不替换成其他模型。实施阶段按 calling-pi-agent 技能建立独立 session 并保留目录与 ID。本轮仅检查模型与认证就绪，没有派发实施。

Pi 的范围：`apps/ohbaby-web/src/ui/settings/`、相关 runtime settings 订阅和前端测试；配置相关 Thinking 文案统一成 Reasoning Effort，包括更多菜单。消息内容中的 Thought/Thinking 不是配置标签，不随之改名。

必须表现：

- 新增默认输入框为空；保存、关闭、重开后也不能被 fallback 填满。context 检测值显示在旁边的自动提示，不写入输入框。
- 自动探测使用现有动效；成功后无需手动刷新，失败/超时必须停下。
- 用户覆盖优先；清空恢复自动；后台结果不覆盖正在编辑的草稿。
- context 和 reasoning 状态独立；一个失败不阻止另一个成功。
- `reasoningNotice` 的偏好清理通知必须在对应模型中可见；不只刷新下拉选项，也不只发后台事件。文案与清除时机遵循 §6.4。
- 没有有效 reasoning 能力而处于“探测中”或“未识别”时，composer 和 Settings 不能把已选 effort 显示成正在生效；已有可信能力的重新探测仍显示正在使用的旧能力，可同时展示探测动效。
- Detect again 保留，重复点击不产生无界并发。
- 切换模型或关闭设置后不把旧回包写到新草稿。

主代理复核 Pi diff、合并接口、跑集成与真实页面验收。Pi 不修改后端默认值、持久化结构、凭证或真实用户配置。

## 8. 迁移、兼容与回滚

旧条目的数字没有来源记录：创建时 context 一律写成 128000，探测结果又写回同一个字段；connect 路径每次保存都把 max output 写成 8192。用户已确认下面的迁移规则（见 [00 §6](00-discussion.md) D1）：

| 旧字段 | 迁移规则 | 升级后的效果 |
| --- | --- | --- |
| `contextWindowTokens` | 不论数值多少，一律移到 `detectedContextWindowTokens`，用户覆盖为空；迁移值绑定当前路由身份 | 有效 context 不变；输入框为空，旁边显示“自动：X”；下次探测成功后换成新值 |
| `maxOutputTokens` 恰好为 8192 | 删除该字段，按自动处理 | 有效输出变为 32768 |
| `maxOutputTokens` 为其他数值 | 保留为用户覆盖 | 不变 |
| 没有 `maxOutputTokens` | 不处理 | 有效输出变为 32768 |

取舍说明：

- context 迁移的代价是，原本只是默认 128000 的条目会显示为“自动：128000”，看起来像探测结果。之所以接受，是因为升级前后有效值完全不变，不会出现压缩阈值突然变大导致的上下文超限。用户手填过的 context 也会变成检测值，之后若探测成功会被替换；用户需要固定数值时重新填写即可。
- 用户特意填写的 8192 也会被当作旧默认改为 32768，用户可以重新填写。
- 不加“context 放不下 32768 就保留 8192”的保护规则。context 很小的旧条目升级后可能出现 `tokenBudgetIssue`，按 §3.2 提示用户调小 max output。
- 迁移只执行一次，由 `schemaVersion` 判断：
  - 迁移逻辑只放在 `readModelDocument` 中：`schemaVersion` 属性缺失才在内存里迁移；数值 2 只走归一化；其他值（包括未来版本 3、字符串 "2"、null）报配置错误，不迁移、不落盘。不能用 `schemaVersion !== 2` 判断旧格式。
  - 读取顺序固定为：识别版本 → 仅展开旧顶层结构并保留原始偏好 → 对展开后的条目执行本节数值迁移 → 形成版本 2 内存文档 → 纯归一化与校验。`normalizeModelDocument` 和 persist 不再做旧顶层继承或数值迁移；当前 normalizer 在 `:251` 补顶层输出、`:272` 按旧预算校验偏好的逻辑不能原封不动先跑一遍，以免补回 8192 或提前丢失偏好。
  - `persistDocument` 落盘时一律写入 `schemaVersion: 2`。只读不写时，每次读取都在内存里得到同样的迁移结果；第一次落盘后，文件本身就带着标记。
  - 迁移完成后，`contextWindowTokens` 和 `maxOutputTokens` 只表示用户覆盖；之后用户再填 8192，必须保留。
  - 标记跟着文件走，删除 `backups/` 目录或把 model.json 拷到别处，都不会触发重复迁移。

这一规则不包含模型库格式中残留的顶层参数，后者按本节后文处理。

旧 reasoning 自动证据先按 §6.4 的正式请求兼容范围进行有效投影，不支持的 Anthropic adaptive minimal 偏好清理并通知；其他旧自动证据（标为 model-metadata/active-probe）与旧 context 一样，迁移时写入当前路由作为 `detectedRouteKey`，继续作为可信证据使用。现有代码在修改连接时已经清掉这类证据，因此留下来的旧证据就是当前路由下得到的。用户显式 capability 覆盖保留，内置能力按当前路由重新解析。用户 reasoning 偏好也保留，除非新证据确认不兼容，或命中 D10 已知的协议不兼容清理。测试要覆盖：能力未知期间偏好保留，探测成功后按原偏好发送。

按上表，存为 8192 的旧条目升级后会改用 32768，其他手填的输出值不变。对外说明时要讲清楚这个边界，不能笼统地说“所有历史配置都改成了 32768”。

旧顶层单模型的精确判据沿用现有结构：**没有 activeProfileId 属性，且存在顶层 provider、defaultModel、apiConfig**。这种旧文档即使带 models 数组也仍按旧单模型迁移，其 llmParams 按旧兼容规则转成明确条目值。其他模型库结构以逐条字段为准，不再从残留的顶层 llmParams 补齐输出覆盖。第一次成功落盘后只保留模型库结构，不双写旧投影字段。清空、保存、重新读取都不能把旧 8192 补回来。

需要明确接受一个混合格式兼容变化：若文档已有 activeProfileId、顶层 llmParams.maxTokens=4000，条目 a 自带5000、条目 b 无 maxOutputTokens，则新方案 a 仍为5000，b 从旧实现继承的4000改为默认32768。已有测试 `session-model-config.integration.test.ts` 覆盖过这种继承，实施须调整断言并在迁移说明中记录。此处选择停止残留全局继承，避免无法区分的旧顶层数值重新污染清空操作；如果用户要求保留这种混合继承，应另定明确迁移机制后再实施，不能悄悄改变。

配置与凭证仍沿用现有原子替换、失败回滚和配置不一致保护。原文件缺失 `schemaVersion` 属性时，第一次落盘前备份原文件，包括已经是 models 数组的文档；现有 `backupLegacyModelDocument`（`writer.ts:679`）只在旧顶层格式时备份，要把条件改为“版本属性缺失”。文件已是版本 2 后，普通保存和探测写回都不再生成备份；不支持的版本不得覆盖。回滚产品版本时恢复对应备份，不能假定旧二进制支持 context 可省略的新结构。仅在实际修改凭证时备份/回滚凭证文件。

## 9. 实施阶段与改动面

| Stage | 负责方 | 主要改动面 | 完成定义 |
| --- | --- | --- | --- |
| S1 默认值与存储意图 | 主代理 | §9.1 列出的默认值位置；`config/llm/model-document.ts`、`writer.ts`、`services/llm-model/modelProfiles.ts`、SDK settings/connect-model contract | 旧结构兼容、清空、统一解析、运行数字一致，§9.1 的 grep 检查通过，相关类型和测试通过 |
| S2 自动发现与状态 | 主代理 | `apply-active-model-config.ts`、`context-window-probe.ts`、`reasoning-active-probe.ts`、`reasoning-view.ts`、`ohbaby-llm/src/providers/openai-responses.ts` 及 `reasoning.ts` 的有效能力解析、Web route 与 ui-inprocess 投影；CLI `connect-panel.tsx`、server `protocols/web/request-helpers.ts`、`app/openapi.ts` | Save 自动完整发现，所有结束路径通知，竞态和偏好保护、Responses max 的 T31 与 Anthropic minimal 的 T32 闭环通过；connect/TUI 不再回灌有效值 |
| S3 前端 | Pi，主代理监督 | `model-form.ts`、`ModelEditor.tsx`、`ComposerMoreMenu.tsx`、settings runtime 及测试 | 空值、检测值、清空、草稿、动效、标签和偏好清理提示全部按 §7 工作 |
| S4 集成验收 | 主代理 | 配置、LLM 请求、主子运行测试，真实 Web 验证，现行设计文档 | 满足 04，记录实际实施验收后才能创建 05 |

SDK、agent、CLI 和 Web 需要同批发布；Settings/current-model 读取字段的含义调整须同步所有消费者，不能继续把它们当作有效数字。旧 connect/TUI 配置入口同样经统一解析，不能把自动 fallback 再存回覆盖字段。

### 9.1 默认值的唯一来源

用户已确认（见 [00 §6](00-discussion.md) D5）：两个默认值只在 `services/llm-model/modelProfiles.ts` 中定义并导出，其他生产路径一律 import。基线 `b8d5fc67` 上需要处理的位置如下（路径相对 `packages/ohbaby-agent/src`，Web 路径相对 `apps/ohbaby-web/src`）：

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `services/llm-model/modelProfiles.ts:1-2` | 128_000、8_192 | 唯一定义：300000、32768，两个都导出 |
| `config/llm/model-document.ts:17` | 另一份导出的 128_000 | 删除，改为引用 |
| `config/llm/model-document.ts:70/188/268/290/318` | 5 处字面量 8192 | 引用常量 |
| `config/llm/apply-active-model-config.ts:41` | 私有的 128_000 | 删除，改为引用 |
| `services/llm-model/tokenCounting.ts:10` | token 计数的 context 兜底 128_000 | 引用常量，避免配置用 300000 而计数路径仍是 128000 |
| `adapters/ui-inprocess/model-client-pool.ts:66` | 注入 client 时把 `?? 128_000` 写进条目的 `contextWindowTokens` | 没有值就不写；否则会凭空造出用户覆盖 |
| `config/llm/writer.ts:375/512/557` | 创建、connect、清空时把默认 context 写进条目 | 不再写入，留空即自动 |
| `config/llm/writer.ts:569-573` | connect 保存时把 `?? DEFAULT_MAX_OUTPUT_TOKENS` 写进 `entry.maxOutputTokens`，这正是 D1 所说的 8192 来源 | 只在用户给出值时写入 |
| `config/llm/apply-active-model-config.ts:195/299/381` | connect 时把检测值或默认值作为 `contextWindowTokens` 传给 writer，落盘后成为覆盖 | 只传用户覆盖，见 §4.3 |
| `config/llm/model-document.ts:226/234` | 旧顶层格式归一化时，缺少 context 就补默认值 | 旧文档没有 context 时不补，既无覆盖也无检测值 |
| Web `dev/mock-settings.ts:350` | mock 服务端创建时补 128_000 | 按新语义不写覆盖，effective 为 300000；归 Pi 负责 |

其他 Web mock 和 test-support 里的 128000 只是示例数据，不必修改。`services/llm-model/modelProfiles.ts:89` 给空 model id 的兜底 profile 用的是 4096 context，配上 32768 输出后输入预算为 0；这条路径只在 model id 为空时出现，不是真实配置，实施时确认没有真实入口会走到它即可。

完成条件：在上述包的非测试源码中，不再出现作为默认值的 `8192`、`128000`（含 `_` 分隔写法）；作为模型限额的 `32768` 和 `300000` 只出现在 `modelProfiles.ts`。与模型限额无关的同值字面量不算，目前已知 `mcp/integration/dynamic-tool-menu.ts:25` 和 `adapters/ui-state/tool-result-details.ts:21` 两处。这是一次性验收检查，不另加 lint 规则。

S2 的新运行准备边界还包括 `adapters/ui-inprocess.ts` 中 resolveRunModel 和直接 createRunModel 的提交路径，以及 `adapters/ui-runtime/run-model.ts`。先完成有效数字校验（含 `tokenBudgetIssue`），再捕获运行快照；不能只修一条 UI 提交路径。子代理继承父run已确认的快照，不因这些配置重验逻辑额外换模型。

实施时同步 `docs/config/llm/data-model.md`、`architecture.md`、`dfd-interface.md`、`test.md`，以及涉及旧 fallback/探测说明的 `docs/ohbaby-web/test.md` 和当前 Settings 交互文档。历史验收记录不重写成新行为。

## 10. 保留风险与本轮不做

- 300000 可能高于某个未知模型的真实窗口；沿用现有上下文超限处理，不能宣传为已验证容量。用户可以手动覆盖。
- 32768 可能超过旧模型支持的输出；保留明确错误，不构造新的自动 cap 调整规则。
- metadata/主动验证也不能证明网关在每个请求都执行了对应推理强度；显示基于当前可获得的证据。
- 不新增定时刷新、通用供应商注册框架、公共目录依赖或动态 effort 预算。
- 输出截断后的接续机制保留为后续议题，仍需独立的运行时状态和工具安全设计；不因本轮分 Stage 新开 improve-2。

### 默认值静态检查的测试边界

§9.1 的单一来源要求针对生产请求与配置解析。Web 开发 mock 中的 `MOCK_DEFAULT_CONTEXT` / `MOCK_DEFAULT_MAX_OUTPUT` 是测试替身，允许保留，不要求浏览器包导入 agent 的运行模块。测试 fixture 的显式数值与旧 8192 迁移常量同样不属于散落生产默认值。
