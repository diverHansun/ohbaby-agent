# Session View Reset: 文档自审记录

## 1. 自审范围

本次新增文档:

```text
docs/problem-lists/session-view-reset/00-index.md
docs/problem-lists/session-view-reset/01-current-problems-and-code-analysis.md
docs/problem-lists/session-view-reset/02-short-term-design-and-implementation-plan.md
docs/problem-lists/session-view-reset/03-related-files-code-blocks-and-packages.md
docs/problem-lists/session-view-reset/04-testing-acceptance-review.md
docs/problem-lists/session-view-reset/05-doc-self-review.md
```

目标:

- 聚焦短期稳定方案。
- 明确保留防闪烁路径。
- 把长期 `ManagedTranscriptViewport` 作为后续开发锚点，而不是本轮实现范围。

## 2. 一致性检查

### 2.1 与当前代码一致

已对照:

- `packages/ohbaby-cli/src/tui/app.tsx`
- `packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.tsx`
- `packages/ohbaby-cli/src/tui/store/transcript.ts`
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`
- `packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx`

文档以“待固化的短期方案”为审查基准。若工作区里已有 `resetTranscriptSurface()` 草案实现，应按本文检查它是否满足:

- 只在 session boundary 使用。
- existing session switch 必须在目标 snapshot 确认后再清理 terminal surface。
- streaming、prompt 编辑、spinner、runtime update 不走该路径。
- startup `clearOnStart` 保持首次 render 前的一次性 direct clear，不通过会推进 React state 的 helper。

### 2.2 与历史文档一致

已对照:

- `docs/ohbaby-cli/tui-improve-2`
- `docs/ohbaby-cli/tui-improve-3`
- `docs/ohbaby-cli/tui-improve-4`
- `docs/problem-lists/session-views`
- `docs/problem-lists/session-switch-regression`
- `docs/problem-lists/terminal-daemon`
- `docs/problem-lists/sessions-ui-backend`

本轮文档明确修正了旧假设:

```text
普通 session selection 不清屏
```

新的表述是:

```text
existing session selection 属于 session boundary，应在目标 snapshot 确认后清理 terminal surface。
```

### 2.3 与参考项目一致

已对照:

- Gemini CLI: `AppContainer.tsx:666-671` 的 `refreshStatic()` = clear terminal + remount Static；`MainContent.tsx:310-319` 用 `historyRemountKey` 驱动 `<Static>` remount。
- Kimi Code: `kimi-tui.ts:2069-2085` 的 `switchToSession()` = reset runtime + clear transcript + hydrate replay；`kimi-tui.ts:3522-3533` 清理 transcript/live/tool/spinner/container。
- Claude Code: `Messages.tsx:794-797` 把 `conversationId` 纳入 message key；`Messages.tsx:957-962` 使用 `VirtualMessageList`。
- opencode: `routes/session/index.tsx:129-136` 从 `route.sessionID` 派生 session/messages；`routes/session/index.tsx:1058-1066` 使用应用管理的 `scrollbox`。

短期方案借鉴 Gemini/Kimi，不强行引入 Claude/opencode 的长期架构。

## 3. Scope 检查

本轮文档范围内包含:

- session boundary 定义。
- terminal surface reset 原语。
- `/new`、fresh startup、`/sessions`、`/resume` 的短期处理。
- 防闪烁测试约束。
- 长期 renderer/viewport 锚点。

本轮文档范围外:

- 不修改代码。
- 不更新 package version。
- 不发布 npm。
- 不重构 daemon 协议。
- 不实现完整 virtual viewport。
- 不切换 alternate screen。

范围清晰，适合用户审核后进入代码实现计划。

## 4. 风险检查

### 风险 1: 清屏时机过早

如果 `/sessions` 在 `client.getSnapshot()` 成功前清屏，失败时用户会看到空白。

文档已要求:

- 目标 snapshot 确认后再清屏。
- 请求失败保持当前视图。

### 风险 2: 清屏路径误接入 streaming

如果 `message.part.delta`、spinner 或 prompt 编辑触发 clear，会把闪烁问题带回来。

文档已要求:

- session boundary 和 transcript delta 分离。
- 保留 flicker contract 测试。
- 新增 prompt 编辑不触发 clear 的 contract。

### 风险 3: 历史 session 被误判为 fresh session

如果 `/sessions` 切到历史 session 后显示 logo，会让用户以为历史丢失。

文档已要求:

- `/new` 和 fresh startup 才显示空会话 logo。
- existing session switch 不显示 fresh logo，应渲染目标历史 transcript。

### 风险 4: 多窗口隔离被重新破坏

如果为了解决显示问题改 daemon 全局 active session，可能导致一个窗口切换 session 时其他窗口跟着切。

文档已要求:

- 短期不重开 daemon 协议。
- 回归 `terminal-daemon`、`sessions-ui-backend`、`session-switch-regression`。

## 5. 开放决策

### 决策 1: helper 名称

推荐:

```text
resetTranscriptSurface()
```

理由:

- 比 `clearScreen()` 更准确。
- 它重置的是当前 session 的 transcript surface，而不是所有 UI 状态。

### 决策 2: 常量名迁移节奏

推荐:

```ts
export const SESSION_VIEW_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
export const NEW_SESSION_CLEAR_SEQUENCE = SESSION_VIEW_CLEAR_SEQUENCE;
```

理由:

- 新语义更清楚。
- 旧导出保留，降低测试和外部引用迁移成本。

### 决策 3: store replace 与 clear 的顺序

推荐实现时用测试锁定最终顺序。设计意图是:

```text
确认目标 snapshot
  -> clear terminal surface
  -> replace store with target snapshot
  -> bump screen generation / remount
```

如果实际 React/Ink 调度中出现一帧旧内容，需要把 clear、store replace、generation bump 收敛到同一个同步 helper，并通过 contract 测试固定输出顺序。

## 6. 审核建议

用户审核时建议重点看三点:

1. 是否认可“existing session selection 是 session boundary，应清理 terminal surface”。
2. 是否认可“短期不禁用 Static，而是只在 session boundary clear”。
3. 是否认可“长期 ManagedTranscriptViewport 暂时只作为锚点，不进入本轮代码实现”。

这三点确认后，就可以进入代码实现方案。

## 7. 本次复核记录

复核日期: 2026-06-15

复核结论: 文档职责拆分清晰，短期方案和长期锚点没有混在一起，可以进入用户审核。

已复核项目:

- 目录结构符合要求，文档放在 `docs/problem-lists/session-view-reset/` 下。
- `00-index.md` 只做索引和阅读顺序，不承载实现细节。
- `01-current-problems-and-code-analysis.md` 覆盖旧会话 transcript 残留、`<Static>` append-only 限制、以及不能回退防闪烁修复的根因。
- `02-short-term-design-and-implementation-plan.md` 聚焦短期“会话视图重置原语”，并明确 `/new`、fresh startup、`/sessions`、`/resume` 的边界。
- `03-related-files-code-blocks-and-packages.md` 已列出 ohbaby 受影响文件、Gemini/Kimi/Claude/opencode 参考锚点、以及 npm 包影响。
- `04-testing-acceptance-review.md` 覆盖 session switch、失败不清屏、快速切换、防闪烁、daemon/session backend 回归和发布前 smoke。
- 参考项目锚点已重新核对:
  - Gemini CLI: `refreshStatic()` 写 `ansiEscapes.clearTerminal` 并推进 `historyRemountKey`，`MainContent` 用该 key 重挂 `<Static>`。
  - Kimi Code: `switchToSession()` 先 reset runtime，再 clear transcript，最后 hydrate replay。
  - Claude Code: `conversationId` 进入 message key，`VirtualMessageList` 管理消息视图。
  - opencode: route/session id 驱动 session view，messages 从 `route.sessionID` 派生并渲染在应用管理的 `scrollbox` 中。

保留给用户重点判断的取舍:

- 短期方案会在 existing session switch 成功确认目标 snapshot 后清理 terminal surface，这会清掉当前终端 scrollback 中的旧会话显示内容。
- 短期方案不引入 managed viewport，不改变 daemon 协议，不新增依赖。
- 长期方案建议以 `ManagedTranscriptViewport`/route-scoped view 为独立后续工程，不混入本轮稳定修复。
