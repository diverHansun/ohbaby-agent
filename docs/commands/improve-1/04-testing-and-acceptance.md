# 04 · 测试与验收标准

> Commands 模块改进 · 验证篇  
> 日期: 2026-05-31  
> 版本: v2 (confirmed)

---

## 1. 范围

本分支验收对象是启动后的 slash command 契约：

- SDK parser/resolver。
- 后端 command catalog、handler、service。
- in-process UI backend 的 command 桥接。
- `ohbaby-cli` TUI command runtime、补全、渲染。

不验收：

- CLI 启动级 yargs 子命令。
- `ohbaby run` 或非交互入口语法。
- `packages/ohbaby-agent/src/cli` 迁移。
- 完整 `/models` TUI 配置表单。

---

## 2. 命令目录验收

可见 catalog 必须只包含以下内置命令：

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

必须满足：

- 每条可见命令有非空 `title`。
- `/models` 使用复数，不存在 `/model`。
- `/permission` 是唯一可见权限入口，不存在 `/permission default` 或 `/permission full-access`。
- `permission.toggle-mode` 只能作为隐藏 handler，由 Shift+Tab 调用，不进入 catalog。
- `/tools`、`/abort` 不再作为可见命令暴露。
- 外部 extra command 和 skill command 不得通过动态 catalog 重新暴露保留根命令或权限子命令。

---

## 3. 自动化测试

### SDK

| 文件 | 验收点 |
|------|--------|
| `packages/ohbaby-sdk/src/command/parse.unit.test.ts` | slash input 解析、quoted argv、raw args |
| `packages/ohbaby-sdk/src/command/resolve.unit.test.ts` | `/models`、surface 过滤、严格 argv、alias、旧命令拒绝 |

### Agent Commands

| 文件 | 验收点 |
|------|--------|
| `packages/ohbaby-agent/src/commands/catalog.unit.test.ts` | 9 条命令、title、旧命令不暴露、surface 过滤 |
| `packages/ohbaby-agent/src/commands/service.unit.test.ts` | `/status`、`/help`、`/models`、session 扁平命令、`/permission` interaction、hidden toggle |

### TUI / Bridge

| 文件 | 验收点 |
|------|--------|
| `packages/ohbaby-cli/src/tui/slash-commands/runtime.unit.test.ts` | TUI runtime 只做 SDK thin wrapper |
| `packages/ohbaby-cli/src/tui/store/events.unit.test.ts` | `/status` 与 `/models` 的人类可读 notice |
| `packages/ohbaby-cli/src/tui/app.contract.test.tsx` | TUI 输入、补全、执行、旧权限子命令拒绝 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` | command catalog、`/models` 模型摘要、session interaction、permission interaction |

推荐执行：

```powershell
pnpm exec vitest run packages/ohbaby-sdk/src/command/parse.unit.test.ts packages/ohbaby-sdk/src/command/resolve.unit.test.ts packages/ohbaby-agent/src/commands/catalog.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-cli/src/tui/slash-commands/runtime.unit.test.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm run typecheck
```

---

## 4. 关键行为验收

### 应成功

- `/status` 输出 `status`，并可附带当前模型摘要。
- `/help` 输出当前 surface 可用命令。
- `/models` 输出当前单活动模型、模型列表和 `switching` 元信息。
- `/sessions` 在 TUI 中打开 session 选择 interaction；非 TUI 输出 `session.list`。
- `/new` 创建并切换到新会话。
- `/compact` 调用 compact provider。
- `/resume --session_id <id>` 或 `/resume <id>` 切换会话。
- `/resume --session_id --force` 视为缺失 session id，返回 `SESSION_ID_REQUIRED`。
- `/permission` 在 TUI 中打开 default/full-access 选择 interaction。
- Shift+Tab 触发 `permission.toggle-mode`。

### 应拒绝

- `/model`
- `/model list`
- `/model current`
- `/session`
- `/session new`
- `/session compact`
- `/session resume`
- `/permission default`
- `/permission full-access`
- `/tools`
- `/abort`

---

## 5. 手动验收建议

进入 TUI 后：

- 输入 `/`，候选列表只显示当前 catalog 的可见命令。
- 输入 `/mod`，应匹配 `/models`。
- 输入 `/models`，应看到当前模型摘要输出。
- 输入 `/permission`，应出现 default/full-access 选择。
- 输入 `/permission full-access`，应显示未知命令，不应直接切换权限。
- 输入 `/sessions`，应出现 session 选择。
- 输入 `/new`，应创建新会话。
- 输入 `/resume <id>`，应恢复指定会话。
- 普通文本不以 `/` 开头时，应作为 prompt 提交。

---

## 6. 回归验收

- 普通 prompt 提交不受影响。
- 模型摘要允许展示 `apiKeyEnv`，但不得输出真实 API key 字段或值。
- 流式输出 `message.part.delta` 不受影响。
- 权限请求弹窗不受影响。
- Ctrl+C abort 不受影响。
- skill 动态命令不受影响。
- `command.catalog.updated` 后 catalog 可重新加载。

---

## 7. 审查检查

```powershell
rg "permission\.default|permission\.full-access|model\.list|model\.current|session\.new|session\.compact|session\.resume" packages/ohbaby-agent/src/commands packages/ohbaby-cli/src/tui
rg "function tokenizeCommandLine|function inferDisplayPathLength|function findExactCommand" packages/ohbaby-cli/src/tui/slash-commands/runtime.ts
```

第一条只允许出现在测试中的“旧命令拒绝”断言里；第二条应无结果。
