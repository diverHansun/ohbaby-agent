# 02 — Sessions 优化方案与实施计划

> 创建日期: 2026-06-09
> 状态: 设计已确认，待实施

---

## 1. 设计决策汇总

| # | 决策 | 选择 |
|---|------|------|
| 1 | 前端架构 | 方案 B：保留 interaction broker 路径，SessionDialog 升级 OverlayCard 卡片式 UI |
| 2 | 卡片样式 | 1 行极简，只显示 session title |
| 3 | AI 命名触发 | 首条 user 消息发出后异步触发，小模型，不阻塞主流程 |
| 4 | Session 上限 | 全量显示，配合 PgUp/PgDn 翻页 |
| 5 | Title 语言 | 跟随用户输入语言（中文→中文，英文→英文） |
| 6 | 未命名展示 | 首条消息截断作为临时 title，AI 完成后替换 |

---

## 2. 前端优化方案

### 2.1 SessionDialog 重写

当前 `SessionDialog`（`session-dialog.tsx`）是 20 行的 SelectOneDialog 薄封装。重写为独立组件，使用 OverlayCard 包裹。

**新组件结构**：

```
SessionDialog
  └── OverlayCard (borderStyle="round", title="Sessions")
        ├── 标题栏: "Sessions" [esc]
        ├── 搜索栏（可选，后续迭代）
        ├── 会话列表（全量渲染，PgUp/PgDn 翻页）
        │     └── 每个 item: "> session title"  (1 行)
        └── 页脚: "Showing 1-10 of 42 sessions · pgup/pgdn"
```

**数据流不变**：仍然通过 `interaction.options` 接收 session 列表，选中后调用 `client.respondInteraction()` 返回 `choiceId`。

### 2.2 卡片式渲染

采用与 `OverlayCard` + `SkillsPanel` 一致的卡片模式：

- **圆角边框**：`borderStyle="round"`（与 skills/mcps/connect 一致）
- **宽度**：`Math.max(24, Math.min(88, layout.contentWidth))`
- **标题栏**：左 "Sessions"（bold, accent），右 "esc"（muted）
- **选中行高亮**：`> title` 前缀 + accent 色 + bold

### 2.3 PgUp/PgDn 翻页

参考 `SkillsPanel`（`command-panel-manager.tsx:263`）的实现模式：

- **可见窗口行数**：`SESSION_PAGE_SIZE = 8`（比 SelectOneDialog 的 6 略大）
- **PgUp**：向上跳 `SESSION_PAGE_SIZE` 条
- **PgDn**：向下跳 `SESSION_PAGE_SIZE` 条
- **窗口计算**：`windowStart = Math.floor(selectedIndex / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE`
- **页脚提示**：`Showing {start}-{end} of {total} sessions · pgup/pgdn · ↑↓`

键盘处理框架：

```ts
useInput((input, key) => {
  if (key.upArrow)    move(-1);
  if (key.downArrow)  move(1);
  if (key.pageUp)     move(-SESSION_PAGE_SIZE);
  if (key.pageDown)   move(SESSION_PAGE_SIZE);
  if (key.return)     confirm(selectedIndex);
  if (key.escape)     cancel();
});
```

### 2.4 ESC Bug 修复

**问题**：当前 `handleSessionParent` 中 `response.kind === "cancelled"` 时调用 `context.fail()`，导致前端显示错误。

**修复方案**：将 `context.fail()` 改为静默取消：

```ts
// builtin.ts handleSessionParent — L359-366 修改前:
if (response.kind === "cancelled") {
  context.fail({
    code: "INTERACTION_CANCELLED",
    message: `Session selection cancelled: ${response.reason}`,
    recoverable: true,
  });
  return;
}

// 修改后:
if (response.kind === "cancelled") {
  // 静默取消，不报错
  context.emitAction(action("session.selectionCancelled", {}));
  return;
}
```

或者检查 `CommandRunContext` 是否有 `cancel()` 或 `abort()` 方法，若无则使用空 action 事件。

---

## 3. 后端优化方案

### 3.1 AI 自动命名

#### 触发流程

```
用户发送首条消息
  → backend 记录消息
  → 检查是否为该 session 第一条 user 消息
  → 若是：异步启动 AI 命名线程
  → AI 线程：调用小模型生成 title
  → 更新 session.title
  → 发布 SessionEvent.Updated
```

#### 命名 Prompt 模板

参考 claude-code 的 prompt 设计：

```
Generate a concise title (3-7 words) that captures the main topic or goal of this conversation.
Use the same language as the user's message (Chinese for Chinese, English for English).

Output ONLY the title, no explanation.

Good examples:
"Fix login button on mobile"
"添加 OAuth 认证"
"优化数据库查询性能"
"Update dependencies to latest"
"重构用户模块接口"

User message:
{first_message_text}

Title:
```

#### 模型配置

- 使用 ohbaby-agent 的 LLM 配置系统中的小模型（与 title generation 场景匹配）
- 不阻塞主流程：使用 `Promise` 异步，失败不抛出、只 log
- 超时设置：5 秒，超时则放弃本次命名

#### 新文件

创建 `packages/ohbaby-agent/src/services/session/title-generator.ts`：

```ts
export interface TitleGenerator {
  generateTitle(firstUserMessage: string): Promise<string>;
}

export function createTitleGenerator(options: {
  llm: LLMInstance;
}): TitleGenerator {
  return {
    async generateTitle(firstUserMessage: string): Promise<string> {
      try {
        const result = await options.llm.complete({
          messages: [
            { role: "system", content: TITLE_PROMPT },
            { role: "user", content: firstUserMessage },
          ],
          maxTokens: 30,
          temperature: 0.3,
        });
        return cleanTitle(result);
      } catch {
        return ""; // 失败静默，保留临时标题
      }
    },
  };
}
```

#### 临时标题改进

修改 `ui-inprocess.ts:1062`，使用更合理的截断方案：

- 中文：截断前 16 个字符（约 5-6 个中文字）
- 英文：截断前 48 个字符（约 8-10 个英文词）
- 均以 "…" 结尾表示截断

### 3.2 Session 上限移除

#### 存储层

`persistent-store.ts` 修改：

```ts
// 移除前 (L34):
const DEFAULT_SESSION_LIMIT = 50;

// 修改后:
const DEFAULT_SESSION_LIMIT = 0; // 0 表示无上限
```

```ts
// readSessions 修改前 (L389-423):
options.sessionManager.getRecent(sessionLimit)

// readSessions 修改后:
options.sessionManager.getRecent(
  sessionLimit > 0 ? sessionLimit : undefined
)
```

#### 管理层

`manager.ts` 修改：

```ts
// getRecent 支持 undefined limit → 不限制:
getRecent(limit?: number): Promise<Session[]> {
  return options.store.getRecent(limit);
}
```

`database-store.ts` 修改 `getRecent` 实现，当 `limit` 为 `undefined` 时不添加 `LIMIT` 子句。

#### 统一命名逻辑

将三个命名点统一为一个入口：

1. 删除 `manager.ts:defaultTitle()` 的 ISO 时间戳
2. 修改 `createSessionRecord`：新 session 初始 title 为 `""` 或 `"New session"`
3. 删除 `ui-inprocess.ts:1062` 的 48 字符截断
4. 首条消息后统一调用 `TitleGenerator.generateTitle()`

---

## 4. 实施阶段

### Phase 1：ESC Bug 修复（优先级最高）

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1.1 | `builtin.ts:359-366` | 将 `context.fail()` 改为静默取消 |
| 1.2 | 验证 | 手动测试：打开 /sessions → 按 ESC → 无错误 |

### Phase 2：SessionDialog UI 升级

| 步骤 | 文件 | 操作 |
|------|------|------|
| 2.1 | `session-dialog.tsx` | 重写：OverlayCard + 自主渲染列表，替代 SelectOneDialog |
| 2.2 | `session-dialog.tsx` | 实现 PgUp/PgDn 翻页 |
| 2.3 | `session-dialog.tsx` | 实现卡片式渲染（1 行 title + 选中高亮） |
| 2.4 | 验证 | 视觉验收：与 skills/mcps 卡片风格一致 |

### Phase 3：Session 上限移除

| 步骤 | 文件 | 操作 |
|------|------|------|
| 3.1 | `persistent-store.ts` | `DEFAULT_SESSION_LIMIT` → 0（无上限） |
| 3.2 | `manager.ts` | `getRecent(limit?)` 支持 undefined |
| 3.3 | `database-store.ts` | 无 limit 时省略 LIMIT 子句 |

### Phase 4：AI 自动命名

| 步骤 | 文件 | 操作 |
|------|------|------|
| 4.1 | 新增 `title-generator.ts` | 创建 `TitleGenerator` 接口和实现 |
| 4.2 | `manager.ts` | `createSessionRecord` 初始 title 统一为 `"New session"` |
| 4.3 | `ui-inprocess.ts` | 首条消息后触发 `TitleGenerator.generateTitle()` |
| 4.4 | `ui-inprocess.ts` | 临时标题改为 "New session"（AI 完成前） |

### Phase 5：测试与验收

| 步骤 | 操作 |
|------|------|
| 5.1 | 单元测试：TitleGenerator mock 测试 |
| 5.2 | 集成测试：ESC 无错误、全量显示、PgUp/PgDn |
| 5.3 | 视觉验收：卡片风格一致性 |

---

## 5. 不做的事项（YAGNI）

- **搜索栏**：当前 session 数量通常不大，后续迭代再考虑
- **日期分组**（Today / Yesterday）：极简 1 行设计下信息密度不足
- **Session 预览**：resume 前预览消息历史 — 后续迭代
- **Session 重命名**：用户手动重命名 title — 后续迭代
- **Session 删除**：删除历史 session — 后续迭代
