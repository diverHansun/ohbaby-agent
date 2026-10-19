# system-prompt 模块 data-model.md

本文档定义 `system-prompt` 模块的核心数据类型与概念。

---

## 一、核心概念

### Prompt Layer

prompt layer 是一个独立的 system prompt 片段。`SystemPrompt.assemble()` 返回有序 `string[]`，每个元素代表一个非空层。

### Static Prompt Template

静态模板是 `prompts/` 下的 `.md` 文件。生成脚本把它们同步到 `prompts/templates.generated.ts`，源码运行和打包都消费这个 TS 快照。

### Runtime Layer

runtime layer 由代码根据当前输入渲染，例如 custom instructions 和 agent addon。environment 与调用方提供的 MCP 菜单由独立 `buildRuntimeContext()` 返回，Context 把它附着为 user model-context part。

---

## 二、类型

### LayerType

```ts
export type LayerType =
  | "agent"
  | "base"
  | "custom"
  | "environment"
  | "runtime"
  | "task";
```

`LayerType` 用于描述概念层，不驱动运行时排序。

### AgentKind

```ts
export type AgentKind = "primary" | "subagent";
```

### Task Kind

```ts
export type PrimaryTaskKind = "plan" | "agent";
export type SubagentTaskKind = "explore" | "research" | "generic";
export type PromptTaskKind = PrimaryTaskKind | SubagentTaskKind;
```

### EnvironmentInfo

```ts
export interface EnvironmentInfo {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly date: string;
  readonly isGitRepo: boolean;
  readonly osVersion?: string;
}
```

### CustomInstruction

```ts
export interface CustomInstruction {
  readonly scope: "project" | "global";
  readonly text: string;
}
```

范围由 loader 的读取分支确定，不从正文或数组位置推断。renderer 固定 Global → Project；项目约定优先，全局作为默认，均不得覆盖当前用户要求、宿主权限或委派边界。

### AssembleOptions

```ts
export interface AssembleOptions {
  readonly agentName: string;
  readonly agentPrompt?: string;
  readonly agentPromptAddon?: string;
  readonly isSubagent: boolean;
  readonly availableSubagentRoles?: readonly SubagentRolePromptInfo[];
  readonly customInstructions?: readonly CustomInstruction[];
  readonly taskKind?: PromptTaskKind;
}
```

### SystemPromptProviderInput

```ts
export interface SystemPromptProviderInput {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly directory: string;
  readonly projectRoot?: string;
  readonly isSubagent: boolean;
  readonly agentName?: string;
  readonly toolNames: readonly string[];
}
```

### SystemPromptProviderOptions

`SystemPromptProviderOptions` 注入 resolver/loader/detector，用于把 runtime 信息适配到 `AssembleOptions`：

- `agentNameResolver`
- `agentPromptResolver`
- `customInstructionLoader`：主、子代理共用，返回 `readonly CustomInstruction[]` 或其 Promise
- `environmentDetector`
- `runtimePromptsProvider`：提供 scoped runtime 文本，如当前 MCP 菜单
- `taskKindResolver`
- `availableSubagentRolesProvider`
- `onWarning`
- `onSecurityFinding`

---

## 三、输出模型

`SystemPrompt.assemble()` 的输出类型是：

```ts
string[]
```

provider 的 `build()` 把非空稳定层用空行拼成 `string`；`buildRuntimeContext()` 独立返回环境与 runtime 文本。Context 的 `AgentRunPromptSnapshot` 只保存 `systemPrompt`，不引入来源去重或新的返回信封。

---

## 四、模板数据

| 模板 | 文件 | 说明 |
| --- | --- | --- |
| primary base | `prompts/primary/base.md` | primary identity 与基础行为 |
| primary plan | `prompts/primary/tasks/plan.md` | plan 任务契约 |
| primary agent | `prompts/primary/tasks/agent.md` | agent 任务契约 |
| subagent base | `prompts/subagents/base.md` | subagent 基础约束 |
| subagent explore | `prompts/subagents/tasks/explore.md` | explore 任务契约 |
| subagent research | `prompts/subagents/tasks/research.md` | research 任务契约 |
| subagent generic | `prompts/subagents/tasks/generic.md` | generic 子任务契约 |

`prompts/agents/generic.ts` 是兼容导出，复用 generic subagent task，不维护第二份重复模板。
