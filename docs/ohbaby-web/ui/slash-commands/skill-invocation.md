# ohbaby-web · Skill Invocation

> 当前权威规格。Layer 1/2 已由 `b5e00f4` 落地：CLI 在顶层 `/` 浮层可选单个 skill；Web 刻意不 flood，改由 `/skills` 结果弹窗统一发现，再把 `/<skill-name> ` 落入 composer 执行。`improve-1` 在此基础上落地 input-only alias `/skill`、真实 hover/keyboard 选中、`scope · source` metadata、shared command eligibility projection 与 no-args palette 布局。

---

## 1. Current Contract & Scope

已落地的当前合同：

- **执行链路（Layer 1）**：`/<skill-name>` 能在 Web 被 catalog 解析并执行。
  - skill 命令以 `executionKind:"skill"` 进入 `GET /v1/commands?surface=web` 的 catalog，**仅供浏览器 resolve**。
  - `OhbabyWebRuntime.executeSlashCommand` 对「passthrough ∪ skill」目录 resolve，再由 SDK client 发出 `skill.<name>` invocation。
  - `POST /v1/commands` 放行经过校验的 passthrough 或 skill invocation。
- **发现/插入 UI（Layer 2）**：`/skills` 结果弹窗支持键盘导航和落入。
  - `↑/↓`、`PageUp/PageDown` 在 skill 列表中选中，首尾 clamp。
  - `Tab`、`Enter` 或点击把选中项的 `/<skill-name> ` 落入 composer 并关闭弹窗，不在 modal 内直接执行。
  - composer 聚焦后，用户可补参数并按 `Enter` 走 Layer 1。

[`improve-1`](./improve-1/README.md) 已实施的增量合同：

- builtin `/skills` 接受字面量 `/skill` 作为 input-only alias；palette、completion chip、result header 始终显示 canonical `/skills`，不会新增 `/skill` 第二行。
- `/skills` 结果只列出 eligibility projection 接受的 slash-invocable skills；projection 按 builtin canonical/aliases > accepted extra commands > registry skills 处理占用，并保留大小写不敏感的 legacy reserved roots/exact paths。
- skill 行按名称 / 描述 / `scope · source` 三段有界显示；hover 更新真实选中态，click 直接落入；键盘选中行保持在可视区。
- palette 有 args 命令保持四列；无 args 命令使用显式三列 modifier，不留下空参数列。

持续不做：

- 不在顶层 `/` slash 浮层展示 skill 候选（保持 web 浮层精简，不 flood）。
- 不给 skill 命令加 `web` surface（web 全程伪装 `tui`，surface 过滤天然通过，无需改 surface 标签）。
- 不改 skill 在 daemon 端的执行语义；web 与 CLI 走同一条 `executeSkillCommand` 路径。
- 不在 `/skills` 弹窗内直接执行 skill（`Enter` 也只落入+关闭），执行统一回到 composer。
- 不做 skill 参数表单、收藏/置顶、分组筛选、搜索框等增强。

---

## 2. Implemented Baseline & improve-1 Additions

### 2.1 已落地基线（`b5e00f4`）

daemon 原本已具备 `executeSkillCommand`；`b5e00f4` 打通了 Web 发现、解析、网关校验和 composer prefill：

- `packages/ohbaby-agent/src/commands/service.ts` 已经把用户可调用 skill 转成 command：
  - `id:"skill.<name>"`；
  - `path:[<name>]`，因此用户输入形态是 `/<name>`；
  - `source:"skill"`；
  - `acceptsArguments:true`、`argumentMode:"raw"`；
  - `surfaces:["tui","stdout","headless"]`。
- 同一个文件里的 `executeSkillCommand` 已经能加载 skill prompt，并通过注入的 `submitPromptAndWait` 端口把 prompt 注入当前 session。因此执行能力已经存在。
- CLI/TUI 的顶层 `/` 补全走 `packages/ohbaby-cli/src/tui/slash-commands/runtime.ts` 的完整 command catalog；`filterSdkCommandCatalog` 不会主动排除 `source:"skill"`，所以 skill 会像普通 slash command 一样出现并可执行。
- Web catalog 入口在 `packages/ohbaby-server/src/app/create-app.ts`：`GET /v1/commands?surface=web` 先向 backend 要 `surface:"tui"` 的 catalog，再由 `filterWebCommandCatalog` 纳入 passthrough、overlay 与 `source:"skill"`。
- 浏览器执行入口在 `apps/ohbaby-web/src/api/daemon/client.ts`：`executeSlashCommand` 对 Web catalog resolve passthrough 或 skill；overlay 仍走专用结构化 API。
- Web POST 网关在 `packages/ohbaby-server/src/app/create-app.ts`：`POST /v1/commands` 放行经过 helper 校验的 passthrough 或 skill invocation，继续拒绝 overlay / interaction。
- `/skills` 结果 UI 在 `apps/ohbaby-web/src/ui/App.tsx` 的 `SkillsCommandResult`：已有 `selectedIndex`、方向键/Page 键、Tab/Enter、点击落入和一次性 `composerPrefill` 通道。

### 2.2 improve-1 已落地改进

- builtin `skills.aliases` 包含 `["skill"]`，direct `/skill` 能 canonical resolve 为 `/skills`；palette 仍只渲染 canonical 行。
- hover 更新真实 `selectedIndex` / `aria-selected`，键盘选中行通过 `scrollIntoView({ block:"nearest" })` 保持可见。
- Web metadata 同时显示 `scope · source`，缺 source 时只显示 scope；名称、描述和 metadata 均在三段有界 grid 中 ellipsis。
- no-args 命令行使用显式三列 modifier；有 args 命令继续使用四列。
- `service.ts` 内的单一 projection 同时产出 catalog 和 `/skills` output，覆盖 builtin/extra/legacy 占用并按优先级筛选 registry skills。

完整证据、根因与目标方案见 [`improve-1/01`](./improve-1/01-problem-analysis-and-current-state.md) 和 [`improve-1/02`](./improve-1/02-optimization-plan-and-change-scope.md)。

---

## 3. Catalog & Execution Contract

> 本节修订 [structured-overlays.md](structured-overlays.md) 第 2 节：`POST /v1/commands` 此前「只接受 passthrough」，现扩展为「接受 passthrough **或** skill 命令」。overlay 仍只能走结构化 REST，interaction 命令仍被拒绝。

### 3.1 catalog 暴露（仅供 resolve）

- `filterWebCommandCatalog`（`ohbaby-sdk`）把 `command.source === "skill"` 的命令以
  `action:"executeCommand"`、`executionKind:"skill"` 收进 `UiWebCommandCatalog`。
- 现有 palette 展示过滤器 [`isWebPaletteCommand`](../../../../apps/ohbaby-web/src/ui/slashCommands.ts) **保持不变**：它对 `executeCommand` 且非 passthrough id 的命令返回 `false`，因此 `executionKind:"skill"` 不会进入顶层 `/` 浮层。catalog 含 skill 仅用于浏览器解析 `/skill-name`，不用于浮层展示。
- 每个 skill 返回项包含：`id`（`skill.<name>`）、`path`（`[<name>]`）、`description`、`argumentMode`（`raw`）、`category`（`skill`）、`source`（`skill`）、`executionKind:"skill"`、`action:"executeCommand"`。
- builtin `skills` 使用 canonical `path:["skills"]` 与 input-only `aliases:[["skill"]]`。SDK 命中 alias 后仍返回 canonical path；UI 只显示 `/skills`。
- 动态 external command 是否可注册与 `/skills` output 是否可展示，共用 commands 域 eligibility projection；builtin 占用从真实 catalog canonical/aliases 派生，优先级为 builtin > accepted extra command > registry skill，并保留 legacy `cancel` / `mode` / `model` roots 与 permission exact paths。

### 3.2 浏览器解析与执行

- `executeSlashCommand` 对「passthrough ∪ skill」的 catalog 调用
  `resolveSlashCommand(catalog, parseSlashCommandInput(text), { surface: "tui" })`。
- 解析成功后照常 `POST /v1/commands`，invocation 带 `commandId:"skill.<name>"`、`surface:"tui"`、`rawArgs`（用户在 `/skill-name ` 之后输入的参数原文）。
- skill 命令 `acceptsArguments:true`、`argumentMode:"raw"`：`rawArgs` 透传到 daemon，由 `executeSkillCommand` 以 `User request:` 段拼接进 skill prompt。

### 3.3 服务端网关

- SDK helper `supportsWebSkillCommandInvocation(catalog, invocation)` 在 daemon 全量 catalog（`surface:"tui"`）中校验该命令存在、surface 可见、path 一致、`source === "skill"`。
- `POST /v1/commands` 网关仅在 `supportsWebPassthroughCommandInvocation(...) || supportsWebSkillCommandInvocation(...)` 时放行，其余维持拒绝。
- 放行后照常 `backend.executeCommand(...)` → daemon 命中 `executeSkillCommand`：加载 skill prompt、经 raw backend 的 `submitPromptAndWait` 端口注入当前 session、发出 `skill.submitted` action。外层只记录一次 `executeCommand` 原子写，不为内部 prompt 重复记账；web 通过既有事件流看到 prompt 进入会话、agent 开始响应。

---

## 4. `/skills` Navigable Result Modal

### 4.1 数据源

- 弹窗内容仍来自 `/skills` passthrough 的成功输出 `data.skills`（`{ name, description, source?, scope? }[]`），不另起请求。
- 当前展示名称 / 描述 / `scope · source` 三段；缺 source 时只显示 scope，三段均单行有界。
- 输出源使用共享 eligibility projection 的 `slashInvocableSkills`，排除 builtin/extra/legacy policy 冲突；Web 不维护第二份名称黑名单。

### 4.2 选中状态与键盘

- [`SkillsCommandResult`](../../../../apps/ohbaby-web/src/ui/App.tsx) 维护 `selectedIndex`，初始 `0`，渲染时高亮选中行。
- 键盘映射（弹窗打开且 skills variant 时生效）：

  | 键 | 行为 |
  |----|------|
  | `↑` / `↓` | 选中上/下一项，首尾 clamp |
  | `PageUp` / `PageDown` | 按固定步长（5）跳选，首尾 clamp |
  | `Tab` | 落入选中项并关闭弹窗（见 4.3）；`preventDefault` 阻止默认焦点切换 |
  | `Enter` | 同 `Tab`（落入+关闭，不直接执行） |
  | `Esc` | 关闭弹窗（沿用现有监听） |

- 鼠标悬停通过 `onMouseEnter` 同步真实 `selectedIndex` / `aria-selected`；选中变化后精确行调用 `scrollIntoView({ block:"nearest" })`，保证键盘与指针共享同一个可见选中态。
- 鼠标点击某行 = 直接落入该行并关闭弹窗，不依赖旧选中项。
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
运行 /skills（passthrough；direct /skill alias 也 canonical resolve 到 /skills）
  → 成功 notice → CommandResultModal(skills) 打开
  hover 或 ↑/↓ · PageUp/PageDown 选中
  Tab / Enter / 点击
    → onInsertSkill("/hansun-db ")
    → composerPrefill 更新 → Composer setDraft("/hansun-db ") 并聚焦
    → 关闭弹窗
用户（可选）补参数 → Enter
  → submitText("/hansun-db …") → executeSlashCommand
  → resolve（passthrough ∪ skill）成功 → POST /v1/commands { commandId:"skill.hansun-db", surface:"tui", rawArgs }
  → 服务端 supportsWebSkillCommandInvocation 放行
  → backend.executeCommand → executeSkillCommand → 加载 prompt → submitPromptAndWait(raw backend)
  → 事件流：prompt 进入会话，agent 开始响应
```

---

## 6. Historical Implementation Plan（已由 `b5e00f4` 完成）

> 本节保留 Layer 1/2 的实施轨迹，供追溯使用，**不是当前待办**。当前 improve-1 的执行契约只看 [`improve-1/02`](./improve-1/02-optimization-plan-and-change-scope.md) 与 [`improve-1/04`](./improve-1/04-test-and-acceptance.md)。下文的 “Plan / Modify / Add” 均按历史时态理解。

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

以下是 `b5e00f4` Layer 1/2 的既有验证面：

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

improve-1 的新增发布门以 [`improve-1/04-test-and-acceptance.md`](./improve-1/04-test-and-acceptance.md) 为准，已覆盖真实 direct `/skill` resolve/client integration（未用 palette 前缀代替）、共享 builtin/extra/skill eligibility projection、hover→Tab、精确行 nearest scroll、`scope · source`、no-args 三列与有 args 四列的浏览器对照。

---

## 8. Confirmed Decisions

已确认并由本文 / improve-1 共同约束：

- Web 顶层 `/` palette 继续不展示单个 skill，只展示 canonical `/skills` 入口。
- `/skills` modal 内 `Tab`、`Enter`、点击只把 `/<skill-name> ` 落入 composer，不直接执行；improve-1 增加 hover 真实选中与 nearest scroll。
- 字面量 `/skill` 是 builtin `/skills` 的 input-only alias；所有标签、补全 chip、header 和 slash 列表仍只显示 `/skills`。
- 动态 catalog 与 `/skills` output 共用 eligibility projection；builtin canonical/aliases、accepted extra commands 与 legacy reserved roots/exact paths 都参与占用，而非只处理新增 alias 冲突。
- skill metadata 显示 `scope · source`；no-args palette 行显式三列，有 args 行保持四列。
- `POST /v1/commands` 对 Web 只开放经过校验的 passthrough 和 skill；overlay 仍走结构化 REST。
- Skill 命令继续使用 `surface:"tui"` 与 raw arguments，不改 daemon 注入协议，不在本批做参数 UI。
- improve-1 在用户确认文档后实施；实施验收与只读子代理复审记录见 [`improve-1/05`](./improve-1/05-implementation-acceptance.md)。
