# improve-4 开工前调查

2026-10-24。按标准深度调查，只记事实，不给方案。

## 目的与范围

improve-4（设置页）的 [01 现状](../01-current-state.md) 原本基于 `f5f36b9e`，之后又合入了 23 个提交和 improve-3。这次调查按最新代码重新核对前后端现状，并看看参考项目的设置页是怎么做的，作为 improve-4 规划讨论的输入。

- 代码基线：`codex/redesign` 工作区，即 `c6d9be86` 加上未提交的 improve-3 改动。
- 范围内：Web 前端里和设置、模型、`/connect`、输入框控件有关的代码；后端设置接口、错误格式和事件；`code-cli/` 下参考项目的设置页、模型选择、密钥输入、MCP 状态、校验错误。
- 范围外：TUI 的实现细节、improve-1 到 improve-3 已验收的功能、讨论记录（这次没有新的截图或外部讨论）。

## 文档地图

| 文件 | 内容 |
|---|---|
| [01-frontend-code.md](01-frontend-code.md) | Web 前端：`/connect` 链路、模型按钮与思考强度、HTTP 与错误解析、SSE 事件、路由与外壳、输入框控件、共享组件、mock 场景、文件行数 |
| [02-backend-settings-api.md](02-backend-settings-api.md) | 后端：设置路由清单、错误形状、SDK 错误类型、通用失败、`settings.changed`、模型/搜索/MCP 的 DTO、现有测试 |
| [03-reference-projects.md](03-reference-projects.md) | pi-web、opencode、ZCode、deepseek-harness 等项目的设置页做法 |

## 和旧 01 不一致或旧 01 没写到的地方

| # | 事实 | 出处 |
|---|---|---|
| 1 | 模型修改接口是 `PATCH /v1/settings/models/profiles/:id`，不是 PUT；共用 HTTP 传输已经支持 PUT、PATCH、DELETE，不需要再加 | 01 §1.4，02 §2.1 |
| 2 | 后端已经有部分错误码：`MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE` 带 code；`MCP_SERVER_NOT_FOUND` 和 `VALIDATION_FAILED` 的 code 在路由层被丢掉。agent 侧的校验错误已经带 issues，只是没传出去 | 02 §2.2 |
| 3 | 鉴权、非法 JSON、超大请求、服务不可用等通用失败都没有 code；daemon 下缺目录头的 code 是小写的 `directory-required` | 02 §2.4 |
| 4 | Web 端没有任何代码处理 `settings.changed` | 01 §1.5 |
| 5 | 侧栏左下角没有齿轮，也没有底部区域；应用没有路由库，也没有 `popstate`/`hashchange` 监听 | 01 §1.6 |
| 6 | `ui/shared/` 里没有 `ConfirmDialog`、`SettingsRow`、`SecretField`，有几个相近的现成对话框和密码输入框 | 01 §1.9 |
| 7 | 没有 `settings`、`settings-empty`、`settings-errors` 三个 mock 场景，只有 `no-model` | 01 §1.10 |
| 8 | 输入框里的模型按钮、思考强度和权限控件都没用共享 `Menu`；窄屏适配全靠 CSS | 01 §1.7 |
| 9 | 没配模型时点发送的逻辑在 `ui/session/SessionScreen.tsx` L110–126 | 01 §1.8 |

## 参考项目里和现有决策不同的做法

只列事实，是否调整留到规划讨论。

| 现有决策 | 参考项目的做法 | 出处 |
|---|---|---|
| D2：设置是整页，左侧竖排导航（2026-10-24 已改为弹窗） | opencode、ZCode 是整页加侧栏导航；pi-web、deepseek-harness 是模态框 | 03 §3.1–§3.4 |
| D15：输入框里选中模型就设为全局默认 | pi-web 和 opencode 的选择只对当前会话生效；pi-web 要点星标才设为默认 | 03 §3.1、§3.2 |
| D25：MCP 只读 | pi-web、opencode、ZCode 都能开关 MCP，pi-web 还能测试和添加 | 03 §3.1–§3.3 |
| D29：手机输入框把次要选项收进“更多” | pi-web 有同样的做法，但模型选择器始终在外面，不收进去 | 03 §3.1 |
| D19：校验错误返回字段路径 | opencode 前端解析 `issues[{ path[], message }]`；ZCode 把路径拼进一个字符串；pi-web 的 models 只返回一条文本 | 03 §3.2–§3.4 |

## 待核实（汇总）

| 项目 | 怎么核实 | 文档 |
|---|---|---|
| 清除模型 key 时 `.env` 里的变量是否被删除 | 读 `ohbaby-agent/src/config/llm/writer.ts` 的持久化路径，或实际清除一次再看 `.env` | 02 |
| 实例层 `mcp/reconnect` 是否发 `settings.changed` | 读 `reconnectSettingsMcp`。本期 Web 不用 reconnect，优先级低 | 02 |
| 旧接口 `/v1/model`、`search-api-key` 是否只通知本实例 | 读 `routes/model.ts` 到 agent 的调用链 | 02 |
| opencode `ConfigInvalidError` 的产生位置 | 在 opencode 全仓搜索 | 03 |
| kimi-code 的 MCP 状态展示、其他项目有没有输入框“更多” | 细读对应组件 | 03 |

## 推断（汇总）

| 推断 | 依据 | 文档 |
|---|---|---|
| 真实 daemon 下，ReasoningControl 收不到 `model.invalidated`，模型在别处切换后它不会自己刷新 | `client-sync.ts` L601–604 在调用 `notifyUiEvent` 前就返回了；唯一的测试直接调用 handler。没有实际运行验证 | 01 |
| `settings.changed` 进入 store 后被 reducer 原样忽略 | 代码路径 | 01 |
| Search、MCP 的文件类错误目前会变成 500 | `handle` 只匹配几个 code；设置 improve-2 05 L101 有同样记录 | 02 |
| opencode 的模型选择器不写全局默认；ZCode 的 key 明文会发到前端 | 局部代码 | 03 |

## 没有调查的来源

- 讨论记录：这次没有新的截图、URL 或其他 AI 会话。
- 社区和网页资料：参考项目的源码已经够用，没有上网查。
