# 实施与验收记录

日期：2026-11-12。分支：`codex/model-settings-automation-20261112`。基线：`b8d5fc67a0bf61a62a398bcd511b2aef670c4621`。用户在方案审查后授权实施，并在验收后要求按职责拆分本地提交；未推送。

验收结论：本轮范围已完成。子代理复审未留下已知 P1/P2 问题；最终串行执行 test、typecheck、lint、format:check、build 全部退出码 0。保留边界见文末。

## 实际交付

- 普通模型请求默认输出 32768，未知 context 兜底 300000；主代理与子代理共用解析后的配置，显式的标题、摘要和探测请求限制继续保留。
- Context window 与 Max output 都可以不填写。存储字段只表达用户覆盖；PATCH 省略表示保持，null 表示清空。读取、清空、重启不会把默认值填回表单。
- Save 后自动获取 context metadata，并在能力未知时主动探测 Reasoning Effort。已有同路由可信能力时复用，Detect again 强制重验自动证据。启动、读取列表和创建 run 不付费探测。
- 两类探测各自报告 detecting、identified、unknown；失败保留同路由的旧值和失败原因。异步结果通过 routeKey 与现有 generation 检查，旧请求不能写进新连接。
- Responses 的已验证 max 可以进入正式请求。Anthropic adaptive 不发布不可发送的 minimal；清理旧默认偏好并通知用户，合法 effortMap/budget 配置保留。
- Web/TUI 配置标签使用 Reasoning Effort。Web 去掉冗长说明；数值输入允许留空，只接受安全范围内的正整数字符串。非法原输入保留，显示短错误并禁用 Save，不把 `-1` 静默改成 `1`。
- 小 context 与默认输出冲突时配置仍可读取和保存，返回 `tokenBudgetIssue`；新 run 返回 `MODEL_TOKEN_LIMITS_INCOMPATIBLE`，用户修正后恢复。

## 字段与 KISS 检查

| 字段 | 含义与存储位置 |
| --- | --- |
| `contextWindowTokens` / `maxOutputTokens` | 可选用户覆盖，保留已有命名 |
| `detectedContextWindowTokens` | 已识别容量，仅存证据，不存 fallback |
| `detectedRouteKey` | 复用现有 routeKey 格式，绑定自动证据的路由；无凭证指纹 |
| `schemaVersion: 2` | 一次性区分旧混合来源数字与新覆盖语义 |
| `effectiveContextWindowTokens` / `effectiveMaxOutputTokens` | API 投影的最终数值，不重复持久化 |
| `contextDiscovery` / 原有 reasoning discovery | 进程内探测状态，不持久化 detecting |
| `tokenBudgetIssue` / `reasoningNotice` | 由当前配置或清理事件产生的视图信息，不增加配置开关 |

没有引入 stale 字段、凭证摘要、启动恢复队列、新 run 等待能力机制、按 effort 动态调整输出，或泛化的探测框架。网络探测在配置锁外执行。

旧格式仅在缺少版本属性时迁移：context 移到检测值；旧 8192 输出移除覆盖，其他输出值保留。先展开旧顶层结构，再迁移数字，再校验偏好。首次实际落盘前备份；读取不写盘。迁移后用户明确填入 8192 会保留。

## 分工与审查闭环

后端由主代理实施并集成 SDK、HTTP、TUI、协议与测试。Web 主体由 Pi `anthropic/claude-opus-5-5`、`xhigh` 实施；后续精简文案和输入限制两次续跑遇到供应商 429，主代理完成剩余修改与验证，没有更换模型冒充 Pi 产出。

子代理分别审查协议、迁移、异步配置竞争、Web 编辑状态和 mock 一致性。审查中确认并修复：

1. 旧 Anthropic 原始能力在保存时被过滤覆盖，以及 metadata 更新先删偏好导致清理通知丢失，是两处独立问题；分别保留原始证据、把不兼容偏好清理放在通用偏好校验之前。
2. 新 metadata 只有不兼容 minimal 时保持 unknown 却未继续主动发现；修正有效能力判断，让 Save 可以继续完成主动探测。
3. 手改路由后的旧在途任务影响新 Save；以当前 routeKey 匹配在途状态，并补 deferred 竞态测试。
4. 后台清理 effort 后，单独改 label 意外提交 reasoning:null；改为比较用户选择与打开时基线，补红转绿组件测试。
5. Mock 的手动偏好通知清理与预算安全余量必须同后端一致；同步实现及两项先红后绿回归测试。
6. 用户已选择的 effort 被新探测结果移除时，界面显示默认却提交隐藏旧值；改为显示不可用的草稿选项，阻止 Save，选择有效档位或默认后恢复。后台清理未动过的基线仍不产生 reasoning patch。
7. 官方 OpenAI Chat 在非法档位对照被接受时，只返回 unknown，不尝试网关专用的另一种字段格式；补单请求次数断言，与方案一致。

## 自动化验证

所有审查修复完成后，顺序执行 `pnpm test` 退出码 0：**697 文件通过、6 文件跳过；8116 测试通过、17 测试跳过**，耗时 209.65 秒。日志：`/tmp/model-settings-full-test-final2.log`。没有与手动构建并发。较早一轮全仓的 8111 项通过结果已被此轮取代。

已完成的重点验证：

| 验证 | 结果与证据 |
| --- | --- |
| 配置、能力、runtime 重点集 | 30 文件、279 测试通过；`/tmp/model-settings-config-suite3.log` |
| 最后四处旧断言适配 | 246/246 通过；`/tmp/model-settings-four-tests.log` |
| 最终 effort 编辑竞态修复 | refresh 5 + numeric 19 + SettingsDialog 29，共 53/53；包含不可用草稿、默认选择与不误提交旧基线 |
| 官方 OpenAI 探测分支 | reasoning-active-probe 20/20；非法对照被接受时只发一次请求 |
| Mock 后端一致性 | 新增 2 项先红后绿，验证手动 reasoning 清通知与 1024 安全余量 |
| 正整数输入组件 | 19/19 通过，包含两个字段的负数、零、小数、指数、非数字、越界、合法数字与清空 |
| SettingsDialog | 29/29 通过；`/tmp/model-settings-settings-final.log` |
| 顺序 build | CLI 包及 Web 资源构建完成；`/tmp/model-settings-build-final.log` |
| typecheck / lint / format | 类型通过；lint 0 errors（125 warnings）；格式通过；日志分别为 `/tmp/model-settings-typecheck-final3.log`、`/tmp/model-settings-lint-final2.log`、`/tmp/model-settings-format-final2.log` |

第一次全仓回归包含四处需要随新契约调整的旧断言，以及与手动 build 重叠造成的 dist 声明竞争。已修正断言并停止重叠构建，重新顺序验证。另一次后端广测出现单个启动时序超时，针对该组的 177 测试复跑通过；最终全仓结果独立记录。

### 与 04 验收项的对应

| 验收项 | 主要验证入口 |
| --- | --- |
| T01–T06、T26、T30 | model-settings-automation、model-settings、writer、integration 配置测试；SDK request-helpers；模型表单测试 |
| T07–T08、T23、T25 | runtime model-settings-automation、run-model、composition、formal-cache-live-context；真实主子代理请求 |
| T09–T18、T22、T28–T29 | model-entry-discovery、model-entry-probe、model-entry-route-race、profile-route、background-reasoning、reasoning-active-probe；HTTP settings-global |
| T19–T21 | model-editor-refresh、model-numeric-input、SettingsDialog、composer model-refresh；内置浏览器实测 |
| T24、T27 | CLI connect-panel/app contract、SDK/OpenAPI/HTTP、配置序列化与缺凭证请求测试 |
| T31 | responses-max.integration 的探测→保存→选择→实际 SDK 序列化闭环，及 Responses provider 单测 |
| T32 | anthropic-effort-migration、reasoning、TUI effort-panel、SettingsDialog、model-editor-refresh；实际 Anthropic 请求 |

此表标识测试入口，不把所有单测断言宣称为人工页面验证。

## 真实端点与页面验收

真实请求使用 `tests/models-4-tests.md` 中端点及授权的项目 `.env` 凭证。只保留脱敏请求参数与结果，不把密钥写入文档。

- 首轮 18 路由：18 个 metadata GET、139 个主动 POST，单路由最多 8 个 POST；主动请求输出限制 32，携带不执行的 noop 工具。首轮 18 路由均得到 reasoning 证据，10 路由得到 context metadata。
- Zenmux DeepSeek Responses 复验时，非法档位对照从首轮 400 变成 200，因此复验返回 unknown/ignored-reasoning。不能把首轮结果解释成长期稳定支持；保留旧有效结果的逻辑另有测试。
- 三个正式 SDK 流式请求均返回 noop tool_calls：Zhipu Chat high、Zenmux Luna Responses max、Zenmux Sonnet Anthropic high；普通输出均为 32768，Anthropic 未发送 minimal。
- 内置浏览器中运行真实主子代理任务，页面最终显示“主子代理验收通过，答案42”。脱敏请求上限序列为 `[200,32768,32768,32768,32768,32768]`，其中 200 是辅助请求，主子代理均为 32768。

页面使用隔离 OHBABY_HOME、数据库及本地 HTTP fixture；没有改用户实际模型库或会话库。验收结束后已停止该临时服务，并删除隔离目录中的凭证副本。已观察：

1. 新建 Save 后无需点击 Detect，出现探测动效，随后出现 context 131072 和 low/high 选项。
2. 探测过程中编辑 label，结果返回后草稿仍保留。
3. 两个数值手填、保存、重开保留；清空、保存、重开仍空，检测容量作为只读提示显示。
4. 旧 minimal 清理通知显示，手动重探期间不被覆盖。
5. 精简后的页面不显示冗长列表说明；输入 `-1` / `1e3`、`abc` / `-32768` 时原文保留且 Save 禁用；改成 200000 / 32768 后恢复 Save；最终再次清空保存并重开确认。

脱敏原始结果及截图在本地 `.ohbaby/model-settings-implementation/`：`real-probe-results.json`、`real-probe-repeat-results.json`、`real-stream-results.json`、`browser-main-subagent-requests.json`、`browser-main-subagent.jpg`、`browser-numeric-invalid.jpg`、`browser-settings-final.jpg`。该目录被 Git 忽略，不随源码发布。

## 保留边界

提高输出默认值没有解决 `length → failed` 和截断自动接续；这仍是后续独立运行时工作。300000 是预算兜底，不是探测到的真实模型容量。小 context 模型可能需要用户下调 Max output。代理端点可能接受但忽略参数，或在复验中改变行为；unknown 不冒充已支持。

## 提交组织

本轮按依赖顺序拆为四个本地提交，各自包含对应回归测试：

1. `fix(llm): align reasoning capabilities with request serialization`：协议能力投影与正式请求兼容。
2. `feat(config): automate model discovery and optional token limits`：配置存储、迁移、自动探测、runtime、SDK/HTTP 契约，以及配置设计和测试文档。
3. `feat(tui): support optional model limits and reasoning discovery`：终端配置、覆盖清空、状态与通知。
4. `feat(web): streamline model settings and validate token inputs`：Web 设置、编辑竞态、输入校验、mock、前端文档及本验收记录。

以上提交是同一功能的依赖序列；全仓测试和构建结果对应四组整合后的文件状态，不代表分别检出每个中间提交后都完成了独立验收。忽略目录中的真实请求证据、截图和临时脚本不加入 Git。
