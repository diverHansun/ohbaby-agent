# cli/commands 退役说明 architecture.md

本文档记录旧 `cli/commands` 架构的拆分去向。该目录不再描述活动代码结构。

---

## 一、Architecture Overview（总体架构）

旧结构：

```
Prompt input → cli/commands parser → backend commands → cli/commands renderer
```

新结构：

```
Prompt input
  │
  ├─ SDK parseSlashInput / resolveCommand
  │
  ├─ backend executeCommand
  │
  └─ surface renderer（TUI 或 stdout）
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

旧的 adapter 模式被移除。

**理由**：
- parser 是跨 surface 协议，属于 SDK。
- renderer 是 surface 私有体验，属于 TUI/stdout。
- command execution 是 backend 业务入口，属于 commands。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

不再建议创建以下文件：

```
src/cli/commands/
├── parser.ts
├── renderer.ts
├── interactive.ts
└── formatters/
```

如果实现中需要相关能力，应放入：

| 能力 | 位置 |
|------|------|
| parser/resolver | `packages/ohbaby-sdk/src/slash-command/` |
| command catalog/execution | `packages/ohbaby-agent/src/commands/` |
| TUI command runtime | `packages/ohbaby-cli/src/tui/` |
| stdout renderer | `packages/ohbaby-agent/src/cli/stdout-renderer.ts` |

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束: 不保留兼容 facade

**当前选择**：不提供 `executeSlashCommand()` facade。

**代价**：旧测试需要迁移。

**理由**：facade 会重新制造 UI/backend 耦合点。
