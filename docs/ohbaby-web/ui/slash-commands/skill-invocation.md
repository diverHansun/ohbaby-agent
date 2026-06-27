# ohbaby-web · Skill Invocation

> web 端 skill 的发现与执行规格。CLI 在顶层 `/` 浮层即可看到并选中每个 skill；web 刻意不在浮层 flood 全部 skill，改由 `/skills` 结果弹窗统一管理：弹窗内键盘导航选中、`Tab` 把 `/skill-name` 落入 composer，再按 `Enter` 真正执行。执行复用 daemon 既有的 skill 命令路径（`executeSkillCommand` → 加载 skill prompt → `submitPrompt`），与 CLI 同源。

---

## 1. Scope

本批做：

- **执行链路（Layer 1）**：让 `/skill-name` 能在 web 被解析并执行。
  - skill 命令以 `executionKind:"skill"` 进入 `GET /v1/commands?surface=web` 的 catalog，**仅供浏览器 resolve**。
  - `OhbabyWebClient.executeSlashCommand` 对「passthrough ∪ skill」目录 resolve `/skill-name`，发出 `skill.<name>` invocation。
  - `POST /v1/commands` 在既有 passthrough 校验之外，新增放行 skill 命令 invocation。
- **发现/插入 UI（Layer 2）**：把 `/skills` 只读结果弹窗改成键盘可导航。
  - `↑/↓`、`PageUp/PageDown` 在 skill 列表中选中，首尾 clamp。
  - `Tab`（及点击、`Enter`）把选中项的 `/skill-name ` 落入 composer 草稿并关闭弹窗。
  - composer 收到落入文本后聚焦输入框，用户可补参数后按 `Enter` 执行。

本批不做：

- 不在顶层 `/` slash 浮层展示 skill 候选（保持 web 浮层精简，不 flood）。
- 不给 skill 命令加 `web` surface（web 全程伪装 `tui`，surface 过滤天然通过，无需改 surface 标签）。
- 不改 skill 在 daemon 端的执行语义；web 与 CLI 走同一条 `executeSkillCommand` 路径。
- 不在 `/skills` 弹窗内直接执行 skill（`Enter` 也只落入+关闭，不直接跑），执行统一回到 composer。
- 不做 skill 参数表单、收藏/置顶、分组筛选、搜索框等增强。

---

## 2. Current State & Root Cause

当前问题不是 daemon 不会执行 skill，而是 Web 端在两个边界把 skill 命令排除了：

- `packages/ohbaby-agent/src/commands/service.ts` 已经把用户可调用 skill 转成 command：
  - `id:"skill.<name>"`；
  - `path:[<name>]`，因此用户输入形态是 `/<name>`；
  - `source:"skill"`；
  - `acceptsArguments:true`、`argumentMode:"raw"`；
  - `surfaces:["tui","stdout","headless"]`。
- 同一个文件里的 `executeSkillCommand` 已经能加载 skill prompt，并在有 `submitPrompt` 时把 prompt 注入当前 session。因此执行能力已经存在。
- CLI/TUI 的顶层 `/` 补全走 `packages/ohbaby-cli/src/tui/slash-commands/runtime.ts` 的完整 command catalog；`filterSdkCommandCatalog` 不会主动排除 `source:"skill"`，所以 skill 会像普通 slash command 一样出现并可执行。
- Web catalog 入口在 `packages/ohbaby-server/src/app/create-app.ts`：
  - `GET /v1/commands?surface=web` 先向 backend 要 `surface:"tui"` 的 catalog；
  - 再调用 `filterWebCommandCatalog`；
  - 当前 `filterWebCommandCatalog` 只收 builtin passthrough 和 overlay，不收 `source:"skill"`。
- 浏览器执行入口在 `apps/ohbaby-web/src/api/daemon/client.ts`：
  - `executeSlashCommand` 又把 Web catalog 过滤成 `filterWebPassthroughCommandCatalog` 后才 resolve；
  - 即使未来 GET catalog 含 skill，这里仍会把 skill 排掉。
- Web POST 网关在 `packages/ohbaby-server/src/app/create-app.ts`：
  - `POST /v1/commands` 只允许 `supportsWebPassthroughCommandInvocation`；
  - 手写 `skill.<name>` invocation 会被 `"command is not supported by web passthrough"` 拦截。
- `/skills` 结果 UI 在 `apps/ohbaby-web/src/ui/App.tsx` 的 `SkillsCommandResult`：
  - 目前只是静态列表；
  - 没有 `selectedIndex`、`PageUp/PageDown` 选中态；
  - 没有 `Tab`/点击把 `/<name> ` 写回 composer 的通道。
- `Composer` 目前只支持用户自己输入和 slash palette 补全，没有外部一次性 prefill。要让 `/skills` 弹窗把 skill 落入输入框，需要一个从 modal 到 composer 的状态通道。

结论：实施应复用 daemon 已有 skill command 语义，只打开 Web 端的“发现、解析、网关校验、插入 composer”四个缺口。不要把所有非 passthrough command 都放给 Web，也不要把 skill 直接做成 Web overlay。

---

## 3. Catalog & Execution Contract

> 本节修订 [structured-overlays.md](structured-overlays.md) 第 2 节：`POST /v1/commands` 此前「只接受 passthrough」，现扩展为「接受 passthrough **或** skill 命令」。overlay 仍只能走结构化 REST，interaction 命令仍被拒绝。

### 3.1 catalog 暴露（仅供 resolve）

- `filterWebCommandCatalog`（`ohbaby-sdk`）新增第三类分支：`command.source === "skill"` 的命令以
  `action:"executeCommand"`、`executionKind:"skill"` 收进 `UiWebCommandCatalog`。
- 现有 palette 展示过滤器 [`isWebPaletteCommand`](../../../../apps/ohbaby-web/src/ui/slashCommands.ts) **保持不变**：它对 `executeCommand` 且非 passthrough id 的命令返回 `false`，因此 `executionKind:"skill"` 不会进入顶层 `/` 浮层。catalog 含 skill 仅用于浏览器解析 `/skill-name`，不用于浮层展示。
- 每个 skill 返回项包含：`id`（`skill.<name>`）、`path`（`[<name>]`）、`description`、`argumentMode`（`raw`）、`category`（`skill`）、`source`（`skill`）、`executionKind:"skill"`、`action:"executeCommand"`。

### 3.2 浏览器解析与执行

- `executeSlashCommand` 不再只用 `filterWebPassthroughCommandCatalog`，而是对「passthrough ∪ skill」的 catalog 调用
  `resolveSlashCommand(catalog, parseSlashCommandInput(text), { surface: "tui" })`。
- 解析成功后照常 `POST /v1/commands`，invocation 带 `commandId:"skill.<name>"`、`surface:"tui"`、`rawArgs`（用户在 `/skill-name ` 之后输入的参数原文）。
- skill 命令 `acceptsArguments:true`、`argumentMode:"raw"`：`rawArgs` 透传到 daemon，由 `executeSkillCommand` 以 `User request:` 段拼接进 skill prompt。

### 3.3 服务端网关

- 新增 SDK helper `supportsWebSkillCommandInvocation(catalog, invocation)`：在 daemon 全量 catalog（`surface:"tui"`）中校验该命令存在、surface 可见、path 一致、`source === "skill"`。
- `POST /v1/commands` 网关改为：`supportsWebPassthroughCommandInvocation(...) || supportsWebSkillCommandInvocation(...)` 才放行，其余维持拒绝。
- 放行后照常 `backend.executeCommand(...)` → daemon 命中 `executeSkillCommand`：加载 skill prompt、`submitPrompt` 注入当前 session、发出 `skill.submitted` action。web 通过既有事件流看到 prompt 进入会话、agent 开始响应，无需 web 专属渲染。

---

## 4. `/skills` Navigable Result Modal

### 4.1 数据源

- 弹窗内容仍来自 `/skills` passthrough 的成功输出 `data.skills`（`{ name, description, source?, scope? }[]`），不另起请求。
- 展示路径 `/<name>`、描述、以及 `source`/`scope`，与现有只读渲染一致。

### 4.2 选中状态与键盘

- [`SkillsCommandResult`](../../../../apps/ohbaby-web/src/ui/App.tsx) 维护 `selectedIndex`，初始 `0`，渲染时高亮选中行。
- 键盘映射（弹窗打开且 skills variant 时生效）：

  | 键 | 行为 |
  |----|------|
  | `↑` / `↓` | 选中上/下一项，首尾 clamp |
  | `PageUp` / `PageDown` | 按固定步长（5）跳选，首尾 clamp |
  | `Tab` | 落入选中项并关闭弹窗（见 3.3）；`preventDefault` 阻止默认焦点切换 |
  | `Enter` | 同 `Tab`（落入+关闭，不直接执行） |
  | `Esc` | 关闭弹窗（沿用现有监听） |

- 鼠标点击某行 = 落入该行并关闭弹窗。
- skill 列表为空时回退现有 `FallbackCommandResult`，不进入导航态。

### 4.3 落入 composer 的通道

- `OhbabyWebApp` 持有一次性 `composerPrefill` 状态（含递增 `nonce`，保证重复选同一 skill 仍触发）。
- 落入动作：`onInsertSkill("/<name> ")` →
  1. `setComposerPrefill({ text, nonce })`；
  2. 把当前 `commandModalNotice.id` 加入 `closedCommandModalIds` 关闭弹窗。
- `onInsertSkill` 由 `OhbabyWebApp` 经 `CommandResultModal → CommandResultBody → SkillsCommandResult` 透传，仅 skills variant 使用。
- `Composer` 新增 `prefill` prop：`useEffect` 监听 `prefill.nonce` 变化 → `setDraft(prefill.text)`、清 `slashDismissedDraft`、聚焦 textarea、`slashIndex` 归零。
- 落入文本带尾随空格（`/hansun-db `），便于直接续打参数。落入后 `draft` 以 `/` 开头但匹配的是 skill 命令——`isWebPaletteCommand` 不展示 skill，故顶层浮层不会弹出；用户按 `Enter` 经 `executeSlashCommand` 解析执行。

---

## 5. End-to-End Flow

```
运行 /skills（passthrough）→ 成功 notice → CommandResultModal(skills) 打开
  ↑/↓ · PageUp/PageDown 选中
  Tab / Enter / 点击
    → onInsertSkill("/hansun-db ")
    → composerPrefill 更新 → Composer setDraft("/hansun-db ") 并聚焦
    → 关闭弹窗
用户（可选）补参数 → Enter
  → submitText("/hansun-db …") → executeSlashCommand
  → resolve（passthrough ∪ skill）成功 → POST /v1/commands { commandId:"skill.hansun-db", surface:"tui", rawArgs }
  → 服务端 supportsWebSkillCommandInvocation 放行
  → backend.executeCommand → executeSkillCommand → 加载 prompt → submitPrompt
  → 事件流：prompt 进入会话，agent 开始响应
```

---

## 6. Implementation Plan

### 6.1 SDK: web skill catalog and validation

Files:

- Modify: `packages/ohbaby-sdk/src/slash-command/web-passthrough.ts`
- Modify: `packages/ohbaby-sdk/src/slash-command/web-passthrough.unit.test.ts`
- Modify: `packages/ohbaby-sdk/src/index.ts`

Plan:

- Extend `UiWebCommandExecutionKind` from `"passthrough" | "overlay"` to `"passthrough" | "overlay" | "skill"`.
- Add `isWebSkillCommandSpec(command)`:
  - requires `command.source === "skill"`;
  - requires `command.path.length === 1`;
  - requires `command.argumentMode === "raw"`;
  - requires `command.acceptsArguments === true`;
  - requires visibility on requested surface.
- Update `filterWebCommandCatalog` to include skill specs as `{ action:"executeCommand", executionKind:"skill" }`.
- Keep `filterWebPassthroughCommandCatalog` unchanged, so legacy passthrough allowlist remains narrow.
- Add `supportsWebSkillCommandInvocation(catalog, invocation)`:
  - command id/path/surface must match backend catalog;
  - command must satisfy `isWebSkillCommandSpec`;
  - invocation `commandId` must be the catalog command id (`skill.<name>`), not raw `<name>`.
- Export the new helper and type behavior from `packages/ohbaby-sdk/src/index.ts`.
- Tests:
  - skill appears in `filterWebCommandCatalog`;
  - skill does not appear in `filterWebPassthroughCommandCatalog`;
  - spoofed builtin/plugin command at a skill-looking path is rejected;
  - valid skill invocation is supported;
  - wrong path, wrong source, wrong surface, and non-raw skill-like commands are rejected.

### 6.2 Server: allow only passthrough or skill on POST

Files:

- Modify: `packages/ohbaby-server/src/app/create-app.ts`
- Modify: `packages/ohbaby-server/src/app/create-app.unit.test.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts`

Plan:

- Import `supportsWebSkillCommandInvocation`.
- Keep `GET /v1/commands?surface=web` using `filterWebCommandCatalog`; after SDK change this will include skill commands in the catalog response.
- Change `POST /v1/commands` gate to:
  - allow `supportsWebPassthroughCommandInvocation(catalog, invocation)`;
  - or allow `supportsWebSkillCommandInvocation(catalog, invocation)`;
  - reject everything else with a message such as `"command is not supported by web command route"`.
- Keep overlay commands rejected through `POST /v1/commands`.
- Tests:
  - Web catalog includes `skill.<name>` with `executionKind:"skill"`;
  - valid skill invocation reaches `backend.executeCommand`;
  - `/new`, interaction commands, and overlay commands are still rejected.

### 6.3 Browser client: resolve passthrough plus skill

Files:

- Modify: `apps/ohbaby-web/src/api/daemon/client.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/client.integration.test.ts`

Plan:

- Stop resolving against `filterWebPassthroughCommandCatalog`.
- Resolve directly against the Web catalog returned by `listCommands()`, because that catalog already contains only Web-open commands: passthrough, overlay, and skill.
- Before POST, explicitly reject `executionKind:"overlay"` in `executeSlashCommand` with the existing behavior that overlay commands must be opened by UI, not raw submitted.
- For passthrough and skill, POST the resolved invocation as today.
- Tests:
  - `/status` still posts passthrough;
  - `/hansun-db 查 X` posts `commandId:"skill.hansun-db"`, `path:["hansun-db"]`, `rawArgs:"查 X"`, `argumentMode:"raw"`;
  - unknown `/missing-skill` throws `COMMAND_NOT_FOUND` and does not POST;
  - `/connect` still does not POST through `executeSlashCommand`.

### 6.4 Web UI: navigable `/skills` result and composer prefill

Files:

- Modify: `apps/ohbaby-web/src/ui/App.tsx`
- Modify: `apps/ohbaby-web/src/ui/slashCommands.ts`
- Modify: `apps/ohbaby-web/src/ui/styles.css`
- Modify: `apps/ohbaby-web/src/ui/App.unit.test.tsx`
- Modify: `apps/ohbaby-web/src/ui/slashCommands.unit.test.ts`

Plan:

- Add a tiny `ComposerPrefill` shape in `App.tsx`, e.g. `{ text: string; nonce: number }`.
- Hold `composerPrefill` state in `OhbabyWebApp`.
- Pass `prefill={composerPrefill}` to both main and empty-state `Composer` instances.
- Add `onInsertSkill(text)` to `CommandResultModal`, `CommandResultBody`, and `SkillsCommandResult`.
- In `onInsertSkill`:
  - set `composerPrefill` to `"/<name> "` with a fresh nonce;
  - close the current command result modal.
- In `Composer`:
  - keep a textarea ref;
  - on `prefill.nonce` change, `setDraft(prefill.text)`, reset slash dismissed/error/index state, and focus the textarea.
- In `SkillsCommandResult`:
  - derive valid rows with `isRecord` and a string `name`;
  - maintain selected index keyed by `notice.id`;
  - listen for `ArrowUp`, `ArrowDown`, `PageUp`, `PageDown`, `Tab`, `Enter`, and `Escape` while the modal is open;
  - `Tab` and `Enter` insert the selected skill, not execute it;
  - click row inserts the clicked skill;
  - empty list still falls back to `FallbackCommandResult`.
- Styling:
  - add selected row class for the skills list;
  - keep row height stable and text truncated so selection does not shift layout;
  - add visible focus/selected styling without turning the whole modal into a nested card.
- Tests:
  - top-level `/` palette excludes skill entries even though catalog contains them;
  - `/skills` modal renders selectable rows;
  - Arrow/Page keys clamp correctly;
  - `Tab` inserts `/<name> ` into composer and closes modal;
  - clicking a row inserts it;
  - repeated insertion of the same skill works because nonce changes.

### 6.5 Local verification and browser test

Commands:

- Targeted unit/integration:
  - `pnpm vitest run packages/ohbaby-sdk/src/slash-command/web-passthrough.unit.test.ts`
  - `pnpm vitest run packages/ohbaby-server/src/app/create-app.unit.test.ts`
  - `pnpm vitest run apps/ohbaby-web/src/api/daemon/client.integration.test.ts`
  - `pnpm vitest run apps/ohbaby-web/src/ui/slashCommands.unit.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx`
- Typecheck:
  - `pnpm run typecheck`
- Build Web assets:
  - `pnpm --filter ohbaby-web build`
- Local browser validation:
  - start daemon/web with the repo's existing serve command;
  - open the local URL in browser;
  - run `/skills`;
  - use `PageDown`/`PageUp` to move selection;
  - press `Tab` and verify `/<selected-skill> ` appears in composer;
  - append a short argument and press `Enter`;
  - verify network `POST /v1/commands` uses `commandId:"skill.<name>"`;
  - verify the session receives the skill prompt and the agent starts responding.

---

## 7. Testing

确定性测试：

- **SDK**：
  - `filterWebCommandCatalog` 把 `source:"skill"` 命令以 `executionKind:"skill"`、`action:"executeCommand"` 纳入 web catalog。
  - `supportsWebSkillCommandInvocation` 对合法 skill invocation 返回 `true`，对非 skill / surface 不符 / path 不符返回 `false`。
- **server**：
  - `GET /v1/commands?surface=web` 返回的 catalog 含 skill 项（`executionKind:"skill"`）。
  - `POST /v1/commands` 放行 skill invocation 并调用 `backend.executeCommand`；继续拒绝 overlay 与 interaction 命令。
- **web client**：`executeSlashCommand("/hansun-db 查 X")` 解析成功，POST body 为 `skill.hansun-db` 调用且 `rawArgs` 为 `查 X`；未知 `/skill-name` 仍抛 `COMMAND_NOT_FOUND`。
- **web UI**：
  - 回归：顶层 `/` 浮层候选**不含** skill（`createSlashPaletteItems` 不返回 skill 项）。
  - `/skills` 弹窗导航：`↓`/`PageDown` 移动选中并 clamp；`Tab` 落入 `/<name> ` 至 composer draft 并关闭弹窗；空列表回退 fallback。
  - `Composer` prefill：`nonce` 变化时 draft 被覆盖、textarea 聚焦。

E2E：

- deterministic：fake backend / `app.fetch` / headless browser，验证 `/skills` 弹窗导航 → `Tab` 落入 → `Enter` 命中 `POST /v1/commands` skill 调用 → 事件流更新。
- real-link：启动真实 `ohbaby serve --web-assets-dir apps/ohbaby-web/dist`，用项目 `.env` 中的 Zhipu `glm-4.7`，经浏览器 `/skills` 选一个 skill 落入并执行，验证 skill prompt 注入会话、agent 端到端响应。

---

## 8. Confirmation Checklist

实施前需要确认以下产品决策：

- Web 顶层 `/` palette 继续不展示全部 skill，只展示 `/skills` 入口。
- `/skills` modal 内 `Tab`、`Enter`、点击都只把 `/<skill> ` 落入 composer，不直接执行。
- `POST /v1/commands` 对 Web 只开放 passthrough 和 skill，overlay 仍必须走结构化 REST。
- Skill 命令继续伪装为 `surface:"tui"` 执行，不新增 `web` surface。
- Skill 参数继续使用 raw text，不在本批做参数 UI。
