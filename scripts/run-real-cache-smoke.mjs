#!/usr/bin/env node
import {
  aggregateCacheGateResults,
  executeVitestGate,
  exitCodeForCacheGateAggregate,
  formatCacheGateAggregate,
  formatCacheGateResult,
  loadRootDotenv,
  REAL_CACHE_GATES,
  runCacheGates,
} from "./real-cache-runner.mjs";

const requestedGate = process.argv
  .find((argument) => argument.startsWith("--gate="))
  ?.slice("--gate=".length);
const gates =
  requestedGate === undefined
    ? REAL_CACHE_GATES
    : REAL_CACHE_GATES.filter((gate) => gate.id === requestedGate);

if (gates.length === 0) {
  console.error(`[real-cache] unknown gate: ${requestedGate}`);
  process.exit(1);
}

const env = loadRootDotenv();
env.OHBABY_REAL_CACHE_EVIDENCE_DIR ??= `${process.cwd()}/.ohbaby/test-evidence/improve-5/real-cache`;
const results = await runCacheGates({
  env,
  executeGate: executeVitestGate,
  gates,
});

for (const result of results) {
  console.log(formatCacheGateResult(result));
}
const aggregate = aggregateCacheGateResults(results);
console.log(`[real-cache] aggregate: ${formatCacheGateAggregate(aggregate)}`);
process.exit(exitCodeForCacheGateAggregate(aggregate));
