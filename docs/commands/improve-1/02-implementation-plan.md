# 02 · 实施方案与计划

> Commands 模块改进 · 执行篇  
> 日期: 2026-05-31  
> 版本: v2 (confirmed)

---

## 1. 实施口径

本分支只处理启动后的 slash command 契约，不处理 CLI 启动命令、yargs、`ohbaby run`，也不迁移 `packages/ohbaby-agent/src/cli`。

- 启动前子命令由后续 CLI 分支使用 yargs 解析。
- 启动后的 slash command 由 SDK `parseSlashInput` / `resolveCommand` 作为唯一权威语义。
- `ohbaby-cli` TUI 只做输入、补全、选择和渲染，不维护独立 resolver。
- 单活动 LLM config writer 与 `services/interface-providers` 重命名已在上一分支完成，本分支只消费模型摘要契约。

确认后的可见命令为 9 条：

```typescript
[
  "status",
  "exit",
  "help",
  "models",
  "sessions",
  "new",
  "compact",
  "resume",
  "permission",
]
```

明确不注册：

- `/model`、`/model list`、`/model current`
- `/session`、`/session new`、`/session compact`、`/session resume`
- `/permission default`、`/permission full-access`
- `/tools`、`/abort`

`permission.toggle-mode` 仅作为隐藏 handler 保留，由 Shift+Tab 触发，不进入 catalog。

---

## 2. Phase 1: SDK Resolver 成为唯一权威

### 目标

- `UiCommandSpec` 增加可选 `title`，供 TUI/Web/App 复用。
- `resolveCommand()` 支持 surface 过滤。
- `resolveCommand()` 使用严格 argv 语义：只有 `acceptsArguments: true` 的命令可以接收额外 token。
- 保留 alias、最长 path 优先和 raw args 计算。

### 文件

- `packages/ohbaby-sdk/src/command/types.ts`
- `packages/ohbaby-sdk/src/command/resolve.ts`
- `packages/ohbaby-sdk/src/command/parse.unit.test.ts`
- `packages/ohbaby-sdk/src/command/resolve.unit.test.ts`

### 验收

- `/models` 可解析为 `models`。
- `/models gpt-5.5` 被拒绝。
- surface 不匹配时返回 `COMMAND_NOT_AVAILABLE_ON_SURFACE`。
- `/session ...`、`/permission full-access` 等旧命令不可解析。

---

## 3. Phase 2: 后端 Catalog 与 Handler 收敛

### 目标

- `BUILTIN_COMMANDS` 改为 9 条可见命令。
- 每条可见命令必须有非空 `title`。
- 新增 `/help` handler，输出当前 surface 的可用 catalog。
- `/status` 输出运行状态，并可携带当前模型摘要与模型列表。
- `/models` 输出 `models.current`，包含 `current`、`models` 和 `switching`。
- `/permission` 通过 TUI interaction 选择 `default` / `full-access`，不注册权限子命令。
- session 系命令扁平化为 `/sessions`、`/new`、`/compact`、`/resume`。

### 文件

- `packages/ohbaby-agent/src/commands/catalog.ts`
- `packages/ohbaby-agent/src/commands/builtin.ts`
- `packages/ohbaby-agent/src/commands/service.ts`
- `packages/ohbaby-agent/src/commands/types.ts`
- `packages/ohbaby-agent/src/commands/catalog.unit.test.ts`
- `packages/ohbaby-agent/src/commands/service.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

### `/models` 输出契约

```typescript
{
  kind: "data",
  subject: "models.current",
  data: {
    current: ActiveModelSummary | null,
    models: ActiveModelSummary[],
    switching: {
      mode: "single-active-config",
      available: boolean
    }
  }
}
```

模型摘要可以包含 `apiKeyEnv`，不得包含 API key 值。

Catalog 合并动态命令时必须过滤保留路径：外部 extra command 或 skill command 不允许重新暴露 `/model`、`/session`、`/tools`、`/abort`、`/cancel`、`/mode`，也不允许暴露 `/permission/default` 或 `/permission/full-access`。模型输出采用白名单投影，只允许输出模型摘要字段。

---

## 4. Phase 3: TUI 命令类型收敛为 SDK 类型

### 目标

- `TuiCommandSpec` 改为 `UiCommandSpec` 的类型别名。
- `TuiCommandCatalog` 扩展 SDK `UiCommandCatalog`，仅额外保留 TUI 内部的 `loadedAt` / `surface` 元数据。
- TUI mock catalog 补齐 SDK 必填字段：`category`、`argumentMode`、`source`、`surfaces`。

### 文件

- `packages/ohbaby-cli/src/tui/store/snapshot.ts`
- `packages/ohbaby-cli/src/tui/store/events.ts`
- `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

---

## 5. Phase 4: TUI Runtime 改为 SDK Thin Wrapper

### 目标

删除 TUI 自己的 tokenizer、path 推断、resolver、candidate ranking，只保留调用方兼容所需的薄包装：

- `parseSlashInput(input)` 直接调用 SDK。
- `resolveCommand(parsed, catalog, options)` 调整参数顺序后调用 SDK。
- `filterCommandCatalog(parsed, catalog, options)` 从 parsed 中取 raw input 后调用 SDK。
- `applySlashCompletion()` 基于 SDK filter 结果实现。

### 文件

- `packages/ohbaby-cli/src/tui/command/runtime.ts`
- `packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts`
- `packages/ohbaby-cli/src/tui/command/completions.ts`
- `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`

---

## 6. 验证命令

```powershell
pnpm exec vitest run packages/ohbaby-sdk/src/command/parse.unit.test.ts packages/ohbaby-sdk/src/command/resolve.unit.test.ts packages/ohbaby-agent/src/commands/catalog.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm run typecheck
```

---

## 7. 后续分支

- CLI 分支：yargs、启动命令、默认进入 TUI、`packages/ohbaby-agent/src/cli` 迁移到 `ohbaby-cli`。
- TUI 模型配置分支：`/models` 表单中新增/修改 provider、baseUrl、apiKeyEnv、model name，并调用单活动模型配置写回能力。
