# TUI Improve 2 UI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the ohbaby-cli Ink TUI by landing the theme foundation, transcript split, logo, permission default, skill warning suppression, prompt frame rendering, and live tool spinner fixes described in this spec.

**Architecture:** This is a stacked improve-2 branch on top of `codex/tui-improve-1-a-c`. The implementation keeps the existing Ink app and SDK/agent contracts, adds a semantic theme layer, splits message rendering into smaller components, and applies each visual/behavior change behind focused tests.

**Tech Stack:** TypeScript, React 19, Ink 6, Vitest, ink-testing-library 4, `figlet`, `ink-gradient`, existing ohbaby-sdk/ohbaby-agent UI contracts.

---

## Branch And Merge Policy

- Implementation branch: `codex/tui-improve-2-ui-fixes`.
- Base: `codex/tui-improve-1-a-c`.
- Merge order to `mvp`: merge improve-1 first, then improve-2.
- Do not publish npm from this branch. Publishing waits for TUI verification, packaging smoke, full preflight, and MCP phase release readiness.

## File Map

- Create: `packages/ohbaby-cli/src/tui/theme/colors.ts`
- Create: `packages/ohbaby-cli/src/tui/theme/tokens.ts`
- Create: `packages/ohbaby-cli/src/tui/theme/detect.ts`
- Create: `packages/ohbaby-cli/src/tui/theme/index.tsx`
- Create tests: `packages/ohbaby-cli/src/tui/theme/*.unit.test.ts`
- Modify/delete: `packages/ohbaby-cli/src/tui/theme.ts`
- Modify: `packages/ohbaby-cli/src/tui/app.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/logo.tsx`
- Modify: `packages/ohbaby-cli/src/tui/render/logo.ts`
- Modify tests: `packages/ohbaby-cli/src/tui/render/logo.unit.test.ts`
- Modify: `packages/ohbaby-cli/src/tui/components/message/message-list.tsx`
- Create: `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`
- Create: `packages/ohbaby-cli/src/tui/components/message/notice-banner.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx`
- Modify tests: `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.unit.test.ts`
- Create: `packages/ohbaby-cli/src/tui/components/spinner.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/prompt/completion.tsx`
- Modify: `packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx`
- Modify: `packages/ohbaby-cli/src/tui/dialogs/confirm.tsx`
- Modify: `packages/ohbaby-cli/src/tui/dialogs/select-one.tsx`
- Modify tests: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`
- Modify: `packages/ohbaby-agent/src/skill/loader.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Modify tests: `packages/ohbaby-agent/src/skill/loader.unit.test.ts`
- Modify tests: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Modify: `packages/ohbaby-cli/package.json`
- Modify: `pnpm-lock.yaml`

## Task 1: Dependencies And Theme Foundation

**Files:**
- Modify: `packages/ohbaby-cli/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/ohbaby-cli/src/tui/theme/colors.ts`
- Create: `packages/ohbaby-cli/src/tui/theme/tokens.ts`
- Create: `packages/ohbaby-cli/src/tui/theme/detect.ts`
- Create: `packages/ohbaby-cli/src/tui/theme/index.tsx`
- Create tests: `packages/ohbaby-cli/src/tui/theme/colors.unit.test.ts`
- Create tests: `packages/ohbaby-cli/src/tui/theme/tokens.unit.test.ts`
- Create tests: `packages/ohbaby-cli/src/tui/theme/detect.unit.test.ts`

- [ ] **Step 1: Add dependencies**

Run:

```bash
pnpm --filter ohbaby-cli add figlet ink-gradient
```

Expected: `packages/ohbaby-cli/package.json` includes `figlet` and `ink-gradient`; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write failing theme tests**

Create tests that assert:

```ts
expect(darkPalette.gold).toMatch(/^#[0-9A-Fa-f]{6}$/u);
expect(lightPalette.skyBlue).toMatch(/^#[0-9A-Fa-f]{6}$/u);
expect(createTheme("dark", 3).brandTitle.primary).toBe(darkPalette.gold);
expect(createTheme("dark", 0).brandTitle.primary).toBe("yellow");
expect(detectTheme({ env: {}, chalkLevel: 3 }).mode).toBe("dark");
```

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/theme
```

Expected: FAIL because the theme module does not exist yet.

- [ ] **Step 3: Implement theme files**

Implement:

```ts
export interface Theme {
  readonly mode: "dark" | "light";
  readonly brandTitle: { readonly primary: string; readonly secondary: string; readonly tertiary: string };
  readonly spinner: { readonly frames: readonly string[]; readonly palette: readonly string[] };
  readonly text: { readonly normal: string; readonly strong: string; readonly dim: string; readonly muted: string };
  readonly role: { readonly user: string; readonly assistant: string };
  readonly tool: { readonly name: string; readonly arg: string; readonly running: string; readonly failed: string; readonly success: string };
  readonly status: { readonly accent: string; readonly warning: string; readonly error: string; readonly success: string };
  readonly reasoning: string;
  readonly border: string;
  readonly cursor: string;
}
```

Use the palette values from `docs/ohbaby-cli/tui-improve-1/02a-theme-and-colors.md`, default to dark, and downgrade to named 16-color strings when `chalk.level < 2`.

- [ ] **Step 4: Run theme tests**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/theme
```

Expected: PASS.

## Task 2: Migrate Existing TUI Colors To Theme Tokens

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/app.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/logo.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/message/message-list.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/prompt/completion.tsx`
- Modify: `packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx`
- Modify: `packages/ohbaby-cli/src/tui/dialogs/confirm.tsx`
- Modify: `packages/ohbaby-cli/src/tui/dialogs/select-one.tsx`
- Delete or deprecate: `packages/ohbaby-cli/src/tui/theme.ts`

- [ ] **Step 1: Wrap app in ThemeProvider**

In `app.tsx`, wrap the rendered `AppShell` tree with `<ThemeProvider>`.

- [ ] **Step 2: Replace `tuiTheme.colors.*` imports**

Replace all component reads of `tuiTheme.colors.*` with `const theme = useTheme()` and semantic token reads:

```ts
theme.status.warning
theme.status.error
theme.role.user
theme.tool.name
theme.reasoning
theme.border
```

- [ ] **Step 3: Verify no legacy component color imports remain**

Run:

```bash
rg "tuiTheme|\\.\\.\\/theme\\.js|\\.\\.\\/\\.\\.\\/theme\\.js" packages/ohbaby-cli/src/tui
```

Expected: no production references remain, except intentionally deleted or compatibility test references if any are still being migrated in the same task.

- [ ] **Step 4: Run focused TUI tests**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/components/prompt/editor-reducer.unit.test.ts
```

Expected: failures only from known visual expectations that later tasks update; no import/runtime failure from theme migration.

## Task 3: Split Message Rendering And Keep Transcript Replaceable

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/components/message/message-list.tsx`
- Create: `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`
- Create: `packages/ohbaby-cli/src/tui/components/message/notice-banner.tsx`
- Modify tests: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

- [ ] **Step 1: Extract tool pairing helper**

Move the inline tool-call/result pairing into:

```ts
export function pairToolCallResult(parts: readonly UiMessagePart[]): readonly PairedMessagePart[]
```

where `PairedMessagePart` represents either a single part or a `tool-call` with its following matching `tool-result`.

- [ ] **Step 2: Extract `MessageRow`**

`MessageRow` receives one `UiMessage` and `contentWidth`, renders user messages with the quiet `| ` prefix, assistant text through markdown, reasoning collapsed to `Thought` after streaming, and tool rows through the tool-part helpers.

- [ ] **Step 3: Extract `NoticeBanner`**

`NoticeBanner` receives `notices` and `commandNotices`, preserving the existing visible labels `notice` and `command` while using theme tokens.

- [ ] **Step 4: Keep transcript dynamic across session switches**

In `MessageList`, split:

```ts
const committed = messages.slice(0, -1);
const live = messages.at(-1);
```

Do not render transcript rows through Ink `<Static>` in v1. It is append-only and integration tests show stale committed rows survive `/resume` and `/sessions` changes. Keep `MessageRow` split and render `messages.map(...)` dynamically so the active session view remains replaceable.

- [ ] **Step 5: Run contract tests**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

Expected: existing transcript, reasoning, markdown, and tool text remain visible in `lastFrame()`; any failures identify concrete visual assertions to update in later tasks.

## Task 4: Permission Default Selection

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx`
- Modify tests: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

- [ ] **Step 1: Write failing tests**

Add/adjust tests to assert:

```ts
expect(frame).toContain("> Allow once [allow]");
expect(frame).toContain("  Reject [deny]");
```

and that pressing Enter replies with `{ choiceId: "allow_once" }`, while Escape replies with `{ choiceId: "reject" }`.

- [ ] **Step 2: Implement split defaults**

Replace the old default function with:

```ts
function findEscapeDefaultChoiceIndex(request: UiPermissionRequest): number {
  const denyIndex = request.choices.findIndex((choice) => choice.intent === "deny");
  if (denyIndex >= 0) return denyIndex;
  const abortIndex = request.choices.findIndex((choice) => choice.intent === "abort");
  return abortIndex >= 0 ? abortIndex : 0;
}

function findInitialChoiceIndex(request: UiPermissionRequest): number {
  const allowIndex = request.choices.findIndex((choice) => choice.intent === "allow");
  return allowIndex >= 0 ? allowIndex : findEscapeDefaultChoiceIndex(request);
}
```

Initialize selection with `useState(() => findInitialChoiceIndex(request))`; keep Escape on `findEscapeDefaultChoiceIndex(request)`.

- [ ] **Step 3: Run permission tests**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx -t permission
```

Expected: permission tests pass.

## Task 5: Skill Override Warning Suppression

**Files:**
- Modify: `packages/ohbaby-agent/src/skill/loader.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Modify tests: `packages/ohbaby-agent/src/skill/loader.unit.test.ts`
- Modify tests: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

- [ ] **Step 1: Add failing adapter test**

Add a test that emits a skill logger warning with `{ kind: "skill-override" }` and asserts no `notice.emitted` event is published, while an invalid skill warning still publishes a warning notice.

- [ ] **Step 2: Mark override warnings in loader**

In the override branch, keep the message unchanged and add:

```ts
kind: "skill-override"
```

to the warning context.

- [ ] **Step 3: Filter only override warnings in both adapters**

In both `createSkillLogger` implementations:

```ts
if (context?.kind === "skill-override") return;
```

Do not filter invalid skill or higher-precedence ignored warnings.

- [ ] **Step 4: Run agent tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/skill/loader.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: loader still records override warnings internally; UI no longer emits override notices.

## Task 6: Live Tool Spinner

**Files:**
- Create: `packages/ohbaby-cli/src/tui/components/spinner.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`
- Modify tests: `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.unit.test.ts`
- Modify tests: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

- [ ] **Step 1: Write failing spinner tests**

Test that `renderToolLabel(call, result)` returns only labels such as `Bash pnpm test`, with no spinner frame and no leading spaces.

Create a `Spinner` test using fake timers:

```ts
vi.useFakeTimers();
const app = render(<Spinner label="Bash pnpm test" />);
expect(app.lastFrame()).toContain("⠋ Bash pnpm test");
act(() => vi.advanceTimersByTime(80));
expect(app.lastFrame()).toContain("⠙ Bash pnpm test");
```

- [ ] **Step 2: Implement `Spinner`**

Use theme token frames/palette, `setInterval` at 80ms, cleanup on unmount, and `OHBABY_TUI_NO_ANIM=1` to keep the first frame static.

- [ ] **Step 3: Render running tools as components**

In `MessageRow`, render running/pending tool calls as:

```tsx
<Spinner label={renderToolLabel(call, result)} />
```

Render completed/failed rows as text with the current two-space leading width:

```tsx
<Text>{"  " + renderToolLabel(call, result)}</Text>
```

- [ ] **Step 4: Run spinner/tool tests**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/components/message/parts/tool-part.unit.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx -t tool
```

Expected: running rows show a frame and completed rows have no status icon.

## Task 7: Figlet Gradient Logo

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/render/logo.ts`
- Modify: `packages/ohbaby-cli/src/tui/components/logo.tsx`
- Modify tests: `packages/ohbaby-cli/src/tui/render/logo.unit.test.ts`
- Modify tests: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

- [ ] **Step 1: Write failing logo tests**

Assert:

```ts
expect(renderOhbabyLogo({ maxWidth: 80 }).join("\n")).toContain("█");
expect(renderOhbabyLogo({ maxWidth: 30 })).toEqual(["OHBABY"]);
```

In app contract, assert the wide logo contains a block character and the narrow logo contains the small fallback anchor.

- [ ] **Step 2: Implement fixed figlet logo**

Use `figlet/importable-fonts/ANSI Shadow.js`, `figlet.parseFont`, and `figlet.textSync("OHBABY", { font: "ANSI Shadow", horizontalLayout: "fitted" })`.

- [ ] **Step 3: Apply Ink gradient in component**

Wrap joined logo text in:

```tsx
<Gradient colors={[theme.brandTitle.primary, theme.brandTitle.secondary, theme.brandTitle.tertiary]}>
  <Text>{logoLines.join("\n")}</Text>
</Gradient>
```

- [ ] **Step 4: Run logo tests**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/render/logo.unit.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx -t logo
```

Expected: logo tests pass in wide and narrow widths.

## Task 8: Prompt Frame And Flicker Reduction

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`
- Modify tests: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

- [ ] **Step 1: Write failing prompt frame test**

Assert the frame contains round-border characters and the prompt marker inside the frame:

```ts
expect(frame).toContain("╭");
expect(frame).toContain("╰");
expect(frame).toContain("> message");
```

- [ ] **Step 2: Implement frame**

Wrap editor lines with:

```tsx
<Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
  {renderEditorLines(editor, disabled)}
</Box>
```

Keep runtime dock status and context window usage outside the bordered box.

- [ ] **Step 3: Run prompt tests**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx -t prompt
```

Expected: prompt layout tests pass, text fits at 80 columns, and context usage remains outside the frame.

## Task 9: Full Verification And Manual Gates

**Files:**
- No new source files; this task verifies all touched work.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm --filter ohbaby-cli test
pnpm --filter ohbaby-agent test
```

Expected: both pass.

- [ ] **Step 2: Run repo checks**

Run:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

Expected: all pass.

- [ ] **Step 3: Start local TUI**

Run:

```bash
pnpm start
```

Expected: built `ohbaby` TUI starts from `packages/ohbaby-cli/dist/bin.js`.

- [ ] **Step 4: Manual Windows Terminal check**

Verify:

- Logo renders as fixed FIGfont with gold→purple→skyBlue gradient.
- Prompt has the bordered input frame and no persistent `Skill ... overrides ...` notice.
- Permission defaults to Allow once; Escape still rejects.
- Running tool calls animate the spinner and completed tools keep only the tool name line.
- Continuous typing does not repaint the entire transcript visibly.

- [ ] **Step 5: Packaging readiness note**

Do not publish. Record whether `pnpm pack`/packaging smoke is still pending for the future npm release gate.
