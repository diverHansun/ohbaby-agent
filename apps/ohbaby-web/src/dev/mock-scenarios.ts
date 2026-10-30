import type {
  UiGlobalSession,
  UiCurrentModelConfig,
  UiMessage,
  UiPermissionRequest,
  UiSession,
  UiSnapshot,
} from "ohbaby-sdk";
import type { WorkspaceSnapshot } from "../api/daemon/wire.js";

/**
 * Dev-only scenarios for `vite dev` with `?mock=<name>` (06 §5). improve-1 ships
 * the current-behaviour samples; improve-2 upgrades them to global data.
 */
export interface MockScenario {
  readonly snapshot: UiSnapshot;
  readonly workspace: WorkspaceSnapshot;
  readonly model: UiCurrentModelConfig | null;
  /** The global list, newest first; the mock pages it 100 rows at a time. */
  readonly sessions: readonly UiGlobalSession[];
  /** Seeded into the global pin set when this browser has none yet. */
  readonly pins?: Readonly<Record<string, number>>;
}

export const DEFAULT_WORKSPACE = "/Users/demo/.ohbaby/workspace";

const now = Date.now();
const iso = (minutesAgo: number): string =>
  new Date(now - minutesAgo * 60_000).toISOString();

const model: UiCurrentModelConfig = {
  id: "m1",
  source: "default",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  interfaceProvider: "openai-compatible",
  model: "deepseek-v4.1-flash",
  contextWindowTokens: 128_000,
};

const workspace: WorkspaceSnapshot = {
  scopes: [
    {
      available: true,
      directory: "/Users/demo/Projects/ohbaby-agent",
      lastOpenedAt: 3,
      loaded: true,
      position: 0,
    },
    {
      available: true,
      directory: "/Users/demo/Projects/pi-web",
      lastOpenedAt: 2,
      loaded: false,
      position: 1,
    },
    {
      available: true,
      directory: "/Users/demo/notes",
      lastOpenedAt: 1,
      loaded: false,
      position: 2,
    },
  ],
  selectedDirectory: "/Users/demo/Projects/ohbaby-agent",
};

const titles = [
  "Refactor the session sidebar",
  "Why does the composer jump on resize?",
  "Add JSONL export to the session menu",
  "Review the settings backend contract",
  "Fix flaky reconnect test",
  "Explain the steer queue lease",
  "Draft release notes for 0.9",
  "Compare pi-web and Claude layouts",
];

function session(
  id: string,
  title: string,
  minutesAgo: number,
  messages: readonly UiMessage[] = [],
): UiSession {
  return {
    id,
    title,
    createdAt: iso(minutesAgo + 30),
    updatedAt: iso(minutesAgo),
    messages,
  };
}

const history = titles.map((title, index) =>
  session(`session_${String(index + 2)}`, title, (index + 1) * 600),
);

const runningMessages: readonly UiMessage[] = [
  {
    id: "m1",
    role: "user",
    createdAt: iso(4),
    parts: [
      {
        type: "text",
        text: "The sidebar feels cramped. Tighten the rows and make the active session obvious without adding colour.",
      },
    ],
  },
  {
    id: "m2",
    role: "assistant",
    runId: "run_1",
    createdAt: iso(4),
    parts: [
      {
        type: "reasoning",
        text: "Look at the row height tokens and the active-row style first.",
      },
      {
        type: "text",
        text: "I'll start by reading the sidebar styles and the row component, then propose a tighter layout.",
      },
      {
        type: "tool-call",
        call: {
          id: "call_1",
          name: "read_file",
          input: { path: "apps/ohbaby-web/src/ui/sidebar/sidebar.css" },
          status: "completed",
        },
      },
      {
        type: "tool-result",
        result: {
          callId: "call_1",
          output: ".ohb-session-row { min-height: var(--row-height); }",
          details: { kind: "read", startLine: 1, shownLineCount: 258 },
        },
      },
      {
        type: "tool-call",
        call: {
          id: "call_2",
          name: "grep",
          input: { pattern: "ohb-session-active", path: "apps/ohbaby-web/src" },
          status: "completed",
        },
      },
      {
        type: "tool-result",
        result: {
          callId: "call_2",
          output: "sidebar/SessionRow.tsx:117",
          details: { kind: "search", unit: "matches", count: 1 },
        },
      },
      {
        type: "text",
        text: "The rows use a 30px minimum height and the active row only changes its background. Next I'll run the sidebar tests before editing.",
      },
      {
        type: "tool-call",
        call: {
          id: "call_3",
          name: "bash",
          input: {
            command: "pnpm exec vitest run apps/ohbaby-web/src/ui/sidebar",
          },
          status: "running",
        },
      },
    ],
  },
];

const runningSession = session(
  "session_1",
  "Tighten the sidebar rows",
  1,
  runningMessages,
);

const approval: UiPermissionRequest = {
  id: "perm_1",
  sessionId: "session_1",
  rootSessionId: "session_1",
  callId: "call_3",
  messageId: "m2",
  runId: "run_1",
  createdAt: now,
  title: "Shell commands need your approval unless Full access is on.",
  description: "bash(pnpm exec vitest run apps/ohbaby-web/src/ui/sidebar)",
  command: "pnpm exec vitest run apps/ohbaby-web/src/ui/sidebar",
  choices: [
    { id: "allow_once", label: "Allow once", intent: "allow" },
    { id: "allow_always", label: "Always allow", intent: "allow" },
    { id: "reject", label: "Reject", intent: "deny" },
  ],
};

const base = {
  permission: { level: "default", mode: "auto", sessionRules: [] },
  permissions: [],
  runs: [],
  status: { kind: "idle" },
} satisfies Partial<UiSnapshot>;

function running(withApproval: boolean): UiSnapshot {
  return {
    ...base,
    activeSessionId: "session_1",
    sessions: [runningSession, ...history],
    status: { kind: "running", runId: "run_1" },
    runs: [
      {
        id: "run_1",
        sessionId: "session_1",
        startedAt: iso(4),
        updatedAt: iso(0),
        status: { kind: "running", runId: "run_1" },
      },
    ],
    permissions: withApproval
      ? [
          approval,
          {
            ...approval,
            id: "perm_2",
            title:
              "This command is too complex to check automatically, so it can only be allowed once.",
            description: "",
            command: `cd /tmp && python3 -c "
lines=open('dl.txt').read().split('\\n')
print('\\n'.join(lines[1139:1750]))" | grep -v "^\\s*$" | head -400`,
            choices: approval.choices.filter(
              (choice) => choice.id !== "allow_always",
            ),
          },
          {
            ...approval,
            id: "perm_3",
            title: "Write tool requires confirmation: write",
            description: "write(apps/ohbaby-web/src/ui/sidebar/**)",
            command: undefined,
          },
        ]
      : [],
    todos: [
      {
        sessionId: "session_1",
        visible: true,
        todos: [
          {
            content: "Read sidebar styles and row component",
            status: "completed",
          },
          { content: "Run the sidebar tests", status: "in_progress" },
          { content: "Tighten row height and active style", status: "pending" },
        ],
      },
    ],
    contextWindowUsages: [
      {
        sessionId: "session_1",
        modelId: model.model,
        currentTokens: 92_000,
        contextWindowTokens: 128_000,
        contextWindowRatio: 0.72,
        estimatedAt: iso(0),
      },
    ],
  };
}

const agentWorkspace = "/Users/demo/Projects/ohbaby-agent";
const piWorkspace = "/Users/demo/Projects/pi-web";
const notesWorkspace = "/Users/demo/notes";
const archiveWorkspace = "/Users/demo/Projects/archive-tool";

function globalRow(
  id: string,
  title: string,
  minutesAgo: number,
  workspaceDirectory: string | null,
  extra: Partial<UiGlobalSession> = {},
): UiGlobalSession {
  return {
    id,
    title,
    status: "active",
    createdAt: iso(minutesAgo + 30),
    updatedAt: iso(minutesAgo),
    messageCount: 4,
    workspaceDirectory,
    workingDirectory: workspaceDirectory ?? DEFAULT_WORKSPACE,
    ...extra,
  };
}

function byRecency(
  rows: readonly UiGlobalSession[],
): readonly UiGlobalSession[] {
  return [...rows].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

/** 3 workspaces (one with 30 chats), 5 chats without a workspace, 2 pinned (06 §5). */
function typicalSessions(): readonly UiGlobalSession[] {
  const rows: UiGlobalSession[] = history.map((entry, index) =>
    globalRow(entry.id, entry.title, (index + 1) * 600, agentWorkspace),
  );
  for (let index = rows.length; index < 30; index++)
    rows.push(
      globalRow(
        `agent_${String(index)}`,
        `Earlier agent task ${String(index + 1)}`,
        (index + 1) * 900,
        agentWorkspace,
      ),
    );
  ["Port the session tree", "Search snippet styling", "Pinned layout"].forEach(
    (title, index) => {
      rows.push(
        globalRow(`pi_${String(index)}`, title, 45 + index * 400, piWorkspace),
      );
    },
  );
  ["Reading list", "Meeting notes"].forEach((title, index) => {
    rows.push(
      globalRow(
        `notes_${String(index)}`,
        title,
        3000 + index * 2000,
        notesWorkspace,
      ),
    );
  });
  [
    "Quick question",
    "Translate a paragraph",
    "Regex for ISO dates",
    "What is a CRDT?",
    "Weekend plan",
  ].forEach((title, index) => {
    rows.push(
      globalRow(`loose_${String(index)}`, title, 5 + index * 700, null),
    );
  });
  return byRecency(rows);
}

/** 600 chats across 4 workspaces, so Show more has to page (06 §5 many). */
function manySessions(): readonly UiGlobalSession[] {
  const workspaces = [agentWorkspace, piWorkspace, notesWorkspace];
  return byRecency(
    Array.from({ length: 600 }, (_, index) =>
      globalRow(
        `many_${String(index)}`,
        `Chat ${String(index + 1)}`,
        index * 37,
        // The fourth workspace's chats are old and rare, so it fills late.
        index % 20 === 0
          ? archiveWorkspace
          : (workspaces[index % 3] ?? agentWorkspace),
      ),
    ),
  );
}

/**
 * 8 archived chats (D9 mock): one per kind of row, including a workspace
 * whose folder is gone, so Restore sends it to Recents.
 */
function archivedSessions(): readonly UiGlobalSession[] {
  const archived = { status: "archived" as const };
  return byRecency([
    globalRow(
      "arch_0",
      "Implement improve-1 phase optimisations",
      50,
      agentWorkspace,
      archived,
    ),
    globalRow(
      "arch_1",
      "Investigate subagent dispatch and message blocking (improve-3)",
      1_500,
      agentWorkspace,
      archived,
    ),
    globalRow(
      "arch_2",
      "Sketch the old prototype's onboarding",
      4_000,
      "/Users/demo/Projects/old-prototype",
      archived,
    ),
    globalRow("arch_3", "Port the session tree", 9_000, piWorkspace, archived),
    globalRow(
      "arch_4",
      "Optimise the system-prompt module",
      20_000,
      agentWorkspace,
      archived,
    ),
    globalRow(
      "arch_5",
      "Generate a file named AGENTS.md that serves as a contributor guide for this repository, covering layout, commands and style",
      40_000,
      null,
      archived,
    ),
    globalRow(
      "arch_6",
      "Reading list for the week",
      90_000,
      notesWorkspace,
      archived,
    ),
    globalRow("arch_7", "", 200_000, null, archived),
  ]);
}

const typicalPins = { agent_12: now - 2, pi_1: now - 1 };

export const mockScenarios: Readonly<Record<string, () => MockScenario>> = {
  fresh: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: [] },
    workspace: { scopes: [], selectedDirectory: DEFAULT_WORKSPACE },
    model,
    sessions: [],
  }),
  typical: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model,
    sessions: typicalSessions(),
    pins: typicalPins,
  }),
  many: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: [] },
    workspace: {
      ...workspace,
      scopes: [
        ...workspace.scopes,
        {
          available: true,
          directory: "/Users/demo/Projects/archive-tool",
          lastOpenedAt: 0,
          loaded: false,
          position: 3,
        },
      ],
    },
    model,
    sessions: manySessions(),
  }),
  search: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: [] },
    workspace: {
      ...workspace,
      scopes: [
        ...workspace.scopes,
        ...Array.from({ length: 7 }, (_, index) => ({
          available: true,
          directory: `/Users/demo/Projects/sample-${String(index + 1)}`,
          lastOpenedAt: 0,
          loaded: false,
          position: index + 3,
        })),
      ],
    },
    model,
    sessions: [...typicalSessions(), ...manySessions()],
  }),
  running: () => ({
    snapshot: running(false),
    workspace,
    model,
    sessions: byRecency([
      globalRow("session_1", runningSession.title, 1, agentWorkspace),
      ...typicalSessions(),
    ]),
  }),
  approval: () => ({
    snapshot: running(true),
    workspace,
    model,
    sessions: byRecency([
      globalRow("session_1", runningSession.title, 1, agentWorkspace),
      ...typicalSessions(),
    ]),
  }),
  // Moved to pi-web while running: this turn stays in ohbaby-agent (06 §5).
  "pending-move": () => ({
    snapshot: running(false),
    workspace,
    model,
    sessions: byRecency([
      globalRow("session_1", runningSession.title, 1, piWorkspace, {
        workingDirectory: agentWorkspace,
        pendingWorkingDirectory: piWorkspace,
      }),
      ...typicalSessions(),
    ]),
  }),
  // Settings data comes from mock-settings.ts under the same names (06 §5).
  settings: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model,
    sessions: typicalSessions(),
    pins: typicalPins,
  }),
  "settings-empty": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: [] },
    workspace: { scopes: [], selectedDirectory: DEFAULT_WORKSPACE },
    model: null,
    sessions: [],
  }),
  // A keyless legacy model and no default: completing it sets the default.
  "settings-legacy": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: [] },
    workspace: { scopes: [], selectedDirectory: DEFAULT_WORKSPACE },
    model: null,
    sessions: [],
  }),
  "settings-errors": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model,
    sessions: typicalSessions(),
  }),
  // Settings › Archived (D9): restore, delete, and a folder that is gone.
  archived: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model,
    sessions: [...typicalSessions(), ...archivedSessions()],
    pins: typicalPins,
  }),
  // 120 archived chats, so Show more pages.
  "archived-many": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: [] },
    workspace,
    model,
    sessions: manySessions()
      .slice(0, 120)
      .map((row) => ({ ...row, status: "archived" as const })),
  }),
  // The first read and every delete fail.
  "archived-error": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model,
    sessions: [...typicalSessions(), ...archivedSessions()],
  }),
  // Twenty models, so the composer's model menu scrolls (04 T19c).
  "models-many": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model,
    sessions: typicalSessions(),
  }),
  "no-model": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model: null,
    sessions: typicalSessions(),
  }),
};
