# 05 — Sessions UI 与后端优化确认设计

> 创建日期: 2026-06-09
> 状态: 已确认，实施中
> 来源: 基于 `01-current-state.md`、`02-optimization-plan.md`、`03-reference-projects.md`、`04-test-and-acceptance.md` 的讨论后对齐版

---

## 1. 设计结论

本次优化采用聚焦修复方案：保留现有 interaction broker 路径，重写 session 专属前端选择器，修复 ESC 取消错误，后端改为按当前 project 全量列出 active primary sessions，并在首条真实 user message 后进行临时标题与异步 AI 自动命名。

| # | 决策 | 确认方案 |
|---|------|----------|
| 1 | 前端架构 | 保留 interaction broker；`SessionDialog` 脱离 `SelectOneDialog`，改为 `OverlayCard` 卡片式列表 |
| 2 | Session 行样式 | 1 行：左侧 title，右侧 `updatedAt`；title 过长截断 |
| 3 | 排序 | 当前 project 内按 `updatedAt DESC, createdAt DESC` 从近到远 |
| 4 | 可见范围 | `/sessions` 显示当前 project 的全部 active primary sessions |
| 5 | 翻页 | `PgUp/PgDn` 每次跳 10 条；`↑/↓` 逐条移动 |
| 6 | ESC | 完全静默取消，不报错、不发 notice、不发 action、不改变 active session |
| 7 | Snapshot limit | 保留 `PersistentUiStateStore` 的 `DEFAULT_SESSION_LIMIT = 50`，不改为全量 |
| 8 | 自动命名 | 首条真实 user message 后：先写临时标题，再异步 AI 命名 |
| 9 | 临时标题 | 使用首条 user message 脱敏后截断 |
| 10 | AI 标题语言 | 跟随用户输入语言 |
| 11 | AI 模型 | 复用当前 active model/provider |
| 12 | AI maxTokens | 本次 title 请求使用 `maxTokens = 512`，长度主要由 system prompt 约束 |

---

## 2. 与原方案的调整点

本文件覆盖 `02-optimization-plan.md` 中以下初稿决策：

1. `SessionDialog` 仍为 1 行列表，但不是“只显示 session title”，而是“左 title + 右 updatedAt”。
2. 可见窗口行数使用 10，与 `SkillsPanel` 一致，而不是 8。
3. `/sessions` 的全量显示只针对当前 project 的 session metadata，不把 UI snapshot 的 50 条恢复上限改成无限。
4. ESC 取消后完全静默，不发 `session.selectionCancelled` action。
5. AI 命名不新增 small model 配置，第一版复用当前 active model/provider。
6. AI title 请求的 `maxTokens` 使用 512，不使用 30、40 或 64。
7. 自动命名触发点需要覆盖 `/new` 创建空 session 后的第一条 prompt，不只覆盖 `!session` 的即时创建分支。
8. 文档中的 `ui-inprocess.ts` 实际路径应为 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`。

---

## 3. 前端设计

### 3.1 组件边界

当前 `packages/ohbaby-cli/src/tui/dialogs/session-dialog.tsx` 只是 `SelectOneDialog` 的薄封装。优化后它应成为 session 专属选择器：

```
DialogManager
  -> interaction.kind === "select-one" && subject === "session"
  -> SessionDialog
     -> OverlayCard(title="Sessions")
        -> session rows
        -> optional footer
```

不改通用 `SelectOneDialog`，避免影响 model/generic select-one 交互。

### 3.2 视觉布局

示意：

```text
╭─ Sessions ───────────────────────── esc ╮
│ > 修复移动端登录按钮样式        06-09 14:32 │
│   Add OAuth authentication     06-08 21:10 │
│   New session                  06-07 18:04 │
│                                          │
│ showing 1-10 of 42 · pgup/pgdn · ↑↓      │
╰──────────────────────────────────────────╯
```

规则：

- 外层复用 `OverlayCard`，保持与 `/skills`、`/mcps`、`/connect` 的边框、宽度、标题栏一致。
- 每行左侧显示 session title，右侧显示 `updatedAt`。
- title 需要根据可用宽度截断，不能挤压右侧时间。
- 选中行使用 `> ` 前缀、accent 色、bold。
- 非选中行可 dim，但仍需可读。
- 空列表显示 `No sessions`，ESC 可关闭。

### 3.3 时间格式

右侧显示 `updatedAt`，建议使用短格式：

- 同一年：`MM-DD HH:mm`
- 跨年：`YYYY-MM-DD`

默认执行方案：第一版统一使用 `MM-DD HH:mm`。后续如果用户反馈跨年 sessions 不易识别，再升级为跨年显示 `YYYY-MM-DD`。实现时应保证格式宽度稳定，便于右对齐。

### 3.4 键盘行为

| 按键 | 行为 |
|------|------|
| `↑` | 选中项上移 1 条 |
| `↓` | 选中项下移 1 条 |
| `PgUp` | 选中项上移 10 条 |
| `PgDn` | 选中项下移 10 条 |
| `Enter` | 接受当前选中 session |
| `ESC` | 发送 cancelled response，后端静默取消 |

移动采用 clamp，不循环：

- 顶部继续 `↑` 不动
- 底部继续 `↓` 不动

### 3.5 分页窗口

常量：

```ts
const SESSION_VISIBLE_LINES = 10;
```

窗口计算：

```ts
const windowStart =
  Math.floor(selectedIndex / SESSION_VISIBLE_LINES) * SESSION_VISIBLE_LINES;
```

footer：

- 超过 10 条时显示：`showing {start}-{end} of {total} · pgup/pgdn · ↑↓`
- 不超过 10 条时可省略 footer，保持界面简洁。

---

## 4. Interaction 数据契约

SDK 的 `UiInteractionOption` 已支持：

```ts
interface UiInteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly metadata?: Record<string, unknown>;
}
```

因此不需要新增顶层 `updatedAt` 字段。实现时将 session 时间放进 metadata：

```ts
{
  id: session.id,
  label: session.title,
  metadata: {
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  },
}
```

需要同步补齐 CLI 本地类型：

- `packages/ohbaby-cli/src/tui/store/snapshot.ts`
  - `TuiInteractionOption` 增加 `metadata?: Record<string, unknown>`
  - 如有必要也补 `disabled?: boolean`
- `packages/ohbaby-cli/src/tui/store/events.ts`
  - `toTuiInteraction()` 保留 `interaction.options` 中的 metadata。

---

## 5. 后端 Session 查询设计

### 5.1 当前问题

当前 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 中 `listSessionsFromState()` 在有 `sessionManager` 时调用：

```ts
const sessions = await options.sessionManager.getRecent();
```

这存在三个问题：

1. `getRecent()` 是全局 recent，不保证只属于当前 project。
2. `SessionManager.getRecent()` 默认 limit 为 20。
3. 这与用户对 `/sessions` 的直觉不一致：ohbaby-agent 以 project root 启动，`/sessions` 应浏览当前 project 的会话。

### 5.2 新语义

`/sessions` 应只列出：

- 当前 project
- `status === "active"`
- `isSubagent === false`
- 全量 session metadata
- 按 `updatedAt DESC, createdAt DESC`

### 5.3 推荐实现

扩展 `InProcessUiBackendOptions.sessionManager` 的 Pick 类型，加入 `listByProject`：

```ts
readonly sessionManager?: Pick<
  SessionManager,
  "create" | "get" | "getRecent" | "listByProject" | "listByProjectRoot"
> & Partial<Pick<SessionManager, "findReusableEmptyPrimary" | "incrementStats">>;
```

`listSessionsFromState()` 新流程：

```ts
const projectRoot = await resolveProjectRoot();
const sessions = await options.sessionManager.listByProjectRoot(projectRoot, {
  status: "active",
});
return sessions
  .filter((session) => !session.isSubagent)
  .sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return right.createdAt - left.createdAt;
  })
  .map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }));
```

`CommandSessionSummary` 增加可选字段：

```ts
interface CommandSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly created?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}
```

`handleSessionParent()` 将 `createdAt/updatedAt` 写入 option metadata。

### 5.4 保留的上限

`PersistentUiStateStore` 的 `DEFAULT_SESSION_LIMIT = 50` 保留。

理由：

- UI snapshot 恢复的是 session + messages + runs，不只是 metadata。
- 启动时全量恢复所有历史消息会增加启动和渲染成本。
- `/sessions` 全量只需要当前 project 的 metadata，可以走单独查询通路。

`SessionManager.getRecent()` 默认 20 也可以暂时保留，作为全局 recent API；本次不再把它作为 `/sessions` 的数据源。

---

## 6. ESC 取消设计

当前 `handleSessionParent()` 对 cancelled response 调用 `context.fail()`，导致 `/sessions` ESC 后显示 `INTERACTION_CANCELLED`。

新行为：

```ts
if (response.kind === "cancelled") {
  return;
}
```

要求：

- 不调用 `context.fail()`
- 不发 `context.emitAction()`
- 不发 notice
- 不改变 active session
- 不影响再次打开 `/sessions`

其他异常仍应保留错误：

- accepted 但缺少 `choiceId`
- `choiceId` 不属于本次 options
- `selectSession()` 抛错

---

## 7. 自动命名设计

### 7.1 触发条件

在 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 的 prompt submit 路径中判断是否需要命名。

需要覆盖：

1. 用户直接发送首条 prompt，系统创建新 session。
2. 用户先执行 `/new` 创建空 session，再发送首条 prompt。

条件：

- session 是 primary session，不是 subagent。
- 当前提交的是该 session 的首条真实 user message。
- session title 仍是默认/未命名状态。
- 首条 user text 脱敏后非空。

默认/未命名 title 建议识别：

- `""`
- `"New session"`
- `"Untitled session"`
- 旧格式：`/^New session - \d{4}-\d{2}-\d{2}T/`

### 7.2 临时标题

首条 user text 先经过 sanitizer，再生成临时标题。

Sanitizer 参考 kimi-code：

- private key block -> `[redacted]`
- `Authorization: Bearer ...` -> `Authorization: Bearer [redacted]`
- `api_key/token/secret/password/passwd/pwd=...` -> `[redacted]`
- `sk-...` -> `[redacted]`
- 长随机 token -> `[redacted]`
- 控制字符替换为空格
- 连续空白压缩

临时标题规则：

- 从脱敏文本截断。
- 空文本 fallback 为 `"New session"`。
- 截断默认按终端可见宽度处理，避免中文标题过长或英文标题过短。
- 超长加 `...`，保持 ASCII。

### 7.3 AI 标题生成

新增：

- `packages/ohbaby-agent/src/services/session/title-generator.ts`
- `packages/ohbaby-agent/src/services/session/prompt-sanitizer.ts`

Title generator 复用当前 active model/provider：

- 使用 `streamChatCompletion()` 获取完整文本。
- 本次 title 请求使用 `maxTokens = 512`。
- 本次 title 请求使用 `temperature = 0.2`，但不改变全局 active model 配置。
- 5 秒超时，超时后静默放弃。
- 失败静默，保留临时标题。

由于 `streamChatCompletion()` 使用 `llmClient.config`，实现时可浅拷贝一个 title client：

```ts
const titleClient = {
  ...llmClient,
  config: {
    ...llmClient.config,
    maxTokens: 512,
    temperature: 0.2,
  },
};
```

### 7.4 System Prompt

Prompt 要明确约束标题语言和长度：

```text
Generate a concise session title for a coding-agent conversation.

Use the same language as the user's message:
- If the user message is Chinese, output Chinese.
- If the user message is English, output English.
- If the user message mixes languages, use the dominant language.

Length:
- English: 3-7 words.
- Chinese: about 8-18 Chinese characters.

Output only the title.
Do not add explanations, numbering, markdown, quotes, or JSON.
```

### 7.5 输出清理

AI 输出仍需代码兜底：

- 去除 `<think>...</think>`
- 去除 markdown fence
- 如果返回 JSON，尽量提取 `title`
- 去除外层引号
- 取第一行有效内容
- 压缩空白
- 超长截断到 80-100 字符

### 7.6 防覆盖

AI title 完成后再次读取 session。

只有满足以下条件才更新：

- session 仍存在
- session 仍是 primary session
- 当前 title 等于本次写入的临时标题，或仍是默认/未命名标题

否则放弃更新，防止未来手动重命名被后台任务覆盖。

---

## 8. 实施阶段建议

### Phase 1: ESC 静默修复

- 修改 `packages/ohbaby-agent/src/commands/builtin.ts`
- 更新 command service 相关测试
- 确认 `/sessions` ESC 不再产生 failed event

### Phase 2: 当前 project sessions 查询

- 修改 `CommandSessionSummary`
- 扩展 `InProcessUiBackendOptions.sessionManager` Pick 类型
- 修改 `listSessionsFromState()` 使用 `listByProject`
- `handleSessionParent()` 写入 metadata
- 增加当前 project/超过 50 条/跨 project 隔离测试

### Phase 3: SessionDialog 卡片化

- 重写 `packages/ohbaby-cli/src/tui/dialogs/session-dialog.tsx`
- 补 `TuiInteractionOption.metadata`
- 实现 title/time 一行布局、截断、PgUp/PgDn、footer
- 更新 TUI contract tests

### Phase 4: 临时标题与 AI 自动命名

- 新增 sanitizer
- 新增 title generator
- 在 `submitPromptInternal()` 首条 user message 路径触发
- 覆盖 `/new` 后首条 prompt
- 增加失败静默和防覆盖测试

### Phase 5: 回归验证

- `/sessions` 选择会话后正常切换
- `/sessions` ESC 后无错误，且再次打开正常
- `/resume <session-id>` 仍正常
- `/new` 创建空 session 后首条 prompt 会更新标题
- subagent sessions 不出现在 `/sessions`
- permission dialog 仍优先于 session dialog

---

## 9. 测试重点

| 类型 | 用例 |
|------|------|
| Unit | sanitizer 脱敏 private key/token/password |
| Unit | 临时 title 截断与空文本 fallback |
| Unit | AI 输出清理 think/json/quotes/markdown |
| Unit | title generator 超时/失败返回空 |
| Command service | `/sessions` cancelled 静默 return |
| Command service | invalid choice 仍 fail |
| Integration | 当前 project 150 条 active sessions 全量进入 interaction options |
| Integration | 其他 project sessions 不进入当前 `/sessions` |
| TUI contract | `SessionDialog` 使用 OverlayCard 风格 |
| TUI contract | title 左侧截断，updatedAt 右侧显示 |
| TUI contract | PgUp/PgDn 跳转后 Enter 选择正确 session |
| TUI contract | ESC 发送 cancelled response |
| Naming | 直接首条 prompt 创建 session 时写临时标题并触发 AI |
| Naming | `/new` 后首条 prompt 也触发临时标题和 AI |
| Naming | AI 完成前 title 被改动则不覆盖 |

---

## 10. 不做范围

本次不做：

- session 搜索
- session 日期分组
- session preview / last prompt 展示
- session 手动重命名
- session 删除
- session 归档前端入口
- archived sessions 浏览
- 全局 sessions 历史浏览器
- UI snapshot 全量恢复历史消息
- 独立 small/title model 配置

---

## 11. 用户审核点

当前确认版已有默认执行方案。用户审核时如需调整，重点关注：

1. `updatedAt` 默认显示 `MM-DD HH:mm`。
2. title 默认按可见宽度截断。
3. AI title 超时时间默认 5 秒。
4. AI title temperature 默认 0.2。
