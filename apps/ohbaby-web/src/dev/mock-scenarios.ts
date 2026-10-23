import type {
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
}

const now = Date.now();
const iso = (minutesAgo: number): string =>
  new Date(now - minutesAgo * 60_000).toISOString();

const model: UiCurrentModelConfig = {
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
  title: "Allow bash?",
  description: "pnpm exec vitest run apps/ohbaby-web/src/ui/sidebar",
  choices: [
    { id: "deny", label: "Deny", intent: "deny" },
    { id: "allow_once", label: "Allow once", intent: "allow" },
    { id: "allow_always", label: "Always allow", intent: "allow" },
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
            title: "Allow write_file?",
            description: "apps/ohbaby-web/src/ui/sidebar/sidebar.css",
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

export const mockScenarios: Readonly<Record<string, () => MockScenario>> = {
  fresh: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: [] },
    workspace,
    model,
  }),
  typical: () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model,
  }),
  running: () => ({ snapshot: running(false), workspace, model }),
  approval: () => ({ snapshot: running(true), workspace, model }),
  "no-model": () => ({
    snapshot: { ...base, activeSessionId: null, sessions: history },
    workspace,
    model: null,
  }),
};
