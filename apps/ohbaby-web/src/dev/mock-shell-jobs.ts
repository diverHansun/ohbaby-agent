import type {
  UiEvent,
  UiEventHandler,
  UiShellJobList,
  UiShellJobListQuery,
  UiShellJobOutput,
  UiShellJobRow,
  UiShellJobStatus,
  UiShellJobStopResult,
  UiShellJobTarget,
} from "ohbaby-sdk";

/** The chat that owns the mock tasks in every `bg-*` scenario. */
export const MOCK_TASK_SESSION = "session_bg";

const TAIL_BYTES = 32_768;
const EPOCH = "mock-epoch";

interface MockJob {
  row: UiShellJobRow;
  output: string;
  /** Pretend more was written than the tail holds. */
  extraBytes?: number;
  tailAvailable?: boolean;
  logPath?: string;
  /** Lines appended each second while running. */
  feed?: readonly string[];
  /** What a stop request answers, instead of cancelling. */
  stopError?: { readonly code: string; readonly message: string };
}

const now = Date.now();
const ago = (seconds: number): number => now - seconds * 1000;

function job(
  jobId: string,
  patch: Partial<UiShellJobRow> & { readonly command: string },
): UiShellJobRow {
  const status = patch.status ?? "running";
  return {
    jobId,
    rootSessionId: MOCK_TASK_SESSION,
    sessionId: MOCK_TASK_SESSION,
    ownerKind: "main",
    managedByCurrentBackend: true,
    canStop: status === "running",
    ownerName: "Main agent",
    description: null,
    mode: "background",
    status,
    stopReason: null,
    cleanup: status === "running" ? null : "confirmed",
    createdAt: ago(600),
    startedAt: ago(600),
    promotedAt: null,
    endedAt: status === "running" ? null : ago(300),
    resultReadyAt: status === "running" ? null : ago(300),
    settledAt: status === "running" ? null : ago(300),
    timeoutMs: null,
    exitCode: status === "completed" ? 0 : null,
    signal: null,
    trackingReleasedAt: null,
    ...patch,
  };
}

function subagentJob(
  jobId: string,
  owner: string,
  patch: Partial<UiShellJobRow> & { readonly command: string },
): UiShellJobRow {
  return job(jobId, {
    ownerKind: "subagent",
    ownerName: owner,
    sessionId: `${MOCK_TASK_SESSION}_${owner}`,
    subagentId: owner,
    ...patch,
  });
}

const VITE_LOG = `
> ohbaby-web@0.1.17 dev
> vite --port 5173

  VITE v5.4.21  ready in 312 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
`.trimStart();

const VITEST_FEED = [
  " ✓ src/store/sidebar-groups.unit.test.ts (24 tests) 41ms",
  " ✓ src/ui/sidebar/Sidebar.unit.test.tsx (31 tests) 512ms",
  " ✓ src/ui/composer/composer-layout.unit.test.ts (12 tests) 9ms",
  " ✓ src/runtime/side-chat.unit.test.ts (18 tests) 66ms",
  " ✓ src/ui/side-panel/SidePanel.unit.test.tsx (22 tests) 388ms",
];

const HMR_FEED = [
  "9:41:02 PM [vite] hmr update /src/ui/sidebar/sidebar.css",
  "9:41:07 PM [vite] hmr update /src/ui/sidebar/SessionRow.tsx",
  "9:41:15 PM [vite] page reload src/ui/App.tsx",
];

function mainJobs(): MockJob[] {
  return [
    {
      row: job("job_dev", {
        description: "Dev server",
        command: "pnpm --filter ohbaby-web exec vite --port 5173",
        createdAt: ago(7200),
        startedAt: ago(7200),
      }),
      output: VITE_LOG,
      feed: HMR_FEED,
      logPath: "/Users/demo/.ohbaby/tasks/job_dev.log",
    },
    {
      row: job("job_watch", {
        description: "Watch tests",
        command: "pnpm exec vitest --watch apps/ohbaby-web",
        createdAt: ago(30),
        startedAt: ago(30),
      }),
      output: " RUN  v2.1.9 /Users/demo/Projects/ohbaby-agent\n\n",
      feed: VITEST_FEED,
      logPath: "/Users/demo/.ohbaby/tasks/job_watch.log",
    },
    {
      row: job("job_unit", {
        description: "Unit tests",
        command: "pnpm test --run",
        status: "completed",
        createdAt: ago(900),
        startedAt: ago(900),
        endedAt: ago(600),
      }),
      output: ` Test Files  59 passed (59)\n      Tests  766 passed (766)\n   Duration  41.20s\n`,
    },
    {
      row: job("job_build", {
        description: "Build",
        command: "pnpm build",
        status: "failed",
        exitCode: 1,
        createdAt: ago(1800),
        startedAt: ago(1800),
        endedAt: ago(1608),
      }),
      output: `src/ui/App.tsx(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 1 error.\n ELIFECYCLE  Command failed with exit code 1.\n`,
    },
    {
      row: job("job_tsc", {
        description: "Type check",
        command: "pnpm tsc --noEmit --watch",
        status: "cancelled",
        stopReason: "user",
        createdAt: ago(2400),
        startedAt: ago(2400),
        endedAt: ago(2280),
      }),
      output:
        "Starting compilation in watch mode...\n\nFound 0 errors. Watching for file changes.\n",
    },
  ];
}

function subagentJobs(): MockJob[] {
  return [
    {
      row: subagentJob("job_review_lint", "code-reviewer", {
        description: "Lint changed files",
        command: "pnpm eslint apps/ohbaby-web/src/ui --max-warnings 0",
        createdAt: ago(95),
        startedAt: ago(95),
      }),
      output: "Linting 214 files…\n",
      feed: ["apps/ohbaby-web/src/ui/sidebar/SessionRow.tsx: ok"],
    },
    {
      row: subagentJob("job_review_e2e", "code-reviewer", {
        command: "pnpm exec playwright test sidebar.e2e.ts",
        status: "completed",
        createdAt: ago(1500),
        startedAt: ago(1500),
        endedAt: ago(1380),
      }),
      output: "  3 passed (2.0m)\n",
    },
    {
      row: subagentJob("job_docs_links", "docs-links", {
        description: "Check docs links",
        command: "npx lychee docs/**/*.md",
        status: "cancelled",
        stopReason: "owner-ended",
        createdAt: ago(3000),
        startedAt: ago(3000),
        endedAt: ago(2950),
      }),
      output: "🔍 412 Total ✅ 410 OK 🚫 2 Errors\n",
    },
    {
      row: subagentJob("job_docs_build", "docs-links", {
        command: "pnpm docs:build",
        status: "timed_out",
        stopReason: "timeout",
        createdAt: ago(5000),
        startedAt: ago(5000),
        endedAt: ago(1400),
      }),
      output: "Building 1,204 pages…\n",
    },
  ];
}

function manyDone(): MockJob[] {
  const statuses: UiShellJobStatus[] = [
    "completed",
    "completed",
    "completed",
    "failed",
    "cancelled",
  ];
  return [
    ...mainJobs().slice(0, 1),
    ...Array.from({ length: 250 }, (_, index): MockJob => {
      const status = statuses[index % statuses.length] ?? "completed";
      return {
        row: job(`job_done_${String(index)}`, {
          description: `Test shard ${String(index + 1)}`,
          command: `pnpm exec vitest run --shard=${String(index + 1)}/250`,
          status,
          ...(status === "failed" ? { exitCode: 1 } : {}),
          ...(status === "cancelled" ? { stopReason: "model" } : {}),
          createdAt: ago(9000 + index * 60),
          startedAt: ago(9000 + index * 60),
          endedAt: ago(8960 + index * 60),
        }),
        output: `shard ${String(index + 1)} done\n`,
      };
    }),
  ];
}

function specialJobs(): MockJob[] {
  const long = Array.from(
    { length: 1200 },
    (_, index) =>
      `[${String(index).padStart(4, "0")}] compiled module ${String(index)} in 12ms`,
  ).join("\n");
  return [
    {
      row: job("job_foreign", {
        description: "Storybook (started in the terminal UI)",
        command: "pnpm storybook --port 6006",
        managedByCurrentBackend: false,
        canStop: false,
      }),
      output: "Storybook 8.4 started\n  Local: http://localhost:6006/\n",
    },
    {
      row: job("job_unconfirmed", {
        description: "Docker compose",
        command: "docker compose up postgres redis",
        status: "cancelled",
        stopReason: "user",
        cleanup: "unconfirmed",
        settledAt: null,
      }),
      output: "postgres-1  | database system is ready to accept connections\n",
    },
    {
      row: job("job_lost", {
        description: "Long migration",
        command: "pnpm db:migrate --all",
        status: "lost",
        endedAt: null,
      }),
      output: "Migrating 14/40…\n",
    },
    {
      row: job("job_long", {
        description: "Verbose build",
        command: "pnpm build --verbose",
        status: "completed",
      }),
      output: long.slice(-TAIL_BYTES),
      extraBytes: 11 * 1024 * 1024,
      logPath: "/Users/demo/.ohbaby/tasks/job_long.log",
    },
    {
      row: job("job_rewound", {
        command: "pnpm dev:api",
        status: "cancelled",
        stopReason: "rewound",
      }),
      output: "",
    },
    {
      row: job("job_nosave", {
        description: "Docs preview",
        command: "pnpm docs:preview",
        status: "failed",
        exitCode: 127,
      }),
      output: "",
      tailAvailable: false,
    },
  ];
}

/**
 * Foreground commands also leave records (backend D15): one that just ended
 * and is not settled yet, and one whose cleanup was never confirmed. The
 * backend still returns them without `mode=background`; the panel must not.
 */
function foregroundJobs(rootSessionId = MOCK_TASK_SESSION): MockJob[] {
  return [
    {
      row: job("job_fg_git", {
        rootSessionId,
        sessionId: rootSessionId,
        command: "git status --short",
        mode: "foreground",
        status: "completed",
        exitCode: 0,
        settledAt: null,
      }),
      output: " M apps/ohbaby-web/src/ui/sidebar/sidebar.css\n",
    },
    {
      row: job("job_fg_sleep", {
        rootSessionId,
        sessionId: rootSessionId,
        command: "sleep 600",
        mode: "foreground",
        status: "cancelled",
        stopReason: "user",
        cleanup: "unconfirmed",
      }),
      output: "",
      tailAvailable: false,
    },
  ];
}

function cancelErrorJobs(): MockJob[] {
  const errors = [
    ["SHELL_JOB_OTHER_BACKEND", "Task belongs to another backend."],
    [
      "SHELL_JOB_CLEANUP_BUSY",
      "Task recovery is already in progress; refresh before trying again.",
    ],
    ["NETWORK", "Failed to fetch"],
    ["SHELL_JOB_NOT_FOUND", "Task was not found in this session tree."],
  ] as const;
  return errors.map(([code, message], index) => ({
    row: job(`job_err_${String(index)}`, {
      description: `Cancel returns ${code}`,
      command: `sleep ${String(600 + index)}`,
      createdAt: ago(60 * (index + 1)),
      startedAt: ago(60 * (index + 1)),
    }),
    output: "",
    stopError: { code, message },
  }));
}

const SCENARIOS: Readonly<Record<string, () => MockJob[]>> = {
  // Only foreground commands ran in this chat (`session_1` of `running`).
  "bg-none": () => foregroundJobs("session_1"),
  "bg-running": () => [...mainJobs(), ...foregroundJobs()],
  "bg-chat": () => [...mainJobs(), ...foregroundJobs()],
  "bg-two-chats": mainJobs,
  "bg-subagents": () => [...mainJobs().slice(0, 1), ...subagentJobs()],
  "bg-subagents-only": subagentJobs,
  "bg-many-done": manyDone,
  "bg-special": specialJobs,
  "bg-cancel-errors": cancelErrorJobs,
  "bg-output-fail": mainJobs,
};

export function isTaskScenario(name: string): boolean {
  return name in SCENARIOS;
}

function attention(row: UiShellJobRow): number {
  return row.trackingReleasedAt === null &&
    (row.status === "running" ||
      row.cleanup !== "confirmed" ||
      row.settledAt === null)
    ? 1
    : 0;
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The shell-job half of the daemon for `bg-*` scenarios: the backend's order
 * and counts, output that grows once a second with an invalidation, and a
 * stop that settles after a moment. `delay` slows every read.
 */
export interface MockShellJobs {
  subscribe(handler: UiEventHandler): () => void;
  listShellJobs(input: UiShellJobListQuery): Promise<UiShellJobList>;
  getShellJobOutput(input: UiShellJobTarget): Promise<UiShellJobOutput>;
  stopShellJob(input: UiShellJobTarget): Promise<UiShellJobStopResult>;
}

export function createMockShellJobs(
  name: string,
  delayMs: number,
): MockShellJobs {
  const jobs = new Map(
    (isTaskScenario(name) ? SCENARIOS[name]() : []).map((item) => [
      item.row.jobId,
      item,
    ]),
  );
  const handlers = new Set<UiEventHandler>();
  let revision = 1;
  let feedTick = 0;
  let outputFailed = false;
  const emit = (): void => {
    revision += 1;
    const event: UiEvent = {
      type: "shell-jobs.invalidated",
      rootSessionId: MOCK_TASK_SESSION,
      runtimeEpoch: EPOCH,
      revision,
    };
    for (const handler of handlers) handler(event);
  };
  const wait = (signal?: AbortSignal): Promise<void> =>
    delayMs <= 0
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
  const version = (
    rootSessionId: string,
  ): { rootSessionId: string; runtimeEpoch: string; revision: number } => ({
    rootSessionId,
    runtimeEpoch: EPOCH,
    revision,
  });
  const find = (input: UiShellJobTarget): MockJob => {
    const found = jobs.get(input.jobId);
    if (found?.row.rootSessionId !== input.rootSessionId)
      throw coded(
        "SHELL_JOB_NOT_FOUND",
        "Task was not found in this session tree.",
      );
    return found;
  };
  setInterval(() => {
    feedTick += 1;
    let changed = false;
    for (const item of jobs.values()) {
      if (item.row.status !== "running" || !item.feed?.length) continue;
      item.output += `${item.feed[feedTick % item.feed.length] ?? ""}\n`;
      changed = true;
    }
    if (changed) emit();
  }, 1000);

  return {
    subscribe(handler: UiEventHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async listShellJobs(input: UiShellJobListQuery): Promise<UiShellJobList> {
      await wait(input.signal);
      const scoped = [...jobs.values()]
        .map((item) => item.row)
        .filter(
          (row) =>
            row.rootSessionId === input.rootSessionId &&
            (input.mode !== "background" || row.mode === "background") &&
            (input.owner?.kind === "main"
              ? row.ownerKind === "main"
              : input.owner?.kind === "subagents"
                ? row.ownerKind === "subagent"
                : true),
        )
        .sort(
          (a, b) =>
            attention(b) - attention(a) ||
            (b.endedAt ?? b.startedAt ?? b.createdAt) -
              (a.endedAt ?? a.startedAt ?? a.createdAt),
        );
      const statusCounts: Record<UiShellJobStatus, number> = {
        running: 0,
        completed: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      };
      for (const row of scoped) statusCounts[row.status] += 1;
      const start = Number(input.cursor ?? 0);
      const limit = input.limit ?? 30;
      const next = start + limit;
      return {
        ...version(input.rootSessionId),
        rows: scoped.slice(start, next),
        hasMore: next < scoped.length,
        ...(next < scoped.length ? { nextCursor: String(next) } : {}),
        pendingStartCount: 0,
        filteredCount: scoped.length,
        statusCounts,
        unconfirmedCount: scoped.filter((row) => row.cleanup === "unconfirmed")
          .length,
      };
    },
    async getShellJobOutput(
      input: UiShellJobTarget,
    ): Promise<UiShellJobOutput> {
      await wait(input.signal);
      if (name === "bg-output-fail" && !outputFailed) {
        outputFailed = true;
        throw new Error("The task output couldn't be read. Try again.");
      }
      const item = find(input);
      const bytes = new TextEncoder().encode(item.output).length;
      return {
        ...version(input.rootSessionId),
        source: item.row.status === "running" ? "live" : "saved",
        sampledAt: Date.now(),
        job: item.row,
        output: item.output.slice(-TAIL_BYTES),
        tailAvailable: item.tailAvailable ?? true,
        outputBytes: bytes + (item.extraBytes ?? 0),
        outputComplete: item.row.status === "running" ? null : true,
        outputCheckpointAt: Date.now(),
        outputTruncated: (item.extraBytes ?? 0) > 10 * 1024 * 1024,
        logAvailable: item.logPath !== undefined,
        ...(item.logPath ? { logPath: item.logPath } : {}),
      };
    },
    async stopShellJob(input: UiShellJobTarget): Promise<UiShellJobStopResult> {
      await wait(input.signal);
      const item = find(input);
      if (item.stopError) {
        if (item.stopError.code === "SHELL_JOB_OTHER_BACKEND") {
          item.row = {
            ...item.row,
            managedByCurrentBackend: false,
            canStop: false,
          };
          emit();
        } else if (item.stopError.code === "SHELL_JOB_NOT_FOUND") {
          jobs.delete(input.jobId);
          emit();
        }
        throw coded(item.stopError.code, item.stopError.message);
      }
      if (item.row.status !== "running")
        return {
          ...version(input.rootSessionId),
          outcome: "already-terminal",
          job: item.row,
        };
      // The process takes a moment to go, as a real one does.
      setTimeout(() => {
        item.row = {
          ...item.row,
          status: "cancelled",
          stopReason: "user",
          canStop: false,
          cleanup: "confirmed",
          endedAt: Date.now(),
          resultReadyAt: Date.now(),
          settledAt: Date.now(),
        };
        item.output += "\n^C\n";
        emit();
      }, 900);
      return {
        ...version(input.rootSessionId),
        outcome: "accepted",
        job: item.row,
      };
    },
  };
}
