# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 4。测试文件沿用仓库现有约定：与源码放在同一目录，或放进同目录的 `__tests__/`（例如 `agent/config/llm/__tests__/`），命名为 `*.unit.test.ts(x)`、`*.integration.test.ts(x)`、`*.contract.test.ts`，分别用 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | `model.json` 读写与校验、TUI 子视图的按键和显示 |
| integration | 设置与删除联动、子代理用设置的模型和档位、跟随会话时行为不变、设置不可用时的回退与提示、生效时机 |
| contract | 新 HTTP 路由、新 JSON-RPC 命令、`UiSettingsModels.subagent` 字段、`/models` 数据 |
| 浏览器走查 | Stage 3 的 Models 页（mock 场景和真实 daemon 各走一遍） |
| 手工 | Stage 4 的 TUI 在真实终端里走一遍 |

**假客户端要能分出条目。** 用 `llmClient` 选项注入时，客户端池对所有条目返回同一个客户端（01 §1.8），断言不了请求发往哪个条目。T7 至 T13 要用 `createLLMClient` 工厂，按条目返回不同的假客户端，并记录每次请求带的档位参数。

**至少一条测试走真实路径。** T7 要经过 `ui-inprocess`，用真实的临时 `model.json` 和客户端池，而不是只给 `SessionSubagentHost` 注入假的解析函数。只测 Host 分支的单元测试可以另写，但不能代替它。

## 4.2 关键场景

### Stage 1：模型库与接口

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | `subagentModel` 读写往返 | unit | 写入后再读，`entryId` 和 `reasoning` 原样保留；没有这个字段的旧文件读出来是跟随会话；`schemaVersion` 仍是 2，读取不写盘；设好子代理模型后修改另一个条目，设置仍在 |
| T2 | 非法值 | unit | `entryId` 为空串或不是字符串、`reasoning` 不合法、指向不存在的条目：整个 `subagentModel` 被丢掉，读取不抛错，其他字段照常读出 |
| T3 | 设置子代理模型 | integration | 完整条目可以设；不完整条目报 `MODEL_CONFIG_INCOMPLETE`；不存在报 `MODEL_NOT_FOUND`；`id: null` 删除字段；这个条目不支持的档位被拒绝；返回的 `subagent` 视图正确；设置成功后启动了后台能力探测 |
| T4 | 删除联动 | integration | 删除被引用的条目，`subagentModel` 一起被删，`deleteEntries` 的返回值里 `subagent` 已经是 `null`；删除其他条目不影响它；按 provider 批量删除时同样生效；删除同时是 Default 的条目时，Default 顺延和子代理设置清除都正确 |
| T5 | 接口契约 | contract | `POST /v1/settings/models/subagent` 的请求体校验和返回结构；`GET /v1/settings/models` 带 `subagent`；OpenAPI 和 `create-app.unit.test.ts` 的路由清单包含新路由 |
| T6 | TUI 数据契约 | contract | JSON-RPC 的 `selectSubagentModel` 透传；`/models` 行数据带 `subagent` 标记、顶层带 `subagent` 当前设置，且经过 `sanitizeModelSummary` 后仍在；Web 端 `UiBackendClient` 的实现也有这个方法 |

### Stage 2：子代理运行时

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T7 | 设了子代理模型 | integration（走 `ui-inprocess`） | 父会话用 X，子代理设置为 Y：子代理请求发往 Y，子代理的 `runModel.entryId` 是 Y；父会话请求仍发往 X，父会话的 `modelEntryId` 不变（D7）；换一个角色（例如 explore）起子代理，同样发往 Y（D3） |
| T8 | 跟随会话 | integration | 没有设置时，子代理请求发往父会话这一轮的模型，档位与父会话相同；session-model 的 T11 不改断言照样通过 |
| T9 | 档位跟着设置走 | integration | 父会话用 `high`，Y 默认关闭思考。子代理选择 Y 和 `low` 后，请求使用 `low`。设置为 Y 并省略档位时，用 Y 的默认档位 |
| T10 | send | integration | 设了子代理模型时，给空闲的子代理 send，新执行用设置的模型和档位，和 spawn 一样；跟随会话时，给空闲的子代理 send 继承父会话的模型和档位，和改造前一致。给正在运行的子代理 send：消息并入当前执行，模型和档位不变 |
| T11 | 设置的条目不完整 | integration | 子代理退回继承父会话；发出 key 为 `model:subagent-unavailable` 的 warning；主会话这一轮不报错 |
| T11a | 运行中读不到设置 | integration | 父会话开始后模型库暂时无法读取，子代理仍继承父会话已经生效的模型和档位 |
| T12 | 生效时机 | integration | 运行中改设置并发消息，当前执行用旧模型。空闲后发消息，新执行用新模型。跨协议继续时仍能读到历史文本和已完成的工具结果 |
| T12a | 并发删除 | integration | 子代理已读取模型配置，客户端还在创建时可删除该条目。已取到配置的执行使用旧模型，后续执行继承父会话这一轮 |
| T13 | 运行时档位不兼容 | integration | 设置的档位在执行时已不被模型支持（例如手改文件或重新探测后能力变了）：子代理请求不报错，用模型默认档位；发出 key 为 `model:subagent-reasoning-fallback` 的 warning |

### Stage 3：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T14 | Default 说明 | 浏览器走查 | Models 标题下有一行说明，文案与 02 P14 一致 |
| T15 | 设置子代理模型 | 浏览器走查 + integration | 默认显示 “Follow chat”；菜单只列配置完整的模型；选模型后能选档位，第一项是 “Model default”；保存后这一行显示 “模型 · 档位”；没有可选档位的模型不显示档位选项 |
| T16 | 恢复跟随会话 | 浏览器走查 | 选 “Follow chat” 后显示恢复，`GET /v1/settings/models` 的 `subagent` 为 `null` |
| T17 | 删除被引用的模型 | 浏览器走查 | 删单个模型和删整个 provider 两个确认框里，都有 “Subagents will follow the chat's model.”；删除后这一行显示 “Follow chat” |
| T17a | 引用的条目不完整 | integration | 手改 `model.json` 让被引用的条目不完整：这一行显示 “Needs setup”，点击打开这个条目的编辑器 |

### Stage 4：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T18 | 主视图显示 | unit（新建 `models-panel.unit.test.tsx`） | 有 “Subagent model” 一行；子代理用的那一行带 ` · subagent`；有 Default 说明；按键提示里有 `s subagent model`；引用的条目不完整时显示 “Needs setup”；面板高度没有被截断 |
| T19 | 按 `s` 设置 | unit（同上） | 第一步能选 “Follow chat” 或某个模型；有档位的模型进入第二步，第一项是 “Model default”；没有档位的模型直接保存；在子视图里按 Esc 逐级返回，不会关掉整个面板 |
| T20 | 与 Web 一致 | 手工 | TUI 里改的设置，在 Web Settings 里刷新后能看到，反过来也一样 |

## 4.3 集成边界

- `model.json` 是 Web、TUI 和运行时共享的唯一数据源。写入都经过 `coordinateModelConfig` 串行化，T3、T4 要在同一个文件上验证。
- Web 走 HTTP 路由，TUI 走 JSON-RPC 命令，两边最终调用同一个 `selectSubagentModel`。T5、T6 分别验证两条路。
- `SessionSubagentHost` 通过可选的 `resolveSubagentSetting` 拿设置，拿不到时走原来的两个回调。T8 保证原来那条路没变。

## 4.4 回归清单

- 跟随会话（默认状态）时，子代理的模型和档位与改造前完全一致（T8、T10）。
- 主会话的模型解析、Default 的语义、会话模型被删后的回退都不变（session-model 的 T4、T5 照样通过）。
- 设默认、删除模型、按 provider 删除的现有测试照样通过。
- side chat 的模型不受子代理设置影响。
- 标题生成和主会话压缩用的模型不受子代理设置影响。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|---|---|---|
| 测试 | T1 至 T13、T15 的 integration 部分、T17a、T18、T19 自动化通过；`pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 全绿 | 跑命令 |
| 类型与格式 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 通过 | 跑命令 |
| Web | T14 至 T17 在 mock 和真实 daemon 下各走一遍，附截图 | 浏览器走查 |
| TUI | T18 至 T20 在真实终端里走一遍 | 终端操作 |
| 真实模型 | 用 `tests/models-4-tests.md` 里两个不同的模型，父会话用一个，子代理设成另一个，跑一个会起子代理的任务，确认两边的请求各自发往对应模型 | 手工 smoke，看诊断日志或用量 |
| 文档 | 02 §2.5.5 列出的权威文档已同步 | 人工检查 |

## 4.6 对抗性审查要点

| 攻击面 | 可能出的错 | 防御 | 残余风险 |
|---|---|---|---|
| 模型和档位错配 | 子代理换了模型，却带着父会话的档位，请求报错 | 02 P4 一次给出模型和档位；P9 运行时过滤；T9、T13 | 无 |
| 条目缺失时悄悄退回 Default | 解析时用了 `resolveModelEntry`，条目不在时它会退回 Default，而不是继承父会话 | 02 Stage 2 用 `models.find` 找条目；T2 的变体：手改文件让 `entryId` 指向不存在的条目，子代理继承父会话 | 无 |
| `normalizeModelDocument` 丢字段 | 任何一次写入（比如改别的模型）都会把设置冲掉 | T1 | 旧版本写入会丢掉设置（02 §2.5.2），可以接受 |
| 跟随会话的行为被改掉 | 改造时动了原来的两个回调或 send 路径 | 02 P4 保留旧回调、P6 不另加 send 判断；T8、T10 | 无 |
| 假客户端分不出条目 | 测试全绿，但其实所有请求都发往同一个模型 | 4.1：用 `createLLMClient` 按条目注入；T7 走 `ui-inprocess` | 无 |
| 提示刷屏 | 设置不可用时，每起一个子代理就发一条提示 | 后端每次都发，TUI 按 key 替换只留一条；T11 只断言发出了这个 key 的 warning | Web 不显示后端提示，靠 “Needs setup”（T17a） |
