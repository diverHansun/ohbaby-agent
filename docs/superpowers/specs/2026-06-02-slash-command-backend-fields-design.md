# Slash Command Backend Fields Design

日期: 2026-06-02

## 背景

当前 slash-command 链路已经打通：SDK 负责解析和匹配命令，agent 负责 catalog 与 handler，CLI/TUI 消费 command result event。但是后端命令输出字段仍不完整：

- `/help` 只输出扁平 `commands`，缺少后续 TUI 可直接消费的分类结构。
- `/status` 只输出当前模型和运行状态，没有 session、tools、skills、MCP server、context、project root 等后端状态。
- `/mcps` 不存在。
- `/skills` 列表命令不存在，虽然每个 skill 已经能注册成动态 slash command。

本设计采用方案 B：保持当前事件驱动架构和 provider DI 模式，不做 TUI 交互优化，也不做 command domain DTO 全量标准化。后续如果输出契约继续扩张，再借鉴 opencode 和 kimi-code 评估是否需要统一 DTO 层。

## 目标

1. 对齐后端 command output 字段，使 `/help`、`/status`、`/mcps`、`/skills` 可稳定供 CLI/TUI 和其他 surface 消费。
2. 新增 `/mcps`，列 MCP server 状态，不列具体 tools。
3. 新增 `/skills`，列用户可调用 skill，并与动态 skill slash command 对齐。
4. `/status` 保持向后兼容字段，同时新增短 MCP server 汇总。
5. TUI 只做最小 readable formatting，不设计新的交互或视觉模块。
6. 本临时分支不 commit，不 merge；完成后等待用户审核。

## 非目标

- 不实现 MCP enable/disable toggle。
- 不在 `/mcps` 展示每个 server 的具体 tools。
- 不新增 `/tools`。
- 不做 TUI modal、分页、滚动、颜色、布局优化。
- 不提前实现 plugin module 契约；`/skills` 不输出 `pluginId`。
- 不做 command domain DTO 全量标准化，除非后续实现发现字段扩张已经明显失控。

## 后端数据契约

### `/help`

`/help` 输出继续保留 `commands`，并新增 `categories`：

```typescript
dataOutput("help", {
  commands: UiCommandSpec[],
  categories: [
    {
      name: "system",
      title: "System",
      commands: UiCommandSpec[],
    },
  ],
})
```

分类来源是 `UiCommandSpec.category`。`name` 保留原始 category 值，`title` 只做简单可读化，例如 `system -> System`、`permission -> Permission`。`commands` 保持原有 spec 字段，不在 handler 内裁剪，避免后续 TUI 缺字段。

### `/status`

`/status` 保留现有字段：

```typescript
{
  model: CommandModelSummary | null,
  models: CommandModelSummary[],
  status: string,
}
```

新增字段：

```typescript
{
  sessionId: string | null,
  tools: {
    builtin: number,
    module: number,
    skill: number,
    mcp: number,
  },
  skillsCount: number,
  mcps: {
    total: number,
    connected: number,
    failed: number,
    disabled: number,
    disconnected: number,
  },
  context: ContextUsage | null,
  projectRoot: string | null,
}
```

`tools.mcp` 表示当前可用 MCP tools 数量。`mcps.*` 表示 MCP server 状态数量。两者语义不同，不混合。

`context` 直接使用现有 context 模块语义字段，例如 `currentTokens`、`contextLimit`、`remainingTokens`、`usageRatio`、`shouldCompress`、`modelId`。如果当前 session 无法可靠组装 context usage，则返回 `null`。

### `/mcps`

新增 `/mcps`，alias `/mcp`。输出 MCP server 状态，不列具体 tools：

```typescript
dataOutput("mcps", {
  servers: [
    {
      name: "github",
      status: "connected",
    },
    {
      name: "memory",
      status: "disabled",
    },
    {
      name: "bad",
      status: "failed",
    },
  ],
})
```

`status` 对齐现有 MCP 状态：`connected`、`failed`、`disconnected`、`disabled`。

### `/skills`

新增 `/skills`。输出用户可调用 skill，并与动态 slash command 对齐：

```typescript
dataOutput("skills", {
  skills: [
    {
      name: "brainstorming",
      description: "Brainstorm ideas into designs and specs",
      path: ["brainstorming"],
      commandId: "skill.brainstorming",
      scope: "user",
      source: "codex-home",
    },
  ],
})
```

`scope` 必填，只能是 `user` 或 `project`。`source` 可选，来自 skill loader 的 `SkillInfo.source`，用于说明 skill 是从哪类目录或兼容格式发现的。`source` 不是 slash command 的 `source: "skill"`，两者语义不同。

## Provider 设计

`CommandServiceOptions` 继续作为命令层依赖注入容器，新增可选 provider：

```typescript
export type CommandSkillScope = "user" | "project";

export interface CommandSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly scope: CommandSkillScope;
  readonly source?: string;
}

export type CommandMcpServerStatus =
  | "connected"
  | "failed"
  | "disconnected"
  | "disabled";

export interface CommandMcpServerSummary {
  readonly name: string;
  readonly status: CommandMcpServerStatus;
}

export interface CommandMcpProvider {
  listServers():
    | Promise<readonly CommandMcpServerSummary[]>
    | readonly CommandMcpServerSummary[];
}
```

`CommandServiceOptions` 新增：

```typescript
readonly mcps?: CommandMcpProvider;
readonly getContextUsage?: (input: {
  readonly sessionId?: string;
}) => Promise<ContextUsage | null> | ContextUsage | null;
readonly getProjectRoot?: () => Promise<string> | string;
```

## Adapter 接线

`ui-inprocess.ts` 负责把已有运行时能力接入 command provider：

- `tools.listTools()` 继续使用 `runtime.listToolSummaries()`。
- `skills.listUserInvocable()` 从 `SkillRegistry.listUserInvocable()` 返回 `name`、`description`、`scope`、可选 `source`。
- `mcps.listServers()` 使用 runtime 暴露的 MCP status 读取能力，底层来自 `McpManager.getStatus()`。
- `getProjectRoot()` 使用已有 `resolveProjectRoot()`。
- `getContextUsage({ sessionId })` 如果 sessionId 可用，则通过 runtime/context manager 组装当前 usage；如果数据不足，返回 `null`。

`UiRuntimeComposition` 需要暴露最小方法：

```typescript
listMcpServerSummaries(): Promise<readonly CommandMcpServerSummary[]>;
getContextUsage(input: {
  readonly projectRoot: string;
  readonly sessionId: string;
}): Promise<ContextUsage>;
```

## TUI 最小格式化

`packages/ohbaby-cli/src/tui/store/events.ts` 只增加 data subject 的 readable formatting：

- `help`: 优先显示 `categories`，没有则回退 `commands` 或 JSON。
- `status`: 保留 `status/model`，追加 session、tools、skills、mcps、context、project。
- `mcps`: 显示 server name、status。
- `skills`: 显示 skill name、scope、source、description。

现有 `COMMAND_NOTICE_TEXT_LIMIT` 仍会截断长输出。本分支不修改通知窗口、分页、滚动或消息布局。

## 测试策略

使用 TDD：

1. 先写 catalog 和 service 失败测试。
2. 验证测试因命令或字段缺失而失败。
3. 实现最小代码让测试通过。
4. 补 TUI formatting 测试。
5. 跑 typecheck、相关 unit/contract/integration。
6. 使用 `.env` 中 API key，在当前进程中进行多次 e2e 或 smoke 验证。
7. 做子代理检查或独立复核。

验收标准：

- `/mcps` 和 alias `/mcp` 在 catalog 中存在，surface 为 `tui/stdout/headless`。
- `/skills` 在 catalog 中存在，surface 为 `tui/stdout/headless`。
- `/help` 输出同时包含 `commands` 和 `categories`。
- `/status` 输出保留旧字段，并包含 `tools`、`skillsCount`、`mcps`、`context`、`projectRoot`、`sessionId`。
- `/mcps` 只输出 server 状态，不输出具体 tools。
- `/skills` 输出 `scope` 必填、`source` 可选，不输出 `pluginId`。
- provider 缺失时命令不崩溃，使用空数组、0 计数或 `null`。
- TUI 对新 subject 的输出可读。
- 完成后不 commit，不 merge，等待用户审核。
