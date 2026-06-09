# 01 — Sessions 前后端项目代码与设计现状

> 创建日期: 2026-06-09
> 状态: 已确认

---

## 1. 架构概览

Sessions 系统采用 **interaction broker** 模式：backend 发起 `select-one` interaction，frontend 作为被动响应方渲染对话并返回用户选择。

```
/sessions 命令
  → handleSessionParent() [backend/builtin.ts:340]
  → context.requestInteraction({ kind: "select-one", subject: "session" })
  → DialogManager [frontend/manager.tsx:46]
  → SessionDialog [frontend/session-dialog.tsx]
  → SelectOneDialog [frontend/select-one.tsx]
  → 用户选择后 respondInteraction(choice)
  → 回到 backend 完成 selectSession
```

---

## 2. 前端现状

### 2.1 关键文件

| 文件 | 路径 | 职责 |
|------|------|------|
| SessionDialog | `packages/ohbaby-cli/src/tui/dialogs/session-dialog.tsx` | 薄封装，转发给 SelectOneDialog |
| SelectOneDialog | `packages/ohbaby-cli/src/tui/dialogs/select-one.tsx` | 通用单选列表渲染+键盘导航 |
| OverlayCard | `packages/ohbaby-cli/src/tui/components/dialog/overlay-card.tsx` | 卡片容器（圆角边框、ESC 提示） |
| DialogManager | `packages/ohbaby-cli/src/tui/dialogs/manager.tsx` | 路由 `subject="session"` → SessionDialog |
| SkillsPanel | `packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.tsx:263` | PgUp/PgDn 翻页参考实现 |

### 2.2 当前 SessionDialog 渲染

`session-dialog.tsx` 仅 20 行，完全依赖 `SelectOneDialog`：

```tsx
export function SessionDialog({ client, interaction, title = "Session" }) {
  return <SelectOneDialog client={client} interaction={interaction} title={title} />;
}
```

`SelectOneDialog` 的渲染风格为 **简单数字列表**：

```
> 1. New session - 2026-06-09T12:00:00.000Z
  2. Fix login button on mobile
  3. Add OAuth authentication
  4. New session - 2026-06-08T09:30:00.000Z
  5. Refactor API client
  6. New session - 2026-06-07T15:00:00.000Z
```

- 每页显示 6 条（`SELECT_ONE_PAGE_SIZE = 6`）
- `>` 标记当前选中项
- 无卡片边框，无 OverlayCard 包裹
- 无 session ID 或其他元信息展示

### 2.3 键盘导航现状

`select-one.tsx:51-88`：

| 按键 | 行为 | 代码位置 |
|------|------|----------|
| ↑ / ↓ | 移动选中项 | L62-78 |
| Tab / ← / → | 循环移动 | L62-78 |
| PgUp | **无页脚提示**，且依赖 SelectOneDialog | L80-88 |
| PgDn | **无页脚提示**，且依赖 SelectOneDialog | L80-88 |
| 1-9 数字 | 直接跳转 | L51-59 |
| Enter | 确认选择 | L104-115 |
| ESC | 发送 cancelled 响应 | L90-101 |

**注意**：`select-one.tsx:80-88` 实现了 `key.pageUp` / `key.pageDown` 跳转逻辑（每次跳 `SELECT_ONE_PAGE_SIZE = 6` 条）。但本次优化将 SessionDialog 从 `SelectOneDialog` 中解耦（改用 OverlayCard），因此需在新 SessionDialog 中重新实现 PgUp/PgDn，同时增加页脚翻页提示（当前无任何 UI 提示用户可以 PgUp/PgDn）。

### 2.4 ESC Bug 分析

`select-one.tsx:90-101`：

```ts
if (key.escape) {
  setPending(true);
  void client
    .respondInteraction(interaction.interactionId, {
      kind: "cancelled",
      reason: "user-cancelled",
    })
    .catch((caught: unknown) => {
      setError(formatError(caught));
      setPending(false);
    });
  return;
}
```

ESC 发送 `{ kind: "cancelled" }` 给 backend。

Backend `builtin.ts:359-366` 收到 cancelled 后：

```ts
if (response.kind === "cancelled") {
  context.fail({
    code: "INTERACTION_CANCELLED",
    message: `Session selection cancelled: ${response.reason}`,
    recoverable: true,
  });
  return;
}
```

**问题本质**：`context.fail()` 将错误传播到 TUI 层，TUI 收到错误状态后尝试渲染错误信息，但由于不是通过 `CommandPanel` 路径（没有 OverlayCard 包裹），错误信息直接以 bare text 输出，用户看到 `INTERACTION_CANCELLED` 错误提示。正确的行为应该是：ESC 静默关闭对话，不产生任何错误。

**根因**：interaction broker 模式下，`cancelled` 是合法状态不应被视为 error。`handleSessionParent` 应改用非错误的取消处理方式（发送空操作或静默退出）。

### 2.5 无卡片式 UI 的问题

`/sessions` 与 `/skills`、`/mcps`、`/connect` 在视觉上不一致：

| 命令 | 渲染方式 | 有卡片边框 | ESC 行为 |
|------|----------|------------|----------|
| /skills | CommandPanel → SkillsPanel → OverlayCard | 有 | 关闭 panel |
| /mcps | CommandPanel → McpsPanel → OverlayCard | 有 | 关闭 panel |
| /connect | CommandPanel → ConnectPanel → OverlayCard | 有 | 关闭 panel |
| **/sessions** | Interaction → SelectOneDialog | **无** | **报错** |

`sessions` 不在 `DISPLAY_COMMAND_IDS` 或 `INTERACTIVE_COMMAND_IDS` 集合中（`command-panel-state.ts:40-50`），完全走另一条路径。

---

## 3. 后端现状

### 3.1 关键文件

| 文件 | 路径 | 职责 |
|------|------|------|
| handleSessionParent | `packages/ohbaby-agent/src/commands/builtin.ts:340-388` | /sessions 命令后端处理 |
| SessionManager | `packages/ohbaby-agent/src/services/session/manager.ts` | CRUD + 事件发布 |
| DatabaseStore | `packages/ohbaby-agent/src/services/session/database-store.ts` | SQLite 持久化 |
| Session types | `packages/ohbaby-agent/src/services/session/types.ts` | Session 接口定义 |
| PersistentUiStateStore | `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` | TUI 状态快照 |
| Schema | `packages/ohbaby-agent/src/services/database/schema.ts` | SQLite 表结构 |

### 3.2 Session 数据模型

`types.ts:10-23`：

```ts
interface Session {
  readonly id: string;            // UUID
  readonly projectId: string;     // 项目唯一 ID
  readonly projectRoot: string;   // 项目根目录路径
  readonly title: string;         // 会话标题
  readonly agentName: string;     // agent 名称
  readonly createdAt: number;     // 创建时间戳
  readonly updatedAt: number;     // 更新时间戳
  readonly status: SessionStatus;  // "active" | "archived"
  readonly stats: SessionStats;   // { messageCount, lastMessageAt? }
  readonly parentId?: string;     // 父 session ID (subagent)
  readonly childrenIds: string[]; // 子 session IDs
  readonly isSubagent: boolean;   // 是否子会话
}
```

SQLite schema（`schema.ts:9-22`）：`id`, `project_id`, `project_root`, `agent`, `parent_id`, `title`, `status`, `created_at`, `updated_at`, `message_count`, `last_message_at`, `data`。

### 3.3 Session 命名现状

**三个命名点，逻辑不统一**：

| 位置 | 文件 | 行号 | 命名逻辑 |
|------|------|------|----------|
| 默认创建 | `manager.ts` | L36-38 | `"New session - " + ISO timestamp` |
| /new 命令 | `ui-inprocess.ts` | L812 | 硬编码 `"New session"` |
| 首条消息后 | `ui-inprocess.ts` | L1062 | `text.trim().slice(0, 48) \|\| "Untitled session"` |

**问题**：
- 三个地方用三种不同方式命名，不一致
- 无 AI 自动命名 — `ui-inprocess.ts:1062` 只是简单截断首条消息前 48 字符，不经过任何模型
- 截断 48 字符在中文场景下可能只包含很少的语义信息（一个中文字约等于 3 字符）
- `manager.ts` 的 `defaultTitle()` 函数只被 create 使用，/new 命令则用自己的硬编码

### 3.4 Session 数量限制

**两层不一致的上限**：

| 层 | 文件 | 行号 | 值 | 含义 |
|----|------|------|-----|------|
| 存储层 | `persistent-store.ts` | L34, L369 | `50` | TUI 快照中加载的 session 数量上限 |
| 管理层 | `manager.ts` | L24 | `20` | `getRecent()` 的默认 limit |

**实际流程**（`persistent-store.ts:389-423`）：

```
readSessions()
  → sessionManager.getRecent(sessionLimit)  // 最多 50 条
  → .filter(isPrimarySession)                // 过滤掉子会话
  → 如果 activeSession 不在列表中，额外拉取
```

**问题**：
- 两个值不一致（50 vs 20），容易混淆
- 实际 `/sessions` 可见上限是 `DEFAULT_SESSION_LIMIT = 50`（通过 `readSessions`），但 manager 默认只有 20
- 存储层无限制（SQLite 持续写入），但查询有限制，历史 session 无法通过 UI 访问
- 全量显示需求未满足

### 3.5 Session 存储层

- **DatabaseStore**：SQLite，支持 transaction，upsert 写入
- **Store（in-memory）**：测试/headless 使用，同接口
- **ID 生成**：`createSessionId()` 函数，默认 UUID

---

## 4. 问题汇总

| # | 类别 | 问题 | 严重程度 |
|---|------|------|----------|
| 1 | 前端 | SessionDialog 无 OverlayCard 包裹，与 skills/mcps/connect 风格不一致 | 中 |
| 2 | 前端 | PgUp/PgDn 依赖 SelectOneDialog 实现，改为 OverlayCard 后需重新实现 | 中 |
| 3 | 前端 | ESC 关闭报 INTERACTION_CANCELLED 错误 | **高** |
| 4 | 后端 | 无 AI 自动命名，仅有截断 48 字符的简单方案 | 中 |
| 5 | 后端 | 命名逻辑分散三处，不统一 | 低 |
| 6 | 后端 | Session 上限 50/20 不一致，且未支持全量显示 | 中 |

---

## 5. 与相关模块的接口关系

```
SessionDialog  ──[interaction]──→  handleSessionParent  ──[store]──→  DatabaseStore
                                        │
                                        └──[manager]──→  SessionManager
                                                             │
                                    ┌────────────────────────┘
                                    ▼
                              SQLite (session 表)
```

SessionDialog 依赖 `TuiInteractionRequest` 接口（`snapshot.ts:53-60`）：

```ts
interface TuiInteractionRequest {
  readonly interactionId: string;
  readonly kind: "select-one" | "confirm";
  readonly subject?: string;
  readonly options: readonly { id: string; label: string }[];
  readonly prompt: string;
}
```
