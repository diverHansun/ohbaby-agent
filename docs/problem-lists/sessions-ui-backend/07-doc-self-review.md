# 07 — 文档自审记录

> 创建日期: 2026-06-09
> 状态: 已完成自审，等待用户审核

---

## 1. 自审范围

本次只审查并对齐 `docs/problem-lists/sessions-ui-backend/` 下的文档，不进入代码实现。

已重点核对：

- `/sessions` UI 是否为 OverlayCard 卡片式选择器。
- 行布局是否为 1 行：左侧 title，右侧 `updatedAt`。
- session 是否按 `updatedAt DESC, createdAt DESC` 排序。
- `/sessions` 数据范围是否为当前 project、`status === "active"`、primary sessions。
- PgUp/PgDn 是否每次跳 10 条，且边界 clamp。
- ESC 是否完全静默：不报错、不发 notice、不发 action、不改变 active session。
- UI snapshot `DEFAULT_SESSION_LIMIT = 50` 是否保留。
- `/sessions` 是否不再依赖 `getRecent()` 默认 limit。
- 自动命名是否为首条真实 user message 后先写临时标题，再异步 AI 命名。
- AI 命名是否复用当前 active model/provider。
- AI title 请求是否使用 `maxTokens = 512`，并主要通过 system prompt 限制输出长度。

---

## 2. 已修正文档口径

### 2.1 `02-optimization-plan.md`

已修正早期探索稿中的旧口径：

- 将“只显示 session title”改为“左 title + 右 `updatedAt`”。
- 将“AI 命名使用小模型”改为“复用当前 active model/provider”。
- 将 `maxTokens: 30` 改为 `maxTokens: 512`，`temperature` 改为 `0.2`。
- 将 PgUp/PgDn 可见窗口从 8 条改为 10 条。
- 将 ESC cancelled 后发 action 的方案改为完全静默 `return`。
- 删除“将 `DEFAULT_SESSION_LIMIT` 改为 0 / 改造 `getRecent(undefined)`”的实现方向。
- 改为 `/sessions` 走当前 project `listByProject(project.id, { status: "active" })`，过滤 subagent，并按 `updatedAt DESC, createdAt DESC` 排序。

### 2.2 `03-reference-projects.md`

已修正参考项目结论：

- opencode 的 `small: true` 仅作为参考项目事实保留，ohbaby 第一版不采用独立 small/title model。
- 当前 session 标记改为“不采用”。
- isDefaultTitle 结论改为“部分采用 guard 思路”，并覆盖 `""`、`"New session"`、`"Untitled session"`、旧 `New session - ISO` 格式。
- 页脚提示补齐为 `Showing {start}-{end} of {total} sessions · pgup/pgdn · ↑↓`。
- 防重复命名 guard 改为避免覆盖用户或其他流程改写的标题。

### 2.3 `04-test-and-acceptance.md`

已修正测试验收口径：

- 将“全量 session 加载”改为“当前 project active primary sessions 全量加载”。
- 删除 `sessionLimit = 0`、`store.getRecent(0)`、`getRecent(undefined)` 作为 `/sessions` 验证路径。
- 新增 snapshot limit 不影响 `/sessions` 的验收点。
- PgUp/PgDn 从 8 条改为 10 条。
- 页脚示例改为 `Showing 1-10 of 42 sessions · pgup/pgdn · ↑↓`。

---

## 3. 自审命令

执行过以下检查：

```bash
rg -n 'maxTokens: 30|maxTokens: 40|maxTokens: 64|maxTokens = 30|maxTokens = 40|maxTokens = 64|sessionLimit = 0|limit = 0|DEFAULT_SESSION_LIMIT\s*=\s*0|getRecent\(undefined\)|store\.getRecent\(0\)|8 条|Showing 1-8|context\.emitAction\(|session\.selectionCancelled.*action' docs/problem-lists/sessions-ui-backend --glob '!07-doc-self-review.md'

rg -n 'updatedAt|PgUp|PgDn|status === "active"|listByProject|current project|当前 project|ESC|512|active model|首条消息截断|临时标题|archived' docs/problem-lists/sessions-ui-backend --glob '!07-doc-self-review.md'

git diff --check -- docs/problem-lists/sessions-ui-backend
```

结论：

- 未发现 `maxTokens: 30/40/64` 的最终方案残留。
- 未发现 `sessionLimit = 0`、`getRecent(undefined)` 或 `store.getRecent(0)` 作为 `/sessions` 最终实现路径的残留。
- `small: true` / `小模型` 仅出现在参考项目事实或“ohbaby 不新增 small/title model 配置”的最终说明中。
- `context.emitAction` / `session.selectionCancelled` 仅出现在“不得发送”的最终说明中。
- `git diff --check` 仅提示 CRLF 规范化 warning，未报告空白错误。

---

## 4. 当前待审核结论

文档已统一到以下最终方案：

- `/sessions` 使用专属卡片式 `SessionDialog`。
- 一行显示：左 title，右 `updatedAt`，title 过长截断。
- 当前 project 内按 `updatedAt DESC, createdAt DESC` 从近到远显示。
- 默认只显示 `status === "active"` 且非 subagent 的 sessions。
- 显示全部匹配 metadata，不改 snapshot 50 条恢复上限。
- PgUp/PgDn 每次跳 10 条。
- ESC 完全静默。
- 首条真实 user message 后写临时标题，并异步 AI 自动命名。
- AI 命名复用当前 active model/provider，title 请求 `maxTokens = 512`，由 system prompt 约束短输出。

---

## 5. 等待用户审核

请重点审核：

- `05-confirmed-design.md` 是否准确表达你的最终产品决策。
- `06-implementation-plan.md` 是否可以作为后续 TDD 实施计划。
- 本自审记录列出的“已修正文档口径”是否符合你的预期。
