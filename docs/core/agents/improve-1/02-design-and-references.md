# improve-1 · 设计方案与参考对齐

> 配套文档：[01-问题分析](./01-problem-analysis.md)、[03-测试与验收](./03-test-and-acceptance.md)、[04-实施计划](./04-implementation-plan.md)。
>
> 本文档记录最终设计决策：`role` 可选且受控，默认 `generic`；`name` 与 `description` 是元数据；`generic` / `explore` / `research` 是系统保留内置子代理身份。

---

## 一、最终设计目标

让主代理能稳定委派子代理：

- 事前知道可用 subagent role 范围。
- 不传 role 时自动使用通用子代理。
- 把实例显示名和角色/任务描述放到正确字段。
- 参数填错时得到可恢复提示。
- `build` / `plan` 主代理模式不被误暴露为子代理身份。
- `generic` / `explore` / `research` 在运行态和工具调度态拿到一致的工具集。

---

## 二、核心决策

| 决策 | 内容 | 理由 |
|------|------|------|
| D1 `role` 是行为身份 | `role?: "generic" | "explore" | "research"`，缺省为 `generic` | role 决定系统画像和工具边界，必须受控 |
| D2 `generic` 是真实内置 subagent | 新增内置 `generic` agent，默认工具画像沿用 `research` | 默认路径稳定，工具解析有单一事实源 |
| D3 固定 subagent roles 是保留身份 | 用户配置不得覆盖 `generic` / `explore` / `research` | schema 和主代理提示词固定暴露这些 role，不能被配置漂移破坏 |
| D4 `name` 是实例显示名 | 仅用于 UI、日志、结果回显，不决定行为 | 避免模型把显示名当行为身份 |
| D5 `description` 是元数据 | 仅用于 UI、日志、结果回显，不注入子代理 prompt | 不隐式改写任务；子代理必须从 `prompt` 获得真实任务要求 |
| D6 `build` / `plan` 只属于 primary side | `build` / `plan` 不进入 subagent role enum | `Shift+Tab` 主模式切换与子代理构造无关 |
| D7 非法 role 失败并给提示 | 不再做未知 role 降级 | 现在自定义身份感由 `name` / `description` 承担，role 应强约束 |
| D8 不新增工具 | 继续使用 `task` / `agent_open` | 只修契约和运行边界，不扩大工具面 |

---

## 三、工具契约

### 3.1 `task`

Tool schema must mark `role.default` as `"generic"` so the default is visible to the model.

```ts
{
  role?: "generic" | "explore" | "research";
  name?: string;
  description?: string;
  prompt: string;
  resume_session_id?: string;
}
```

### 3.2 `agent_open`

Tool schema also marks `role.default` as `"generic"`.

```ts
{
  role?: "generic" | "explore" | "research";
  name?: string;
  description?: string;
  prompt: string;
}
```

### 3.3 字段语义

| 字段 | 必填 | 语义 | 进入子代理 prompt |
|------|------|------|-------------------|
| `role` | 否 | 行为身份；缺省为 `generic`；只能是 `generic/explore/research` | 通过系统提示词画像体现 |
| `name` | 否 | 主代理起的实例显示名 | 否 |
| `description` | 否 | 任务/角色描述，如 `AI Events Researcher` | 否 |
| `prompt` | 是 | 子代理实际执行的任务内容 | 是 |

如果主代理希望子代理按 `"AI Events Researcher"` 行事，应在 `prompt` 中写明这一点；`description` 只负责 UI/日志可读性。

### 3.4 非法 role 错误

运行时参数校验必须兜底，即使 schema 有 enum。错误文案要可恢复：

```text
Invalid subagent role: "AI Events Researcher".
Allowed roles are: generic, explore, research. Omit role to use generic.
Use description for descriptive role text such as "AI Events Researcher".
Use name for the displayed subagent instance name.
build and plan are primary agents, not subagent roles.
```

---

## 四、`generic` 内置子代理

### 4.1 配置

新增 `genericAgent`：

```ts
export const genericAgent: AgentConfig = {
  color: "#64748B",
  description:
    "General-purpose subagent for delegated bounded work when no specialized role is needed.",
  maxSteps: 30,
  mode: "subagent",
  name: "generic",
  permission: {
    bash: { "*": "ask" },
    edit: "ask",
    mcp: "ask",
    web: "allow",
  },
  tools: {
    include: [
      "read",
      "list",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
      "todo_read",
      "todo_write",
      "web_fetch",
      "web_search",
      "memory_list",
    ],
  },
};
```

该白名单有意沿用 `research` 的宽通用画像，以覆盖调研、文件检查和轻量修改等默认委派任务。

### 4.2 安全边界

- `generic` 的能力天花板就是工具白名单。
- `name`、`description`、`prompt` 不能注入 tools 或 permission。
- 子代理运行时始终带 `isSubagent: true`，工具 registry 会剥离 `task`、`agent_open`、`agent_eval`、`agent_status`、`agent_close`。
- `AgentConfig.permission` 当前未接通实际 permission evaluator，不能把安全保证写在它身上；写/执行操作仍由全局 permission profile 和 mode gate 控制。

### 4.3 保留身份

`generic` / `explore` / `research` 是保留系统身份。用户配置中出现这些 `name` 时应在加载/初始化阶段失败，错误信息明确说明该 role is reserved / cannot be overridden。

`build`、`plan` 暂时保持现有 primary 覆盖语义；它们不在 subagent role enum 中，也不能通过 `task` / `agent_open` 构造为子代理。

---

## 五、可发现性设计

### 5.1 主代理提示词

主代理系统提示词中注入一段 subagent role 指南。该内容只出现在 primary prompt，不出现在 subagent prompt。

```text
Subagent roles for task / agent_open:
- generic: default general-purpose subagent. Omit role to use generic.
- explore: fast code exploration.
- research: deeper research and information synthesis.

Do not put descriptive names such as "AI Events Researcher" in role.
Put those in description. Put display names in name.
description and name are metadata only. If the subagent must follow a persona,
scope, constraints, known files, or expected output format, include those details
inside prompt.
build and plan are primary-agent modes, not subagent roles.
```

### 5.2 依赖方向

`core/system-prompt` 不应 import `agents`。接线方式：

1. 在 `core/system-prompt` 类型中新增 `availableSubagentRoles?: readonly SubagentRolePromptInfo[]`。
2. `SystemPrompt.assemble` 在 primary 分支渲染。
3. `createSystemPromptProvider` 支持 `availableSubagentRolesProvider?`。
4. `adapters/ui-runtime/composition.ts` 用 `agentManager.get("generic" | "explore" | "research")` 组装注入数据。

这样保持 `tools -> agents -> core/agents` 的依赖方向，不引入 `core -> agents` 反向依赖。

### 5.3 工具描述

`task` / `agent_open` 的工具 description 也要提醒：

- `role` 可省略，默认 `generic`。
- `role` 只接受 `generic/explore/research`。
- `description` 与 `name` 是元数据。
- 子代理没有父上下文，必要信息必须写入 `prompt`。

---

## 六、结果回显与模型可见性

### 6.1 工具结果

`task` 成功结果 metadata 中的 `subagent` 应包含：

```ts
{
  role: "generic" | "explore" | "research";
  name?: string;
  description?: string;
  sessionId: string;
  success: boolean;
  summary: ...
}
```

`agent_open` / `agent_status` / `agent_close` 的 `agentTask` metadata 中应包含：

```ts
{
  role: "generic" | "explore" | "research";
  name?: string;
  description?: string;
  taskId: string;
  sessionId: string;
  status: ...
}
```

### 6.2 模型可见投影

`core/context/tool-metadata-projection.ts` 当前会白名单投影 metadata。必须同步加入：

- `role`
- `name`
- `description`

否则主代理下一轮看不到自己委派的是哪个显示名/描述/行为身份。

---

## 七、运行态接线

### 7.1 工具层

工具层负责把外部参数转为内部 subagent 执行参数：

- `role` 缺省补 `generic`。
- `role` 非 enum 值时抛 `ToolParameterError`，错误可恢复。
- `name` / `description` 用共享 string helper 校验。
- `prompt` 必填非空。

### 7.2 agents 层

内部字段可以继续沿用 `agentName` 传给 session / runner，但文档语义必须标注为 role。推荐在 subagent 专用类型上改为 `role`，在调用 `runAgent` 时映射到 `agentName`，减少后续混淆。

### 7.3 manager 层

`AgentManager.getRuntimeAgent(agentName, { isSubagent })` 集中执行 mode 守卫：

- `config.mode === "primary"` 且 `isSubagent === true` 时失败。
- `config.mode === "subagent"` 且 `isSubagent === false` 时失败。
- `config.mode === "all"` 两边都允许。

错误文案列出 primary/subagent 边界和合法 subagent roles。

### 7.4 system-prompt 层

primary prompt 仍按 permission mode 渲染 `Task: agent` 或 `Task: plan`，这是 `Shift+Tab` 的模式切换语义。subagent prompt 的 task kind 只允许 `generic` / `explore` / `research`；历史上的 subagent `plan` prompt 要移除或变为不可达，避免 `plan` 被误解为可构造子代理身份。

### 7.5 scheduler 层

`getAgentToolsConfig("generic", { isSubagent: true })` 必须返回 `generic` 白名单并剥离递归子代理工具。`getRuntimeAgent("generic").tools` 与 scheduler 实际可用工具集合要一致。

---

## 八、非目标

本轮不做：

- 会话级自定义 role 注册表。
- 用户配置新增可调用 subagent role。
- LLM 生成持久化 agent 配置。
- 接通 per-agent `AgentConfig.permission` 到 permission evaluator。
- 改动 `Shift+Tab`、permission mode、primary `Task: plan`/`Task: agent` 选择逻辑。
- 合并 `task` 与 `agent_open` 两条执行链路。
- 把 `description` / `name` 注入子代理 prompt。

---

## 九、优秀项目参考取舍

### 9.1 kimi-code

可借鉴：

- 在工具描述中列出可用子代理身份。
- 有默认通用子代理身份。
- 子代理 prompt 编写规则要明确。

不照搬：

- kimi 对未知显式类型抛错；本方案现在通过 enum + 默认 `generic` 把错误前移到工具参数层。
- kimi 的前台/后台统一工具不适用于本仓已有 `task` / `agent_open` 分工。

### 9.2 opencode

可借鉴：

- 权限是独立关注点，不与身份描述混为一谈。
- hidden / task 权限治理可作为未来方向。

不纳入本轮：

- `permission.task` glob 治理。
- LLM 生成并持久化 agent 配置。
- per-agent permission ruleset 接通。
