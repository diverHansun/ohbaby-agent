import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createStorage } from "../../services/storage/index.js";
import { InMemorySubagentExecutionStore } from "./execution-store.js";
import { createSubagentResultArtifacts } from "./result-artifacts.js";

describe("subagent result continuation hint", () => {
  it.each([
    { status: "failed", instance: "open", expected: true },
    { status: "failed", instance: "closed", expected: false },
    { status: "failed", instance: "missing", expected: false },
    { status: "timed_out", instance: "open", expected: false },
  ] as const)(
    "includes hint ($expected) for $status with instance $instance",
    async ({ status, instance, expected }) => {
      const lookup = {
        executionId: "execution",
        parentSessionId: "parent",
        requesterScopeId: "scope",
      };
      const store = new InMemorySubagentExecutionStore();
      await store.accept({
        ...lookup,
        requestId: "call",
        requesterRunId: "run",
        rootSessionId: "parent",
        rootRunId: "run",
        subagentId: "child",
        mode: "background",
        prompt: "Research the project",
        createdAt: 1,
      });
      await store.bindChild(
        lookup,
        { sessionId: "child-session", contextScopeId: "child-scope" },
        2,
      );
      await store.finish(lookup, { status, completedAt: 3 });
      const rootDir = tmpdir();
      const artifacts = createSubagentResultArtifacts({
        store,
        storage: createStorage({ rootDir }),
        rootDir,
        sessionExists: () => Promise.resolve(true),
        readDeliveryContext: () =>
          Promise.resolve({
            name: instance === "missing" ? undefined : "Researcher",
            isInstanceOpen: instance === "open",
          }),
      });
      const result = await artifacts.prepare(lookup);
      expect(result.body.includes("you can send it a follow-up task")).toBe(
        expected,
      );
    },
  );
});
