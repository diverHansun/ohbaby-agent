import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ReasoningConfig } from "ohbaby-llm";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { DatabasePromptSubmissionStore } from "./database-store.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import {
  WorkspacePromptScheduler,
  type AcceptWorkspacePromptInput,
} from "./scheduler.js";

let directory: string | undefined;
afterEach(async () => {
  closeDatabase();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it.each([
  ["memory", false, "model"],
  ["memory", true, "model"],
  ["sqlite", false, "model"],
  ["sqlite", true, "model"],
  ["memory", false, "reasoning"],
  ["memory", true, "reasoning"],
  ["sqlite", false, "reasoning"],
  ["sqlite", true, "reasoning"],
] as const)(
  "%s overlapping retries across schedulers=%s preserve %s intent",
  async (kind, separateSchedulers, field) => {
    if (kind === "sqlite") {
      directory = await mkdtemp(join(tmpdir(), "model-replay-"));
      initDatabase({ dbPath: join(directory, "data.db") });
      getDatabase()
        .prepare(
          "INSERT INTO session (id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES ('s','p','/work','t','active',1,1,'{}')",
        )
        .run();
    }
    const store =
      kind === "sqlite"
        ? new DatabasePromptSubmissionStore()
        : new InMemoryPromptSubmissionStore();
    const options = {
      scopeKey: "review",
      store,
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    };
    const first = new WorkspacePromptScheduler(options);
    const second = separateSchedulers
      ? new WorkspacePromptScheduler(options)
      : first;
    try {
      for (const explicit of [false, true]) {
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const input = {
          clientRequestId: `same-${String(explicit)}`,
          sessionId: "s",
          text: "hello",
        };
        const delayedInput: AcceptWorkspacePromptInput =
          field === "model"
            ? {
                ...input,
                modelEntryId: explicit
                  ? "a"
                  : async (): Promise<string> => {
                      entered();
                      await gate;
                      return "a";
                    },
                reasoning: explicit
                  ? async (): Promise<undefined> => {
                      entered();
                      await gate;
                      return undefined;
                    }
                  : undefined,
              }
            : {
                ...input,
                modelEntryId: async (): Promise<string> => {
                  entered();
                  await gate;
                  return "a";
                },
                reasoning: explicit
                  ? { effort: "high" }
                  : (): Promise<ReasoningConfig> =>
                      Promise.resolve({ effort: "high" }),
              };
        const delayed = first.accept(delayedInput);
        await waiting;
        const winner = await second.accept({
          ...input,
          modelEntryId: () => Promise.resolve(field === "model" ? "b" : "a"),
          reasoning:
            field === "reasoning"
              ? (): Promise<ReasoningConfig> =>
                  Promise.resolve({ effort: "low" })
              : undefined,
        });
        release();
        if (explicit)
          await expect(delayed).rejects.toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
          });
        else
          await expect(delayed).resolves.toMatchObject({
            record: {
              promptId: winner.record.promptId,
              modelEntryId: field === "model" ? "b" : "a",
              ...(field === "reasoning"
                ? { reasoning: { effort: "low" } }
                : {}),
            },
          });
        expect(
          (await store.getByClientRequestId("review", input.clientRequestId))
            ?.modelEntryId,
        ).toBe(field === "model" ? "b" : "a");
        await second.waitForCompletion(winner.record.promptId);
      }
    } finally {
      first.close();
      second.close();
    }
  },
);
