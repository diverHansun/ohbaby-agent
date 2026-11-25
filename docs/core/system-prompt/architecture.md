# system-prompt 模块 architecture.md

本文档描述 `system-prompt` 模块的内部结构与边界。

---

## 一、架构概览

`system-prompt` 采用分层组装架构。静态模板保存在 `.md` 文件中，代理角色与附加提示按当前配置渲染，最终由 `SystemPrompt.assemble()` 组合为有序 `string[]`。

```mermaid
flowchart TD
  caller["ContextManager / Agents / UI Runtime"] --> provider["createSystemPromptProvider()"]
  provider --> assembler["SystemPrompt.assemble()"]
  prompts["prompts/*.md"] --> generated["templates.generated.ts"]
  generated --> assembler
  assembler --> layers["base、task、addon、roles"]
  caller --> reminders["createReminderCollector()"]
  instructions["services/instructions"] --> reminders
  provider --> environment["detectEnvironment()"]
  environment --> reminders
  reminders --> history["user 侧 system-reminder"]
  assembler --> output["string[] prompt layers"]
```

---

## 二、目录结构

```text
packages/ohbaby-agent/src/core/system-prompt/
  assembler.ts
  index.ts
  types.ts
  layers/
    base.ts
    environment.ts
    index.ts
  prompts/
    templates.generated.ts
    primary/
      base.md
      base.ts
      subagent-roles.md
      subagent-roles.ts
      tasks/
        agent.md
        plan.md
      tasks.ts
    subagents/
      base.md
      base.ts
      tasks/
        explore.md
        generic.md
        research.md
      tasks.ts
    agents/
      generic.ts
      index.ts
  security/
    index.ts
```

### 2.1 prompts

`prompts/` 存储静态模板。`.md` 是内容源，`templates.generated.ts` 是由脚本生成的 TS 快照，`.ts` wrapper 只负责导出稳定常量或 lookup 函数。

### 2.2 layers

`layers/` 只放运行时层 renderer：

- `base.ts`: 返回 primary base prompt（`generateBasePrompt`）。
- `environment.ts`: 检测并渲染 cwd、platform、date、git 状态；完整环境还含 OS version，子代理使用 minimal 形式。Context 为 run 保存环境快照，environment reminder 在 user 侧使用该快照。

### 2.3 文件指令

`services/instructions` 在每次准备模型请求时读取全局与项目指令。首份快照、内容变更和清空声明由 reminder collector 持久化到 user 历史；相同快照不重复追加。详见[指令数据流](../../services/instructions/dfd-interface.md)。

### 2.4 assembler

`assembler.ts` 是组装入口。它负责：

- 校验 `agentName` 与 `isSubagent`。
- 主代理使用固定 agent 任务契约，子代理按 task kind 或 agent name 选择任务模板。
- 包装 `agentPromptAddon` 为 `<agent_prompt_addon>`。
- 用运行时 role 列表替换 `subagent-roles.md` 中的 `{{ROLES}}` 占位符（函数式替换，避免 `$` 序列被解释）。
- 按固定层顺序返回 `string[]`。

---

## 三、层顺序

primary prompt：

```text
base -> primary task -> agent addon -> subagent roles
```

subagent prompt：

```text
subagent base -> subagent task -> agent addon
```

subagent roles 只在主代理有可用 role 时出现。动态文件指令、环境和 scoped MCP 菜单由各自的 reminder provider 提供。MCP 菜单只含精确本地名和固定说明，description/schema 在 `select_tools` 成功后随原生 tools 发送。

---

## 四、设计模式

### Facade

`SystemPrompt` 是模块 facade，暴露 `assemble()`、`getAgentPrompt()`、`getSubagentBase()`、`getEnvironment()`、`getPrimaryBase()`。

### Adapter

`createSystemPromptProvider()` 将 context manager 的 `SystemPromptProviderInput` 适配为 `AssembleOptions`。provider 还提供 `detectEnvironment()`，使用执行 `directory` 检测环境。

### Layered Composition

每一层独立生成文本，assembler 只负责排序、过滤空层和拼装。

---

## 五、边界关系

| 模块 | 关系 | 边界 |
| --- | --- | --- |
| agents | 调用/提供 addon | agent runtime prompt 只能作为 addon，不替换默认 identity/task |
| context | 消费 provider | 固定 run 的 systemPrompt 和可选 environment 快照，并投影消息历史 |
| ui-runtime | 提供代理与任务 resolver | permission mode 与工具注册不属于 system-prompt |
| mcp integration | 对外部 MCP metadata 做准入并维护 loaded 集 | 失败、不可解析或不安全 metadata 不得进入公告或工具 schema |
| tool-scheduler | 提供工具名/工具描述 | system-prompt 不执行工具、不审批权限 |
| config/llm | 无直接依赖 | model/provider 选择不属于本模块 |

---

## 六、构建约束

- `scripts/generate-system-prompt-assets.mjs` 从 `.md` 生成 `prompts/templates.generated.ts`。
- `pnpm --filter ohbaby-agent prompt:check` 会校验 `.md` 与生成快照同步。
- `ohbaby-agent` 的 `build` 会先运行 `prompt:check`。
- 源码运行、Vitest、tsc 和 tsup 都只消费 TS 快照，不需要自定义 `.md` loader。
- 运行时 bundle 中已经包含模板文本，不读取源码目录下的 `.md` 文件。
