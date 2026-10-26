# 3. 参考项目借鉴

> 2026-10-25 由子代理阅读源码整理，主代理核对后写入。行号是调研时的快照，各项目根目录都在 `code-cli/` 下。

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|---|---|---|
| opencode | `code-cli/opencode`（v2：`packages/core`、`schema`、`tui`） | 会话模型字段、运行时解析、TUI 切换、variant、子代理、压缩 |
| pi | `code-cli/pi`（`packages/coding-agent`） | 会话日志中的模型记录、切换是否持久化、thinking level、模型不可用时的回退 |
| kimi-code | `code-cli/kimi-code`（`packages/agent-core-v2`、`apps/kimi-code`） | 按 agent 绑定模型、切换模式、子代理继承、切换前压缩 |
| ZCode | `code-cli/ZCode`（`packages/provider*`、`apps/zcode-cli`、`packages/ui`） | 按提交冻结模型、会话条目、桌面端设置页 |

## 3.2 四家做法对比

| 问题 | opencode | pi | kimi-code | ZCode |
|---|---|---|---|---|
| 会话模型存在哪 | 会话表的 `model` 字段，`{providerID, id, variant?}`（`schema/src/session.ts:41`），另写一条 `model-switched` 历史消息 | 会话 JSONL 里追加 `model_change` 条目，当前模型取分支上最后一条（`src/core/session-manager.ts:69-78`） | agent 的 `wire.jsonl` 事件 `profile.bind`、`config.update`（`agent/profile/profileOps.ts:24-75`） | 会话条目 `SESSION_ENTRY_MODEL_SELECTION`，每次提交的 intent 里也带一份（`turn-model.ts:190-217`） |
| 没选过时用什么 | 每轮现取全局默认（`core/src/session/runner/model.ts:79-94`） | 新会话取设置里的默认 | 绑定时取 `defaultModel` 后固定 | 新会话取工作区最近一次选择，再退到默认 |
| 会话里切换是否改全局 | 不改默认，只更新“最近使用”列表（`tui/src/model-preference.ts`） | 默认不改；选择器里另有“设为默认”（`interactive-mode.ts:5317-5343`） | 回车改全局，Alt+S 只改会话（`model-switch.ts:72`） | 桌面端不改，CLI 的 `/model` 会改 |
| reasoning 存哪 | 跟模型一起存在会话上（`variant`），另有每个模型的全局偏好 | 会话上的 `thinking_level_change`；`modelThinkingLevels` 记每个模型的默认档位（`settings-manager.ts:771-789`） | 会话上；校验模型的 `supportEfforts` | 和模型打包在 `ModelSelection` 里 |
| 切换后档位不支持 | 按模型 variant 重新叠加 | 按新模型能力收窄（`sdk.ts:252-276`） | 校验后拒绝 | UI 清掉不支持的档位（`composerRecent.ts:184-193`） |
| 存的模型不可用 | 报 `ModelUnavailableError`，不回退 | 回退到默认或第一个可用模型，提示“Could not restore model”（`sdk.ts:224-247`） | 报“未配置”错误 | 不绑定，记警告，UI 标为无效 |
| 子代理 | 显式覆盖 > agent 模型 > 父会话模型（`core/src/tool/plugin/subagent.ts:170-189`） | 继承父会话 | 默认继承调用方 | 覆盖 > profile > 父会话 |
| 切到窗口更小的模型 | 按当前模型的 `limit` 算阈值（`compaction.ts:216`） | 下一轮回答前超阈值就先压缩（`agent-session.ts:767-781`） | 弹窗：继续、新开会话、先压缩再切 | 每轮按当前模型窗口算 |
| 运行中切换 | 提交时才写入 | 写入日志，下一轮用 | 回复中禁止切换 | 只影响新建的模型实例，正在跑的循环不变 |

## 3.3 ohbaby 的取舍

| 做法 | 来源 | 取舍 | 说明 |
|---|---|---|---|
| 模型存在会话上，可变字段 | opencode | **采用** | ohbaby 的会话已经有 `reasoning` 字段，照同样方式加 `modelEntryId`，不引入事件日志 |
| 没选过就每轮现取默认 | opencode | **采用**（D1） | 会话上不写 `modelEntryId` 即表示跟随 |
| 会话里切换不改全局默认 | opencode、pi、ZCode 桌面端 | **采用**（D2） | 全局默认只在 Settings 里改 |
| 模型不可用时回退到默认并提示 | pi | **调整后采用**（D10） | 回退方式是清掉会话的 `modelEntryId`，让会话回到跟随默认，而不是写入默认模型的 id |
| 每个模型有自己的默认推理档位 | pi、kimi | **采用**（D12） | 挂在 `models[]` 条目上，替代全局 `llmParams.reasoning` |
| 切换后清掉不支持的档位 | ZCode、pi | **采用**（D14） | 回到新模型的默认档位 |
| 子代理继承父会话模型 | 四家共识 | **采用**（D14） | ohbaby 的 Agent 配置不允许写模型，所以只有“继承”这一条 |
| 每轮按当前模型窗口计算压缩阈值 | opencode、ZCode | **采用**（D14） | 依赖现有自动压缩，不加切换前压缩 |
| 提交时冻结模型 | ZCode | **采用一半** | 排队消息记下提交时的模型（和 reasoning 现在的做法一样），但不给单条消息单独选模型 |

## 3.3b 文档审查时补充的实施经验

| 做法 | 来源 | 取舍 | 说明 |
|---|---|---|---|
| 客户端按配置内容缓存，不按 id 加版本号 | opencode `core/src/aisdk.ts:318-361`，键包含服务商、模型、设置、请求头、窗口等 | **采用**（02 P5） | 条目一改就自动换客户端，没有“比对版本再读文件”的间隙 |
| 每轮解析一次模型，作为参数交给标题生成 | opencode `session/title.ts:57` | **采用**（02 1d） | ohbaby 的标题在运行开始前排期，所以解析点放在 `submitPromptInternal` |
| 上下文溢出后压缩并重试 | opencode `session/runner/llm.ts:262` | **已有，作为兜底** | ohbaby 已有溢出检测与重试，切到小窗口时估算偏差靠它恢复 |
| 切换模型时检查 key | pi `agent-session.ts:2541-2545` | **不采用** | ohbaby 允许不配 key 的模型（本地或免 key 服务），缺 key 的问题在请求时报出 |
| 切换时使用新模型自己的思考档位 | pi `_getThinkingLevelForModelSwitch` | **采用**（02 P10、P10b） | 不兼容时回到条目默认档位 |

## 3.4 明确不借鉴

- **opencode 的“最近使用”列表**：D1 已经定了没选过就跟随默认，不需要再记一份最近使用来决定新会话的模型。
- **pi 的分支化模型记录**：ohbaby 没有会话树分支，用一个字段就够。
- **kimi 的切换前压缩弹窗**：多一个交互分支，收益不大；现有自动压缩会在下一轮处理窗口变小的情况。
- **ZCode 的单条消息选模型**：会话级已经满足需求，单条粒度会让排队和重发变复杂。
- **opencode 模型不可用直接报错**：用户删一个模型就让一批老会话全部报错，体验太差，改为回退。

## 3.5 对 02 的影响

- 数据结构：`Session.modelEntryId?` 与 `PromptSubmissionRecord.modelEntryId?`，写法对齐 `reasoning`（opencode、ZCode）。
- 解析规则：提交时按“提交选项 → 会话”记下选择或“跟随默认”；执行时按记录，留空用当时的默认，没有默认就拒绝执行；被删时回退并清字段（opencode 的解析顺序 + pi 的回退）。
- 生成参数：每个模型条目上的 `maxOutputTokens` 和默认 reasoning（pi 的 `modelThinkingLevels`、kimi 的 `defaultEffort`）。
- 运行时：每轮按模型取客户端；opencode 和 ZCode 都是“解析出本轮模型再建请求”，没有“每个模型一套运行时”的做法。
