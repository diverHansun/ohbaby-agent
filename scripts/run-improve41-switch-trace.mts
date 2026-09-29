/** Trace the real Web runtime against the owned compiled-daemon fixture. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOhbabyWebRuntime } from "../apps/ohbaby-web/src/runtime.js";

const manifest = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  root: string;
  workspace: string;
  port: number;
  token: string;
  sessions: { A: string; B: string };
};
const baseline = process.argv.includes("--baseline");
const requests: { path: string; elapsedMs: number; status: number }[] = [];
let indexFetches = 0;
let pendingIndexFetches = 0;
const fetchImpl: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const started = performance.now();
  const index = url.pathname === "/v1/sessions/index";
  if (index) {
    indexFetches++;
    pendingIndexFetches++;
  }
  let response: Response;
  try {
    response = await fetch(input, init);
    if (index) await response.clone().arrayBuffer();
  } finally {
    if (index) pendingIndexFetches--;
  }
  if (url.pathname.endsWith("/view"))
    requests.push({
      path: url.pathname,
      elapsedMs: performance.now() - started,
      status: response.status,
    });
  return response;
};
const config = {
  baseUrl: `http://127.0.0.1:${manifest.port}`,
  token: manifest.token,
  directory: manifest.workspace,
};
const runtime = createOhbabyWebRuntime(
  { ...config, clientId: "i41-trace" },
  { fetch: fetchImpl },
);
const rows: unknown[] = [];
let activeTrace: { states: unknown[]; errors: string[] } | undefined;
const unsubscribe = runtime.store.subscribe(() => {
  if (!activeTrace) return;
  const state = runtime.store.getSnapshot().sessionSync;
  const event = {
    status: state.status,
    sessionId: state.scope?.sessionId,
    attempts: state.attempts,
    generation: state.view?.version.viewGeneration,
    error: state.error,
  };
  if (JSON.stringify(activeTrace.states.at(-1)) !== JSON.stringify(event))
    activeTrace.states.push(event);
  if (state.error) activeTrace.errors.push(state.error);
});
async function ready(sessionId: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = runtime.store.getSnapshot().sessionSync;
    if (state.status === "ready" && state.scope?.sessionId === sessionId)
      return;
    if (state.status === "error")
      throw new Error(state.error ?? "Session failed");
    await delay(5);
  }
  throw new Error("Session readiness timeout");
}
let second: ReturnType<typeof createOhbabyWebRuntime> | undefined;
let witnessSessionId: string | undefined;
let witnessArchived = false;
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}
async function drainIndex(): Promise<void> {
  await until(() => pendingIndexFetches === 0, "Index fetch did not finish");
  // Let the already-read HTTP response publish its store update.
  await new Promise<void>((resolve) => setImmediate(resolve));
}
try {
  await runtime.ready;
  for (let pass = 0; pass < 3; pass++) {
    for (const label of ["A", "B", "A", "B", "B"] as const) {
      const trace = { states: [] as unknown[], errors: [] as string[] };
      activeTrace = trace;
      const start = performance.now(),
        count = requests.length;
      await runtime.selectSession(manifest.sessions[label]);
      await ready(manifest.sessions[label]);
      activeTrace = undefined;
      const row = {
        pass,
        label,
        elapsedMs: performance.now() - start,
        baselines: requests.slice(count),
        ...trace,
      };
      rows.push(row);
      console.log(
        JSON.stringify({
          pass,
          label,
          elapsedMs: row.elapsedMs,
          baselines: row.baselines.length,
          errors: [...new Set(trace.errors)],
        }),
      );
      if (!baseline) {
        assert.equal(
          row.baselines.length,
          1,
          "Healthy selection should read one baseline",
        );
        assert.deepEqual(
          trace.errors,
          [],
          "Healthy selection entered recovery",
        );
      }
    }
  }
  second = createOhbabyWebRuntime({ ...config, clientId: "i41-trace-second" });
  await second.ready;
  assert.ok(second.client);
  const witness = await second.client.createSession();
  assert.equal(witness.created, true);
  assert.ok(!Object.values(manifest.sessions).includes(witness.id));
  witnessSessionId = witness.id;
  // REST create need not broadcast to peers. Seed client one's index via its
  // normal binding refresh, then measure the independent peer selection.
  await runtime.selectSession(manifest.sessions.B);
  await ready(manifest.sessions.B);
  await until(
    () =>
      runtime.store
        .getSnapshot()
        .sessionIndex.some((session) => session.id === witnessSessionId),
    "First client did not load the fresh fixture session",
  );
  await drainIndex();
  const generation =
    runtime.store.getSnapshot().sessionSync.view?.version.viewGeneration;
  const before = requests.length;
  const beforeIndex = runtime.store.getSnapshot().sessionIndex;
  const beforeIndexFetches = indexFetches;
  activeTrace = { states: [], errors: [] };
  await second.selectSession(manifest.sessions.B);
  const deadline = Date.now() + 10000;
  while (second.store.getSnapshot().sessionSync.status !== "ready") {
    assert.ok(Date.now() < deadline, "Second client readiness timeout");
    await delay(5);
  }
  // REST selection may deliberately emit no peer event. Archiving an empty
  // fixture session afterwards supplies a causally later index broadcast on
  // the same ordered SSE stream, proving client one has drained earlier events.
  await second.client.archiveSession({ sessionId: witnessSessionId });
  witnessArchived = true;
  await until(
    () =>
      indexFetches > beforeIndexFetches &&
      runtime.store.getSnapshot().sessionIndex !== beforeIndex &&
      !runtime.store
        .getSnapshot()
        .sessionIndex.some((session) => session.id === witnessSessionId),
    "First client did not observe the later index witness",
  );
  await drainIndex();
  const peer = {
    generationBefore: generation,
    generationAfter:
      runtime.store.getSnapshot().sessionSync.view?.version.viewGeneration,
    additionalBaselines: requests.length - before,
    indexRefreshesObserved: indexFetches - beforeIndexFetches,
    witnessSessionObserved: true,
    ...activeTrace,
  };
  rows.push({ peer });
  if (!baseline) {
    assert.equal(peer.generationAfter, generation);
    assert.equal(peer.additionalBaselines, 0);
    assert.deepEqual(peer.errors, []);
    assert.equal(runtime.store.getSnapshot().sessionSync.status, "ready");
    assert.equal(
      runtime.store.getSnapshot().sessionSync.scope?.sessionId,
      manifest.sessions.B,
    );
  }
} finally {
  unsubscribe();
  const cleanupErrors: unknown[] = [];
  try {
    if (witnessSessionId && !witnessArchived)
      await second?.client?.archiveSession({ sessionId: witnessSessionId });
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const result of await Promise.allSettled([
    second?.dispose(),
    runtime.dispose(),
  ])) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  await writeFile(
    join(
      manifest.root,
      baseline ? "switch-baseline.json" : "switch-fixed.json",
    ),
    JSON.stringify(
      { rows, requests, cleanupErrors: cleanupErrors.map(String) },
      null,
      2,
    ),
  );
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Trace cleanup failed");
}
