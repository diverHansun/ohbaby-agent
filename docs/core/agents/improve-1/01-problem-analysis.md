# improve-1 · 现有问题分析（对齐版）

> 本文档分析 `agents` 与 `core/agents` 模块在"主代理调用子代理"链路上的现有问题。
> 配套文档：[02-设计与借鉴](./02-design-and-references.md)、[03-测试与验收](./03-test-and-acceptance.md)、[04-实施计划](./04-implementation-plan.md)。
>
> 核心结论：这不是"子代理名称写死了"的问题，而是 `role`、`name`、`description` 三种语义混在了一个 `agent_name` 字段里，导致主代理无法发现合法子代理身份，也无法把自定义显示名和角色描述放到正确字段。

---

## 一、背景与症状

用户指令："调用子代理去查看 2026 年各城市的 AI 论坛/活动"。主代理依次调用了 `task` 与 `agent_open` 工具，两者都失败：

```text
tool task (failed)
  input: {"agent_name":"AI Events Researcher","description":"...","prompt":"..."}
tool result (failed)
  error: Agent not found: AI Events Researcher

tool agent_open (failed)
  input: {"agent_name":"AI Events Researcher", ...}
tool result (failed)
  error: Agent not found: AI Events Researcher
```

`"AI Events Researcher"` 在真实语义上不是行为身份，而是一个对子代理定位的描述。当前工具契约只有 `agent_name` 一个自由字符串，模型自然会把"给这个子代理起一个角色名"的意图塞进去；系统却把它当注册表 key 查找，于是直接失败。

---

## 二、根因分析

### 2.1 字段职责混乱

当前 `task` / `agent_open` 暴露的参数结构是：

```ts
agent_name: { type: "string" },
description: { type: "string" },
prompt: { type: "string" }
```

问题在于：

- `agent_name` 被实现当作注册身份 key。
- 模型把 `agent_name` 当作子代理实例名或角色描述。
- `description` 没有被明确说明是 UI/日志元数据。
- 没有 `name` 字段承载实例显示名。
- 没有 `role` 字段承载受控行为身份。

新版契约必须拆开：

| 字段 | 职责 |
|------|------|
| `role` | 可选行为身份，决定工具画像和系统提示词，默认 `generic` |
| `name` | 可选实例显示名，仅用于 UI/日志/结果回显 |
| `description` | 可选任务/角色描述，仅用于 UI/日志/结果回显 |
| `prompt` | 必填，子代理真正看到并执行的任务内容 |

### 2.2 可发现性缺失

主代理系统提示词没有告诉模型可委派的子代理身份范围。工具 schema 也没有 enum 或说明。于是模型不知道：

- `build` / `plan` 是主代理身份与主任务模式相关概念，不是子代理身份。
- 内置可委派子代理身份只有 `generic`、`explore`、`research`。
- 不传 `role` 应默认走 `generic`。
- `"AI Events Researcher"` 这类文本应该放在 `description`，显示名放在 `name`。

### 2.3 错误不可恢复

当前错误是：

```text
Agent not found: AI Events Researcher
```

它没有告诉模型如何修正。新版参数拒绝必须包含：

- 合法 `role` 值：`generic`、`explore`、`research`。
- 缺省 `role` 的行为：默认 `generic`。
- `description` 与 `name` 的用途。
- `build` / `plan` 不能作为 subagent role。

### 2.4 底层工具解析双路径隐患

当前 `RuntimeAgent.tools` 与子代理执行时实际工具集不是同一个入口：

- `AgentManager.getRuntimeAgent(...)` 用注册表查 agent，未知时抛错。
- `runAgent(...)` 内部通过 `toolScheduler.getAvailableTools({ agentName, isSubagent })` 重新解析工具。
- `toolScheduler` 再调用 `agentTools.getAgentConfig(agentName)`，当前未知 agent 会拿到 `undefined`。
- 工具 registry 对 `undefined` 工具配置默认放行全部工具，再由 `isSubagent` 剥离 `task` / `agent_*`。

在新版方案中，`generic` 会成为真实内置 subagent，`role` 也会在工具层被 enum 校验；未知 role 不再进入执行链路。但仍必须保证：

- `generic` 在 `getRuntimeAgent` 和 `getAgentToolsConfig` 两条路径里得到同一份工具白名单。
- `getRuntimeAgent` 集中执行 primary/subagent mode 守卫。
- `build` / `plan` 作为 subagent role 失败，且错误可恢复。

---

## 三、边界澄清

### 3.1 `build` / `plan` 的定位

`build` / `plan` 是主代理身份与主任务模式相关概念。

- `build` 是常规主代理身份。
- `plan` 是规划/只读主代理身份。
- TUI 中 `Shift+Tab` 切换的是主代理任务/权限模式 `auto <-> plan`，影响 primary prompt 的 `Task: agent` / `Task: plan` 与 permission gate。
- `Shift+Tab` 不参与子代理创建，也不改变 subagent role schema。

### 3.2 subagent role 的定位

`task` / `agent_open` 的 `role` 只允许：

- `generic`：默认通用子代理。
- `explore`：快速代码探索子代理。
- `research`：深度调研/信息综合子代理。

不传 `role` 等价于 `generic`。

### 3.3 `description` 与 `name` 不注入子代理上下文

`description` 和 `name` 仅用于 UI、日志、结果回显和 task record。它们不改变系统提示词，也不被自动拼入子代理 `prompt`。

如果主代理希望子代理遵循某个人设、范围、约束、已知路径或输出格式，必须把这些要求写进 `prompt`。

---

## 四、问题清单

| 编号 | 问题 | 处理文档 |
|------|------|----------|
| P1 | `agent_name` 混淆行为身份、实例名、角色描述 | 02 §2/§3 |
| P2 | 主代理提示词未说明 subagent role 范围与默认值 | 02 §5 |
| P3 | 工具 schema 无 enum、无字段说明、无 `name` | 02 §3 |
| P4 | 参数错误不可恢复 | 02 §5，03 T7/T8 |
| P5 | `generic` 默认身份不存在，导致兜底不稳定 | 02 §4 |
| P6 | 工具解析双路径需确保 `generic` 工具集一致 | 02 §4，03 T4/T12 |
| P7 | `build` / `plan` 与 subagent role 边界易混淆 | 02 §1/§3，03 AC-6 |
| P8 | `description` / `name` 的元数据性质需明确 | 02 §3，03 AC-7 |
| P9 | 工具结果 metadata 投影可能过滤 role/name/description | 02 §6，03 T10 |

