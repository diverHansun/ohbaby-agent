import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  initDatabase,
  closeDatabase,
  getDatabase,
} from "../../../../../../packages/ohbaby-agent/src/services/database/index.ts";
import { createDatabaseRunLedger } from "../../../../../../packages/ohbaby-agent/src/runtime/run-ledger/database.ts";
import { createInProcessUiBackendClient } from "../../../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts";
import { createPersistentUiStateStore } from "../../../../../../packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts";

const directory = await mkdtemp(join(tmpdir(), "ohbaby-snapshot-probe-"));
const counts = { prepare: 0, get: 0, all: 0, ledgerGet: 0, ledgerList: 0 };
try {
  initDatabase({ dbPath: join(directory, "fixture.db") });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session (id, project_id, project_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("session_1", "probe", directory, 0, 0);
  const insert = db.prepare(
    "INSERT INTO run_ledger (run_id, session_id, trigger, status, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (let index = 0; index < 1000; index += 1) {
    insert.run(`run_${index}`, "session_1", "user", "succeeded", index);
  }
  const instrumentedDb = {
    path: db.path,
    exec: (sql) => db.exec(sql),
    pragma: (name) => db.pragma(name),
    close: () => db.close(),
    prepare(sql) {
      counts.prepare += 1;
      const statement = db.prepare(sql);
      return {
        get(...args) {
          counts.get += 1;
          return statement.get(...args);
        },
        all(...args) {
          counts.all += 1;
          return statement.all(...args);
        },
        run(...args) {
          return statement.run(...args);
        },
      };
    },
  };
  const inner = createDatabaseRunLedger({ db: instrumentedDb });
  const ledger = {
    ...inner,
    get(runId) {
      counts.ledgerGet += 1;
      return inner.get(runId);
    },
    listBySession(sessionId, options) {
      counts.ledgerList += 1;
      return inner.listBySession(sessionId, options);
    },
  };
  const iso = "2026-09-29T00:00:00.000Z";
  for (const size of [0, 10, 100, 500, 1000]) {
    const snapshot = {
      activeSessionId: null,
      sessions: [
        {
          id: "session_1",
          title: "Probe",
          messages: [],
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      runs: Array.from({ length: size }, (_, index) => ({
        id: `run_${index}`,
        sessionId: "session_1",
        status: { kind: "idle" },
        startedAt: iso,
        updatedAt: iso,
      })),
      permissions: [],
      status: { kind: "idle" },
    };
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
      runLedger: ledger,
    });
    for (let warmup = 0; warmup < 3; warmup += 1) await client.getSnapshot();
    const measurements = [];
    const before = { ...counts };
    for (let iteration = 0; iteration < 15; iteration += 1) {
      const start = performance.now();
      const result = await client.getSnapshot();
      measurements.push(performance.now() - start);
      if (result.runs.length !== size)
        throw new Error(`wrong run count ${result.runs.length}`);
    }
    measurements.sort((a, b) => a - b);
    const delta = Object.fromEntries(
      Object.keys(counts).map((key) => [key, counts[key] - before[key]]),
    );
    console.log(
      JSON.stringify({
        size,
        iterations: 15,
        perSnapshot: Object.fromEntries(
          Object.entries(delta).map(([key, value]) => [key, value / 15]),
        ),
        medianMs: measurements[7],
        minMs: measurements[0],
        maxMs: measurements[14],
      }),
    );
    await client.dispose();
  }
  const session = {
    id: "session_1",
    projectRoot: directory,
    title: "Probe",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
  const sessionManager = {
    get: async (id) => (id === session.id ? session : undefined),
    listByProjectRoot: async () => [session],
    update: async () => session,
  };
  const messageManager = { listBySession: async () => [] };
  for (const size of [10, 1000]) {
    const limitedLedger = {
      ...ledger,
      listBySession(sessionId, _options) {
        counts.ledgerList += 1;
        return inner.listBySession(sessionId, { limit: size });
      },
    };
    const stateStore = createPersistentUiStateStore({
      sessionManager,
      messageManager,
      runLedger: limitedLedger,
      projectRoot: directory,
    });
    const client = createInProcessUiBackendClient({
      stateStore,
      runLedger: limitedLedger,
      projectDirectory: directory,
    });
    for (let warmup = 0; warmup < 3; warmup += 1) await client.getSnapshot();
    const measurements = [];
    const before = { ...counts };
    for (let iteration = 0; iteration < 15; iteration += 1) {
      const start = performance.now();
      const result = await client.getSnapshot();
      measurements.push(performance.now() - start);
      if (result.runs.length !== size)
        throw new Error(`wrong persistent run count ${result.runs.length}`);
    }
    measurements.sort((a, b) => a - b);
    const delta = Object.fromEntries(
      Object.keys(counts).map((key) => [key, counts[key] - before[key]]),
    );
    console.log(
      JSON.stringify({
        mode: "persistent",
        size,
        iterations: 15,
        perSnapshot: Object.fromEntries(
          Object.entries(delta).map(([key, value]) => [key, value / 15]),
        ),
        medianMs: measurements[7],
        minMs: measurements[0],
        maxMs: measurements[14],
      }),
    );
    await client.dispose();
  }
} finally {
  closeDatabase();
  await rm(directory, { recursive: true, force: true });
}
