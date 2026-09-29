import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Storage, StorageKey } from "../../services/storage/index.js";
import { PathResolver } from "../../services/storage/path-resolver.js";
import {
  isProbablyBinaryTextFile,
  TEXT_FILE_SAMPLE_BYTES,
} from "../../tools/utils/text-files.js";
import type {
  ExecutionArtifact,
  ExecutionLookup,
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "./execution-store.js";

export const INLINE_SUBAGENT_RESULT_BYTES = 51_200;
export interface InternalResultAccess {
  readonly path: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly operation: "read" | "write";
}
export interface PreparedSubagentResult {
  readonly body: string;
  readonly artifact?: ExecutionArtifact;
}
export interface SubagentResultArtifacts {
  prepare(
    input: ExecutionLookup,
    options?: { forceFile?: boolean; signal?: AbortSignal },
  ): Promise<PreparedSubagentResult>;
  authorizeRead(input: InternalResultAccess): Promise<boolean>;
  deleteSession(sessionId: string): Promise<void>;
}
function identity(record: SubagentExecutionRecord): string {
  return `Runtime subagent result\nnotificationId: ${record.delivery.notificationId ?? "foreground"}\nrootRunId: ${record.rootRunId}\nrequester: ${record.parentSessionId}/${record.requesterScopeId}\nsubagentId: ${record.subagentId}\nexecutionId: ${record.executionId}\nchild: ${record.childSessionId ?? "not created"}/${record.childScopeId ?? "not created"}\nchildRunId: ${record.childRunId ?? "not started"}\nstatus: ${record.status}${record.reason ? `\nreason: ${record.reason}` : ""}${record.error ? `\nerror: ${record.error}` : ""}`;
}
export function createSubagentResultArtifacts(options: {
  readonly store: SubagentExecutionStore;
  readonly storage: Storage;
  readonly rootDir?: string;
  readonly sessionExists: (sessionId: string) => Promise<boolean>;
  readonly now?: () => number;
}): SubagentResultArtifacts {
  const resolver = new PathResolver(options.rootDir);
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<PreparedSubagentResult>>();
  const keyFor = (record: SubagentExecutionRecord): StorageKey => [
    "subagent-results",
    record.parentSessionId,
    record.subagentId,
    `${record.executionId}.output`,
  ];
  const lookupFor = (record: SubagentExecutionRecord): ExecutionLookup => ({
    executionId: record.executionId,
    parentSessionId: record.parentSessionId,
    requesterScopeId: record.requesterScopeId,
  });
  async function alive(record: SubagentExecutionRecord): Promise<boolean> {
    return (
      record.artifact.state !== "deleted" &&
      (await options.sessionExists(record.rootSessionId)) &&
      (!record.childSessionId ||
        (await options.sessionExists(record.childSessionId)))
    );
  }
  async function clean(record: SubagentExecutionRecord): Promise<void> {
    try {
      await options.storage.remove(keyFor(record));
      await options.store.updateArtifact(
        lookupFor(record),
        { state: "deleted", cleanupPending: false },
        now(),
      );
    } catch (error) {
      await options.store.updateArtifact(
        lookupFor(record),
        {
          state: "deleted",
          cleanupPending: true,
          error: error instanceof Error ? error.message : String(error),
        },
        now(),
      );
      throw error;
    }
  }
  async function canonical(path: string): Promise<boolean> {
    try {
      if ((await lstat(path)).isSymbolicLink()) return false;
      const root = await realpath(resolver.rootDir);
      return (
        (await realpath(path)) ===
        resolve(root, relative(resolver.rootDir, path))
      );
    } catch {
      return false;
    }
  }
  async function exportResult(
    input: ExecutionLookup,
    signal?: AbortSignal,
  ): Promise<PreparedSubagentResult> {
    let record = await options.store.get(input);
    if (!record)
      throw new Error("Result execution not found in requester scope");
    const prefix = identity(record);
    const key = keyFor(record);
    const path = resolver.resolve(key);
    if (!(await alive(record))) {
      await options.store.updateArtifact(
        input,
        { state: "deleted", cleanupPending: true },
        now(),
      );
      await clean(record);
      return {
        body: `${prefix}\nResult artifact deleted.`,
        artifact: { state: "deleted", cleanupPending: false },
      };
    }
    if (record.status === "queued" || record.status === "running")
      throw new Error("Result is not terminal");
    if (record.output === undefined)
      return { body: `${prefix}\nNo final report body was produced.` };
    if (
      record.output.includes("\0") ||
      isProbablyBinaryTextFile(
        path,
        Buffer.from(record.output, "utf8").subarray(0, TEXT_FILE_SAMPLE_BYTES),
      )
    ) {
      const artifact: ExecutionArtifact = {
        state: "error",
        error:
          "Complete result is saved, but its binary text format is unsupported by Read.",
      };
      await options.store.updateArtifact(input, artifact, now());
      return { body: `${prefix}\n${artifact.error}`, artifact };
    }
    if (
      record.artifact.state === "ready" &&
      record.artifact.path === path &&
      (await canonical(path))
    )
      return {
        body: `${prefix}\nComplete result: ${path}\nsizeBytes: ${String(record.artifact.sizeBytes)}\nestimatedTokens: ${String(Math.ceil(record.artifact.sizeBytes / 4))}`,
        artifact: record.artifact,
      };
    let failure = "Result export failed";
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        record = await options.store.get(input);
        if (!record || !(await alive(record)))
          throw new Error("Result artifact deleted");
        await options.store.updateArtifact(
          input,
          { state: "preparing" },
          now(),
        );
        // Storage owns atomic replacement; reject redirected parent directories before writing.
        await resolver.ensureParent(path);
        const root = await realpath(resolver.rootDir);
        if (
          (await realpath(dirname(path))) !==
          resolve(root, relative(resolver.rootDir, dirname(path)))
        )
          throw new Error("Result directory is redirected");
        await options.storage.writeText(key, record.output ?? "");
        const current = await options.store.get(input);
        if (!current || !(await alive(current))) {
          await options.storage.remove(key);
          throw new Error("Result artifact deleted");
        }
        if (!(await canonical(path)))
          throw new Error("Result path is redirected");
        const artifact: ExecutionArtifact = {
          state: "ready",
          path,
          sizeBytes: Buffer.byteLength(record.output ?? "", "utf8"),
        };
        await options.store.updateArtifact(input, artifact, now());
        return {
          body: `${prefix}\nComplete result: ${path}\nsizeBytes: ${String(artifact.sizeBytes)}\nestimatedTokens: ${String(Math.ceil(artifact.sizeBytes / 4))}`,
          artifact,
        };
      } catch (error) {
        signal?.throwIfAborted();
        failure = error instanceof Error ? error.message : String(error);
        const current = await options.store.get(input);
        if (!current || current.artifact.state === "deleted") {
          if (current) await clean(current);
          return {
            body: `${prefix}\nResult artifact deleted.`,
            artifact: current?.artifact,
          };
        }
      }
    }
    const artifact: ExecutionArtifact = { state: "error", error: failure };
    await options.store.updateArtifact(input, artifact, now());
    return {
      body: `${prefix}\nExecution ended; complete result remains saved in the database, but its result file is unavailable: ${failure}`,
      artifact,
    };
  }
  return {
    async prepare(input, settings = {}): Promise<PreparedSubagentResult> {
      const record = await options.store.get(input);
      if (!record)
        throw new Error("Result execution not found in requester scope");
      if (record.status === "queued" || record.status === "running")
        throw new Error("Result is not terminal");
      if (
        !settings.forceFile &&
        (await alive(record)) &&
        Buffer.byteLength(record.output ?? "", "utf8") <=
          INLINE_SUBAGENT_RESULT_BYTES
      )
        return {
          body: `${identity(record)}\n\n${record.output ?? "No final report body was produced."}`,
        };
      const existing = pending.get(record.executionId);
      if (existing) return existing;
      const operation = exportResult(input, settings.signal);
      pending.set(record.executionId, operation);
      try {
        return await operation;
      } finally {
        pending.delete(record.executionId);
      }
    },
    async authorizeRead(input): Promise<boolean> {
      if (input.operation !== "read") return false;
      const path = resolve(input.path);
      let root: string;
      try {
        root = await realpath(resolver.rootDir);
      } catch {
        return false;
      }
      const lexicalRelative = relative(resolver.rootDir, path);
      const segments = (
        lexicalRelative.startsWith(`..${sep}`)
          ? relative(root, path)
          : lexicalRelative
      ).split(sep);
      if (
        segments.length !== 4 ||
        segments[0] !== "subagent-results" ||
        segments[1] !== input.sessionId ||
        !segments[3].endsWith(".output")
      )
        return false;
      const record = await options.store.get({
        executionId: segments[3].slice(0, -7),
        parentSessionId: input.sessionId,
        requesterScopeId: input.contextScopeId ?? "primary",
      });
      return (
        !!record &&
        record.artifact.state === "ready" &&
        record.artifact.path === resolver.resolve(keyFor(record)) &&
        (path === record.artifact.path ||
          path === resolve(root, ...keyFor(record))) &&
        (await alive(record)) &&
        (await canonical(record.artifact.path))
      );
    },
    async deleteSession(sessionId): Promise<void> {
      const records = await options.store.revokeSessionArtifacts(
        sessionId,
        now(),
      );
      const results = await Promise.allSettled(records.map(clean));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
