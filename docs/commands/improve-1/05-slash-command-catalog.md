# 05 · Slash 命令目录

> Commands 模块改进 · 命令清单篇  
> 日期: 2026-05-31  
> 版本: v3 (confirmed)

---

## 1. 设计原则

启动前的子命令由后续 CLI 分支使用 yargs 解析；启动后的 slash command 由 SDK resolver 统一解析。`ohbaby-cli` TUI 只负责输入、补全、选择和渲染，不再维护一套独立命令语义。

命令目录遵循 KISS：常用动作尽量扁平化，命令名直接表达语义。

- `/new` = 创建新会话，不是 `/session new`
- `/compact` = 压缩会话，不是 `/session compact`
- `/resume` = 恢复会话，不是 `/session resume`
- `/sessions` = 浏览/选择会话，不是 `/session`
- `/models` = 当前单活动模型入口，不是 `/model`
- `/permission` = 权限入口，不注册 `/permission default` 或 `/permission full-access`

`/models` 和 `/permission` 的具体选择动作由 TUI 交互完成；commands 模块只提供 catalog、handler、事件输出和后端契约。

---

## 2. 优化后命令清单

### SYSTEM 类

| # | 命令 | 别名 | 分类 | 描述 | TUI 行为 | 非 TUI 行为 |
|---|------|------|------|------|----------|-------------|
| 1 | `/status` | - | system | Show backend status | 展示运行时状态，可携带当前模型摘要 | 同 |
| 2 | `/exit` | `quit`, `q` | system | Exit the current UI surface | 退出 TUI | 退出进程 |
| 3 | `/help` | `?` | system | List available commands | 展示当前 surface 可用命令 | 同 |

### MODEL 类

| # | 命令 | 别名 | 分类 | 描述 | TUI 行为 | 非 TUI 行为 |
|---|------|------|------|------|----------|-------------|
| 4 | `/models` | - | model | Show and switch the active model | 打开模型入口；展示当前单活动模型与可读模型列表；后续 TUI 表单调用切换契约 | 输出当前模型与列表 |

### SESSION 类

| # | 命令 | 别名 | 分类 | 描述 | TUI 行为 | 非 TUI 行为 |
|---|------|------|------|------|----------|-------------|
| 5 | `/sessions` | - | session | Browse and switch sessions | 弹出会话选择器 | 列出会话 |
| 6 | `/new` | - | session | Start a new session | 创建并切换到新会话 | 同 |
| 7 | `/compact` | - | session | Compact the current session context | 压缩上下文，接受 `--force` 和 `--session_id` | 同 |
| 8 | `/resume` | - | session | Resume a session | 按 `--session_id <id>` 或首个位置参数恢复会话 | 同 |

### PERMISSION 类

| # | 命令 | 别名 | 分类 | 描述 | TUI 行为 | 非 TUI 行为 |
|---|------|------|------|------|----------|-------------|
| 9 | `/permission` | - | permission | Choose the permission level | 弹出 default/full-access 选择器 | 展示当前权限 |

### 隐藏命令

| 命令 ID | 触发方式 | 行为 |
|---------|----------|------|
| `permission.toggle-mode` | Shift+Tab | 在 plan / auto 模式间切换 |

`permission.toggle-mode` 不进入 catalog，只保留 handler，避免用户通过 slash command 看到或调用它。

---

## 3. 与旧命令对比

| 旧命令 | 新命令 | 变更 |
|--------|--------|------|
| `/status` | `/status` | 保留；可包含当前模型摘要 |
| `/tools` | - | 删除可见命令 |
| `/abort` / `/cancel` | - | 删除可见命令；Ctrl+C 继续负责中断 |
| `/exit` / `/quit` / `/q` | `/exit` / `/quit` / `/q` | 保留 |
| - | `/help` / `/?` | 新增 |
| `/model` | `/models` | 改为复数；当前单活动模型入口 |
| `/model list` | `/models` | 合并到 `/models` 输出 |
| `/model current` | `/models` 或 `/status` | 合并 |
| `/session` | `/sessions` | 复数化，语义更准 |
| `/session new` / `/new` | `/new` | 扁平化 |
| `/session compact` / `/compact` | `/compact` | 扁平化 |
| `/session resume` / `/resume` | `/resume` | 扁平化 |
| `/permission` | `/permission` | 保留为唯一权限入口 |
| `/permission default` | - | 不注册；TUI 内由 `/permission` 选择 |
| `/permission full-access` | - | 不注册；TUI 内由 `/permission` 选择 |

---

## 4. Catalog 目标形态

`BUILTIN_COMMANDS` 中的可见命令应为 9 条：

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

每条命令必须包含非空 `title`，供 TUI completion/hint 和未来 Web/App 复用。

目标定义摘要：

```typescript
const COMMON_SURFACES = ["tui", "stdout", "headless"] as const;

const BUILTIN_COMMANDS = [
  { id: "status", path: ["status"], title: "Agent Status" },
  { id: "exit", path: ["exit"], aliases: [["quit"], ["q"]], title: "Exit" },
  { id: "help", path: ["help"], aliases: [["?"]], title: "Help" },
  { id: "models", path: ["models"], title: "Models", parentBehavior: "interaction" },
  { id: "sessions", path: ["sessions"], title: "Sessions", parentBehavior: "interaction" },
  { id: "new", path: ["new"], title: "New Session" },
  { id: "compact", path: ["compact"], title: "Compact Session", acceptsArguments: true },
  { id: "resume", path: ["resume"], title: "Resume Session", acceptsArguments: true },
  { id: "permission", path: ["permission"], title: "Permission Level", parentBehavior: "interaction" },
];
```

完整对象仍需保留 `description`、`category`、`argumentMode`、`source`、`surfaces`、`argsHint` 等 SDK 字段。

---

## 5. Handler 语义

- `status`: 输出 `status`，并尽量附带当前模型摘要，但不得泄露 API key。
- `help`: 输出当前 surface 可用命令列表；不列出 hidden handler。
- `models`: 输出 `models.current`，包含 `current`、`models` 和 `switching`。`switching.mode` 为 `single-active-config`；若后端提供 `switchModel` 则 `available: true`。
- `sessions`: TUI 中请求 `select-one` 交互；非 TUI 输出 `session.list`。
- `new`: 创建并选择新会话。
- `compact`: 调用 compact provider。
- `resume`: 必须带 session id；缺失时报 `SESSION_ID_REQUIRED`。
- `permission`: TUI 中请求 default/full-access 选择；非 TUI 输出当前权限。
- `permission.toggle-mode`: 仅 handler，不进 catalog。

动态命令合并时，外部 extra command 和 skill command 不能复用已删除或保留的根路径，例如 `/model`、`/session`、`/tools`、`/abort`、`/cancel`、`/mode`，也不能复用 `/permission/default` 或 `/permission/full-access`。

---

## 6. 验收重点

- SDK `resolveCommand` 是唯一权威语义：支持 surface 过滤、严格 argv、alias、长路径优先。
- `ohbaby-cli` TUI command runtime 只做 SDK wrapper，不保留独立 resolver 实现。
- `TuiCommandSpec` / `TuiCommandCatalog` 影子类型删除或收敛为 SDK 类型，不再漂移。
- `/models`、`/sessions`、`/new`、`/compact`、`/resume`、`/permission` 可解析并执行。
- `/model`、`/model list`、`/model current`、`/session`、`/session new`、`/permission default`、`/permission full-access`、`/tools`、`/abort` 不再作为可见 catalog 命令解析。
- commands 分支不做 CLI yargs、不迁移 `packages/ohbaby-agent/src/cli`，不实现完整 TUI 模型配置表单。
