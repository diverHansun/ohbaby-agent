# improve-1 · 测试与验收标准（对齐版）

> 配套文档：[01-问题分析](./01-problem-analysis.md)、[02-设计与借鉴](./02-design-and-references.md)、[04-实施计划](./04-implementation-plan.md)。
>
> 测试遵循仓内既有约定：`*.unit.test.ts` 与被测文件同目录，跨模块契约/集成测试放到现有 `*.contract.test.ts` / `*.integration.test.ts` 位置。实现按 TDD：先把目标行为写红，再实现至绿。

---

## 一、测试策略

| 层级 | 目的 | 覆盖问题 |
|------|------|----------|
| 单元 | `generic` 内置 agent、保留名、工具白名单 | P5/P6 |
| 单元 | `role` 参数默认值、enum 校验、错误提示 | P1/P3/P4 |
| 单元 | `name` / `description` 元数据流转，不注入 prompt | P1/P8 |
| 单元 | 主代理提示词注入 subagent role 指南，subagent 不注入 | P2/P7 |
| 单元/契约 | 工具结果 metadata 与模型可见投影 | P9 |
| 集成/冒烟 | 默认 `generic`、`research`、后台 agent task 路径跑通 | 全链路 |

---

## 二、单元测试清单

### 2.1 `agents/builtin` 与 `agents/registry`

- **T1 新增 `generic` 内置 agent**：`BUILTIN_AGENT_NAMES` 包含 `generic`；`AgentManager.get("generic")` 返回 `mode: "subagent"`；description 非空。
- **T2 `generic` 工具白名单**：`generic.tools.include` 等于 `research` 的宽白名单。
- **T3 `generic` 不可被用户配置覆盖**：用户 config 中包含 `name: "generic"` 时，`AgentRegistry.initialize()` 抛错，错误包含 `generic` 与 `reserved` / `cannot be overridden`。
- **T4 `getRuntimeAgent` 与 `getAgentToolsConfig` 一致**：对 `generic` 调用 `getRuntimeAgent("generic", { isSubagent: true })` 与 `getAgentToolsConfig("generic", { isSubagent: true })`，归一化工具集合一致，且不含 `task` / `agent_open` / `agent_eval` / `agent_status` / `agent_close`。
- **T5 mode 守卫集中化**：`getRuntimeAgent("build", { isSubagent: true })` 与 `getRuntimeAgent("plan", { isSubagent: true })` 失败，错误提示说明 `build/plan` 是 primary agents，并列出合法 subagent roles。

### 2.2 `tools/utils/params.unit.test.ts`

- **T6 共享字符串 helper**：`requiredString` / `optionalString` 行为覆盖缺省、空串、非字符串。
- **T7 enum helper**：新增 optional enum helper，缺省返回 `generic`，合法值返回原值，非法值抛 `ToolParameterError`。
- **T8 非法 role 错误文案**：错误包含 `Allowed roles are: generic, explore, research`、`Omit role to use generic`、`Use description`、`Use name`、`build and plan are primary agents`。

### 2.3 `tools/task.unit.test.ts`

- **T9 schema 字段**：`parametersJsonSchema.properties` 包含 `role`、`name`、`description`、`prompt`、`resume_session_id`；`required` 仅包含 `prompt`；`role.enum` 为 `["generic", "explore", "research"]`；`role.default` 为 `"generic"`；`role.description` 非空。
- **T10 缺省 role**：调用 `task` 时不传 `role`，executor 收到 `role: "generic"`。
- **T11 显式 role**：调用 `task` 传 `role: "research"`，executor 收到 `role: "research"`。
- **T12 元数据字段透传**：`name` / `description` 透传到 executor；`prompt` 不被自动拼接 `name` / `description`。
- **T13 非法 role 拒绝**：传 `role: "AI Events Researcher"` 抛 `ToolParameterError`，错误文案符合 T8。

### 2.4 `tools/agent-task.unit.test.ts`

- **T14 schema 字段**：`agent_open` 与 `task` 对齐，`role` 可选 enum，schema-visible default 为 `"generic"`，required 仅为 `prompt`。
- **T15 缺省 role**：`agent_open` 不传 `role` 时 controller 收到 `role: "generic"`。
- **T16 字段透传**：`name` / `description` 透传到 controller；`prompt` 不被自动拼接元数据。
- **T17 非法 role 拒绝**：`agent_open` 传非法 `role` 抛可恢复错误。

### 2.5 `agents/service.unit.test.ts`

- **T18 默认 generic 子代理执行**：`AgentService.execute({ role: "generic", ... })` 创建子 session，session 的 agent identity 为 `generic`，runAgent 接收 `agentName: "generic"`。
- **T19 role/name/description 回显**：`SubagentResult` 包含 `role`、可选 `name`、可选 `description`。
- **T20 元数据不注入 prompt**：传入 `name` / `description` 后，runAgent 的 `initialUserPrompt` 仍等于原始 `prompt`。
- **T21 resume 校验按 role**：resume 子会话时仍校验 session agent identity；`generic` 会话不能用 `research` resume。

### 2.6 `agents/tasks/manager.unit.test.ts`

- **T22 `agent_open` 默认 generic**：open 创建 task record，record 包含 `role: "generic"`。
- **T23 task record 元数据**：record 包含 `name` / `description`，且 `description` 继续可作为 session title。
- **T24 runTurn 使用 role**：后台 run 调用 `runAgent` 时使用 record/state 中的 role 作为 `agentName`。
- **T25 不注入 prompt**：`name` / `description` 不拼入后台子代理 `initialUserPrompt`。

### 2.7 `core/system-prompt`

- **T26 primary prompt 注入 subagent role 指南**：primary prompt 包含 `generic`、`explore`、`research`，包含 `Omit role to use generic`，包含 `description and name are metadata only`，包含 `build and plan are primary-agent modes`。
- **T27 subagent prompt 不注入指南**：`isSubagent: true` 时不包含 subagent role 指南。
- **T28 subagent `plan` prompt 移除**：`SubagentTaskKind` 不包含 `plan`；`SystemPrompt.assemble({ isSubagent: true, taskKind: "plan" as any })` 不渲染 `Task: plan`，而是回到当前子代理 role 对应 task kind 或 `generic`。
- **T29 依赖方向**：`core/system-prompt` 不 import `agents`；通过 provider options 接收可用 role 信息。
- **T30 composition 接线**：`adapters/ui-runtime/composition.ts` 给 provider 注入 `generic/explore/research` 的 role 信息，不把 `build/plan` 注入；primary 分支仍按 `permissionState.getMode()` 选择 `agent/plan`。

### 2.8 `core/context/tool-metadata-projection.unit.test.ts`

- **T31 `task` metadata 投影**：`projectToolMetadataForModel("task", { subagent: ... })` 保留 `role`、`name`、`description`、`sessionId`、`success`。
- **T32 `agent_open` metadata 投影**：`agentTask` metadata 保留 `role`、`name`、`description`、`taskId`、`sessionId`、`status`。
- **T33 model-visible result**：`formatToolResultContentForModel` 输出 `<tool_metadata>` 中包含 `role/name/description`。

---

## 三、契约 / 集成测试

- **T34 工具列表契约**：`listToolSummaries` / `/tools` 中 `task` 与 `agent_open` schema 显示 `role` enum 和 default `"generic"`，不再显示 `agent_name`。
- **T35 runAgent 工具集一致**：通过 in-process 装配，默认 `generic` 子代理进入 `runAgent` 后实际可用工具等于 `generic` 白名单剥离递归工具后的集合。
- **T36 primary plan 模式不变**：`Shift+Tab` 仍只切换 permission mode；primary prompt 仍按 `permissionState.getMode()` 选择 `Task: agent` / `Task: plan`；不改变 session agent identity。
- **T37 `build/plan` 不能作 subagent role**：模型/工具传入 `role: "plan"` 或 `role: "build"` 时参数层拒绝，并返回可恢复错误。

---

## 四、真实 e2e / smoke

真实 smoke 不默认运行，沿用现有 opt-in 环境变量。

- **T38 real TUI subagent smoke 改名**：现有真实子代理 smoke 中提示模型使用 `role explore`，不再使用 `agent_name explore`。
- **T39 real TUI 默认 generic smoke**：新增场景：让真实模型调用 `task`，省略 `role`，传 `description: "AI Events Researcher"` 和任务 prompt；期望创建 `generic` 子 session 并返回成功 token。
- **T40 real TUI `agent_open` 默认 generic smoke**：让真实模型调用 `agent_open`，省略 `role`；期望创建后台 task，task metadata / database 记录中的 role 为 `generic`。
- **T41 real Firecrawl smoke 不泄密**：若运行 Firecrawl MCP smoke，继续验证工具结果与 metadata 不泄漏 API key。

`ohbaby-e2e-test.md` 只能由人类在模型外部用于准备本地环境变量；agentic workers 不得打开、读取、引用或总结该文件。若运行时没有现成环境变量，真实 smoke 记录为 `credentials unavailable` 并跳过。

---

## 五、验收标准

| 编号 | Given | When | Then |
|------|-------|------|------|
| AC-1 | 主代理读取系统提示词 | 准备 primary prompt | 能看到 subagent role 范围 `generic/explore/research`、默认 `generic`、`name/description` 元数据说明 |
| AC-2 | 主代理调用 `task` | 省略 `role` 且给 `prompt` | 子代理以 `generic` 运行 |
| AC-3 | 主代理调用 `task` | `role: "research"` | 子代理以 `research` 运行 |
| AC-4 | 主代理调用 `agent_open` | 省略 `role` | 后台子代理 task 以 `generic` 运行 |
| AC-5 | 主代理误传描述性 role | `role: "AI Events Researcher"` | 参数拒绝，错误提示如何改用 `description` / `name` |
| AC-6 | 主代理误传 primary role | `role: "build"` 或 `role: "plan"` | 参数拒绝，错误提示 `build/plan` 是 primary agents |
| AC-7 | 任意子代理调用 | 传入 `name` / `description` | 它们只出现在 UI/日志/结果 metadata，不自动注入子代理 prompt |
| AC-8 | 用户配置 | 尝试覆盖 `generic` | 初始化失败，说明 `generic` 是保留身份 |
| AC-9 | 子代理执行 | 查询实际工具集 | 工具集为该 role 白名单，并剥离递归子代理工具 |
| AC-10 | 主模式切换 | TUI Shift+Tab | 行为保持现状，只切 `auto/plan` permission mode，不影响 subagent role |
| AC-11 | 工具结果进入下一轮模型上下文 | metadata 投影 | 模型可见 `role/name/description` |
| AC-12 | 全量测试 | 运行 unit/contract/integration/smoke opt-in | 非 opt-in 测试全绿，真实 smoke 在有凭据时通过 |

---

## 六、完成定义

- [ ] `01`、`02`、`03`、`04` 文档口径一致。
- [ ] 所有测试 T1..T36 存在且通过。
- [ ] 真实 e2e smoke T37..T40 在 opt-in 环境通过，或记录外部服务失败原因。
- [ ] `pnpm run lint`、`pnpm run typecheck`、`pnpm run test` 通过。
- [ ] 未改动 `Shift+Tab` 模式切换语义。
- [ ] 未引入用户自定义 subagent role 注册、per-agent permission 接通或 description/name prompt 注入。
