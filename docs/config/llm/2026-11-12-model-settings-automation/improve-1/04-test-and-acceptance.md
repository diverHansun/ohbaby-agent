# 测试与验收标准

这是后续实施的验收契约，不是本次已经完成的验证清单。“覆盖规则”列对应 02 §0 的规则编号。当前只有调查、既有测试基线与真实参数兼容结果，见 01 和 02。

## 1. 分层与测试边界

沿用仓库现有 Vitest、`.unit.test.ts`、`.integration.test.ts`、contract 和 smoke 的分类；本次不另建全项目测试规则。纯解析用单测，配置落盘与异步写回用临时目录集成测试，协议字段与 SDK 形状用契约测试，真实模型和页面闭环用显式 smoke。

用可控 deferred Promise 和假 HTTP 边界制造竞态，不用固定 sleep 猜时序。配置测试必须使用隔离的 model/env 文件，不能更改真实用户模型库。真实请求仅记录脱敏参数、状态、token usage 和必要错误信息。

## 2. 必须覆盖的行为

| ID | 场景与断言 | 覆盖规则 | 类型 | Stage |
| --- | --- | --- | --- | --- |
| T01 | 新模型两个数字省略：存储无覆盖，Web 数值投影空，runtime 为 32768/300000 | R2、R3、R8 | unit + integration | S1 |
| T02 | 不同 effort 下普通 output 仍为 32768；用户显式 65536 保留 | R1 | unit + protocol | S1 |
| T03 | Chat/Responses/Anthropic 请求分别携带正确输出字段；不得发送 null/undefined，不能把新默认写成模型硬上限 | R1 | protocol | S1 |
| T04 | context 覆盖 > 检测 > fallback；检测只更新检测字段 | R2、R3 | unit + integration | S1/S2 |
| T05 | Patch 省略不改、null 清空、正整数设置；零/负数/小数/空字符串失败；Create 传 null 失败；重启后清空仍有效 | R7 | contract + integration | S1 |
| T06 | 旧条目 context（128000 或其他值）迁移为检测值，覆盖为空、有效值不变；max output 恰好 8192 的删除并解析为 32768，其他值保留；迁移只在 `schemaVersion` 属性缺失时执行，数值 2 只归一化，其他值拒绝且不落盘；先展开旧结构再迁移数字，纯顶层 llmParams.maxTokens=8192 不得后补回覆盖，也不能按旧预算提前丢弃偏好；落盘后写入版本号，迁移后用户再填 8192 不被删除；删除 backups 目录或把 model.json 拷到别处后不会重复迁移；只读不写时每次读取结果一致；context 很小的旧条目迁移后出现 tokenBudgetIssue 而不是读取失败；无 activeProfileId 的旧顶层格式（含 models 数组）迁移；已有 activeProfileId 的混合格式中，顶层 4000 不再被空条目继承，空条目用 32768，显式 5000 保留；清空后不回灌 | R19 | integration | S1 |
| T07 | 主代理与子代理使用同一解析输出值；已运行快照不因后台探测被替换 | R5 | integration | S1/S4 |
| T08 | 标题、摘要、probe 的显式单次限制保留；普通默认不覆盖它们 | R5 | unit + integration | S1 |
| T09 | 新模型 Save 成功后，无手动点击即可 metadata + 必要时主动 reasoning probe；网络不持有配置锁 | R11、R12 | integration | S2 |
| T10 | 已有同路由可信能力（含持久化 model-metadata/active-probe）在 Save 和设为默认时不重复付费请求，Detect again 才强制重验自动结果；unknown 下有脏字段的真实 Save 能重试；无改动 Save 仍禁用、Detect again 可重试；明确重探触发时取消旧任务，每个条目同一时刻最多一个在途任务；普通数值/label 编辑不重启在途任务，包括 context 已 unknown 而 reasoning 仍 detecting 的中间状态 | R11、R13 | integration + component | S2/S3 |
| T11 | metadata 无字段/404 与 reasoning 主动发现独立；模型名模糊子串命中不算容量证据；认证失败/429 不继续批量探测 | R15、R16 | integration | S2 |
| T12 | Chat 端点只发 `reasoning_effort`，不发 `reasoning` 对象；对照返回 2xx 时只用 1 个请求就返回 unknown；探测得到的 wire 与正式请求序列化一致，关闭推理用同一 wire 的写法 | R16 | unit + integration | S2 |
| T13 | 对照通过后各档位与关闭请求并发发出，总期限 60 秒，最多 8 个 POST；只有 400/422 记为不支持，验证中遇到 2xx 和 400/422 以外的任何结果时整体为 unknown 并记录原因；所有档位都返回 400（工具与 reasoning 不兼容）时为 unknown；每个请求带一个无参 `noop` 工具但不执行；metadata 缺字段后主动阶段出现 429/超时，终态应报告主动原因；302 带 Location 也应 unknown 且不请求跳转目标；用可控 HTTP fixture 断言 | R16 | protocol + integration | S2 |
| T14 | 手动覆盖在探测前、探测中、探测后均不被覆盖；同数值显式输入也算覆盖；修改数值不丢失在途 reasoning 终态 | R3、R9 | integration | S1/S2/S3 |
| T15 | 经 API 的 A→B→A、换 key、换协议、删除条目时，旧回包不能写回；修改 apiKeyEnv/promptCache 按只换 key 处理；运行、Settings/composer、discovery 已有能力判断与偏好校验均过滤掉 routeKey 缺失或不一致的检测 context 与自动 reasoning 能力；修改 provider/model/协议/baseUrl 后，检测到的 context 与自动 reasoning 一起清除并重新发现；只换 key 时 context 保留、reasoning 重新探测；手改 model.json 使 `detectedRouteKey` 与当前路由不一致时，检测结果视为不存在 | R4、R13 | integration | S2 |
| T16 | 同一路由重新探测失败时保留旧值，状态仍为 identified，reason 带失败原因；SDK/OpenAPI/视图不再输出 stale，CLI footer 不因此显示 unknown；没有旧值时为 unknown；重启后 reason 清空；换路由后不沿用旧检测结果 | R14 | integration | S2 |
| T17 | Save 返回而 deferred HTTP 仍挂起时，Settings/composer 已观察到 detecting；阶段变更及成功/未知/异常/超时都通知；旧任务不能终止新任务；重启无永久 detecting | R13、R14 | integration | S2 |
| T18 | Settings 与 composer 状态一致；context 成功/reasoning 失败以及反向组合均正确 | R14 | integration | S2/S3 |
| T19 | 前端只改 label 不把只读 detected context 提示提交为 override；后台推送不修改输入值/脏字段/打开基线 | R8、R9、R18 | component + integration | S3 |
| T20 | 清空 Max output 后重开仍空；清空 context 后输入为空、旁边显示自动检测值或未知，不回填 fallback | R8、R18 | component + browser | S3 |
| T21 | 配置标签统一 Reasoning Effort，探测沿用动效且必结束；保留 Detect again | R18 | component + browser | S3 |
| T22 | 配置写入失败不启动有效探测；credential+model 事务失败维持原有回滚保护 | R12 | integration | S1/S2 |
| T23 | context <= output + 余量时保存/读取仍成功，视图带 tokenBudgetIssue，新运行拒绝；后台从300000探得16384也保留identified证据并标问题；其他模型不受阻，修正后恢复 | R6 | unit + integration | S1/S2 |
| T24 | connect/TUI current-model只预填覆盖；用户从已填清空时发送null而非省略，HTTP/OpenAPI接受清空；maxOutputTokens优先于maxTokens旧别名；默认选择和无鉴权可用，无自动值回灌 | R10 | contract + integration | S1/S2/S4 |
| T25 | 迁移后的旧自动 reasoning 证据带上当前路由，按 §6.4 的正式请求兼容范围使用；Anthropic adaptive minimal 的清理和提示按 T32；没有有效能力且处于探测中或未识别时，新 run 不等待，按 service-default 发送且不带 effort，用户偏好保留；已有同路由可信能力重探期间仍按旧能力发送，失败仍 identified+reason；探测成功后下一个 run 按原偏好发送；仅在没有有效能力时 composer 与 Settings 不把已选 effort 显示为生效 | R17、R18、R19 | integration + component | S1/S2/S3 |
| T26 | 版本属性缺失的文档首次落盘前备份，旧模型库与旧顶层格式都备份；版本 2 的普通保存和探测写回不再备份；不支持的版本不备份覆写；`normalizeModelDocument` 保留 `schemaVersion`；回滚恢复备份可读 | R19 | integration | S1 |
| T27 | 凭证原文不进入 settings、事件、日志或错误；model.json 中不出现任何凭证派生值；缺 key 不发请求；tokenCounting 默认与运行配置一致 | R4、R20、R21 | contract + integration | S1/S2 |
| T28 | 经 API 或直接手改 model.json 换路由后，必须先清除两类失效自动证据再更新共用 detectedRouteKey；reasoning 成功、context 失败时，写入 reasoning 与新的 `detectedRouteKey`，context 保持未知并解析为 300000；反向情况同理；重启后读取结果一致 | R4、R13 | integration | S2 |
| T29 | 启动、读取 Settings 列表、准备新 run 均不发起付费探测；`detectedRouteKey` 不一致的条目保持 unknown，直到 Save、Detect again 或设为默认时才重新发现 | R11 | integration | S2 |
| T30 | 默认值单一来源：按 02 §9.1 的 grep 检查通过；没有覆盖的条目能通过 `validateEntry`；connect 不把检测值或默认值写进覆盖字段；注入 client 未提供 context 时，条目中不出现 `contextWindowTokens`；创建、connect、清空都不把默认值写进覆盖字段；Web mock 创建行为与后端一致 | R20 | static check + integration | S1/S3 |
| T31 | Responses probe 识别 max → 保存自动能力 → 重新读取 → 用户选择 max → 正式 provider 请求包含 reasoning.effort=max；普通输出仍为 32768；内置 Zenmux luna Responses 和迁移后的旧自动 max 证据及偏好也能发送；当前能力不支持 max 时仍拒绝选择，任意未知字符串仍被拒绝；自动探测不得替用户选 max | R1、R16、R19 | protocol + integration | S2/S4 |
| T32 | Anthropic adaptive 不探 minimal；metadata/内置/显式/旧自动能力有效投影均不发布不可发送档位，合法档位与来源优先级保留；只有 minimal 的证据过滤后为 unknown 且配置可读；无版本与版本 2 的不兼容模型默认偏好均清理，读取不写盘、下次成功保存后重启不恢复；新显式 minimal 设置校验失败；通知码随 Settings/current-model 投影送达，Web/TUI 实际显示清理提示，后续 probe 不覆盖提示，用户新 reasoning 选择成功保存后清除；不误清合法 effortMap 或 budget/binary 配置，不修改在途 run；会话/单次显式偏好在能力已知时校验，能力过滤为空后仍按 D3 使用 service-default 且不发送 minimal，UI 显示未生效；真实请求不再包含 output_config.effort=minimal，不自动映射为 low | R16、R18、R19 | unit + integration + contract + component/browser | S1/S2/S3/S4 |
| T33 | Composer 选中已知 tokenBudgetIssue 的模型时，点击、Enter、命令提交和重发均不发请求，草稿保留；显示 Check settings 并打开设置；切到兼容模型或修正配置后恢复；运行中 Stop 不受影响 | R6、R18、D11 | component + browser | S3 |
| T34 | TUI 设默认模型启动探测后，通过原有事件推送 context/reasoning 中间态与终态，current-model 可观察终态，不停留在 detecting | R11、R14 | integration | S4 |
| T35 | connect 只改数值时不重启同路由在途 metadata/active probe（包含两个并发保存）；已知能力复用；连接变化取消旧任务并重探，unknown 的真实保存可重试 | R11、R13 | integration | S2/S4 |
| T36 | 独立 draft probe 引用了不存在的 API key 时不发请求，返回 missing-credential 并保留用户 context 或默认兜底；未指定凭证变量的 keyless 端点仍可探测 | R20、R21、T27 | unit | S2/S4 |
| T37 | 同路由重复刷新取消旧任务时，即使旧 context/reasoning 写回已在配置锁中排队，也不得落盘、清理偏好或产生通知；新任务的失败终态仍可见 | R13、T17 | integration | S2 |

## 3. 测试位置与执行方式

优先扩展现有测试接缝：

- `packages/ohbaby-agent/src/config/llm/__tests__/` 中的 model-entry-discovery、model-entry-probe、writer、apply-active-model-config、config-commit 测试。
- `packages/ohbaby-llm/src/providers/` 和 client 的现有请求序列化/预算测试。
- `tests/integration/adapters/ui-runtime/` 中 Settings 与运行模型衔接测试，以及现有主子代理测试。
- `apps/ohbaby-web/src/ui/settings/` 的表单和编辑器测试，settings runtime 订阅测试。

实施阶段先跑修改相关的精确测试文件，再运行：

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run build
```

必要时依据仓库当时的测试配置拆分运行，记录真实命令、退出码、与本次改动无关的已有失败；不能把未运行的检查写成通过。

已有 `model-entry-discovery.integration.test.ts` 对“Save 不 POST”的断言需要按新契约修改。`protocol-terminal.integration.test.ts` 对 length 终止的断言继续保留，因为运行时接续不在本方案。

## 4. 真实请求与页面验收

规划阶段已完成：测试清单 18 路由接受显式 32768 的短请求，证据在 `.ohbaby/max-output-investigation/explicit-32768-results.json`。全部附带工具定义，但没有执行工具，也没有走修改后的产品或流式链路。

修复后的 probe 要对 `tests/models-4-tests.md` 的 18 条路由重新实测：除 Zenmux deepseek Responses 应保持 unknown 外，其余 17 条应识别出能力，智谱 Chat 应为 low、high、max 且不可关闭，gpt-6.1-sol 不再超时。结果与 00 §6 D6 的推算不一致时，要逐条说明原因；Anthropic 验收按 D10 核对正式可用档位，不再把 minimal 算作可用结果。

实施后必须覆盖三种协议的产品实际流式请求，至少包含一个需要主动 reasoning 探测的自定义路由和一个 metadata 无 context 的路由。验证保存后自动探测、页面刷新、主子实际参数与工具闭环；不能仅复用规划期 raw fetch 结果作为完成证据。

页面最小流程：新建隔离模型配置 → 只填连接信息 Save → 看探测动效 → 自动显示结果或保持未知空值 → 手填覆盖 → 手动重新探测确认不覆盖 → 清空恢复自动 → 关闭重开 → 发起真实工具任务 → 核对运行参数与结束状态。

另用可控 HTTP fixture 覆盖超时、无 metadata、A→B→A、保存后立即编辑等确定性路径。真实模型失败时区分产品缺陷、认证/额度、供应商暂时错误。

测试产生的临时模型与会话使用独立标识，测试后恢复原有默认模型并清理临时配置；不修改用户已有 8192 值来制造通过。

## 5. 发布验收条件

| 项 | 必须满足 |
| --- | --- |
| 用户体验 | 两个数字都可不填；未知 context 不显示 300000；自动 effort 不依赖 Detect again |
| 数据一致性 | 覆盖、检测、有效值含义稳定，保存与重启不会改变意图 |
| 异步可靠性 | 终态可见，旧任务不覆盖新任务，失败不撤销保存 |
| 协议兼容 | 三协议实际使用新默认，effort 选择不改变普通输出默认 |
| 权限与保密 | probe 不执行工具、不暴露凭证、不更改无关模型或默认选择 |
| 协作交付 | Pi 前端 diff 由主代理复核；类型、接口与真实页面闭环一致 |
| 结论边界 | 不能宣称解决 length 自动接续；不能把 300000 称为模型真实容量 |

## 6. 对抗性审查重点

1. 自动检测值恰好等于用户输入值：若只比较数字会丢覆盖意图；用脏字段与独立存储验证。
2. 连接改动后旧请求成功：若只比较 model 名称会污染新配置；校验 routeKey 和 generation。
3. null 清空后重启：旧兼容投影可能补回 8192；必须走真实序列化、落盘、重新加载路径验证。
4. context 成功而 effort 超时：如果共用一个成功标记，UI 会假装全部完成；验证两类状态及终态事件。
5. 验证档位时遇到 429、5xx 或网络抖动：若记为“不支持”，档位列表会悄悄变短；断言这类错误让整次结果变为 unknown，而不是返回残缺列表。

残余风险：供应商可能接受但忽略 reasoning 参数，未知模型真实 context 可能低于 300000，模型能力可能在保存后变化。本方案降低误判并给出明确状态，不承诺彻底消除这些外部不确定性。
