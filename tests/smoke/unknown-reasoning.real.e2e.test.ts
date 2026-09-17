import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  UiPromptCompletion,
  UiPromptReceipt,
  UiSnapshot,
} from "ohbaby-sdk";
import { createDaemonServerApp } from "../../packages/ohbaby-server/src/app/create-app.js";
import {
  auditFormalNativeReplay,
  auditFormalToolExchange,
} from "./formal-cache-observer.js";
import {
  createFormalCacheSession,
  finalizeReasoningEvidence,
  getFormalSetupFailureEvidence,
} from "./formal-cache-session.js";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";
import { decideControlledPermission } from "./formal-cache-live-context.js";

const enabled =
  process.env.OHBABY_RUN_REAL_SESSION_REASONING === "1" &&
  process.env.OHBABY_REAL_REASONING_UNKNOWN === "1";

type FormalSession = Awaited<ReturnType<typeof createFormalCacheSession>>;
function unknownSessionEvidence(
  session: FormalSession | undefined,
  error: unknown,
): {
  cleanupErrors: string[];
  diagnosticWorkspace?: string;
  providerRequests: FormalSession["providerRequests"];
  wire: FormalSession["wire"];
} {
  const setup = getFormalSetupFailureEvidence(error);
  return {
    cleanupErrors: session?.cleanupErrors ?? setup?.cleanupErrors ?? [],
    diagnosticWorkspace: session?.root ?? setup?.diagnosticWorkspace,
    providerRequests: session?.providerRequests ?? [],
    wire: session?.wire ?? setup?.wire ?? [],
  };
}

async function finalizeUnknownEvidence(options: {
  session?: FormalSession;
  handle?: Pick<ReturnType<typeof createDaemonServerApp>, "dispose">;
  unsubscribe(): void;
  originalFetch: typeof fetch;
  primaryFailed: boolean;
  cleanupErrors: string[];
  save(): Promise<void>;
}): Promise<void> {
  await finalizeReasoningEvidence({
    ...options,
    cleanup: [
      { code: "PERMISSION_UNSUBSCRIBE_FAILED", run: options.unsubscribe },
      { code: "DAEMON_DISPOSE_FAILED", run: () => options.handle?.dispose() },
      { code: "SESSION_CLOSE_FAILED", run: () => options.session?.close() },
      {
        code: "METADATA_FETCH_RESTORE_FAILED",
        run: () => {
          globalThis.fetch = options.originalFetch;
        },
      },
    ],
  });
}

describe("unknown reasoning finalizer (no network)", () => {
  it("restores the metadata fetch wrapper and keeps the original failure when cleanup and evidence writing reject", async () => {
    const originalFetch = globalThis.fetch;
    const original = new Error("original assertion");
    const cleanupErrors: string[] = [];
    const close = vi.fn(async () => {
      throw new Error("private close");
    });
    const save = vi.fn(async () => {
      expect(globalThis.fetch).toBe(originalFetch);
      throw new Error("private evidence error");
    });
    globalThis.fetch = vi.fn<typeof fetch>();
    try {
      await expect(
        (async () => {
          try {
            throw original;
          } finally {
            await finalizeUnknownEvidence({
              originalFetch,
              primaryFailed: true,
              cleanupErrors,
              save,
              unsubscribe: () => {
                throw new Error("private unsubscribe");
              },
              handle: {
                dispose: async () => {
                  throw new Error("private dispose");
                },
              },
              session: { close } as unknown as FormalSession,
            });
          }
        })(),
      ).rejects.toBe(original);
      expect(close).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledOnce();
      expect(cleanupErrors).toEqual([
        "PERMISSION_UNSUBSCRIBE_FAILED",
        "DAEMON_DISPOSE_FAILED",
        "SESSION_CLOSE_FAILED",
        "EVIDENCE_WRITE_FAILED",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("writes safe factory-setup failure evidence even when no session was returned", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubEnv("ZENMUX_API_KEY", "fixture-only-key");
    let error: unknown;
    const cleanupErrors: string[] = [];
    try {
      try {
        await createFormalCacheSession("zenmux-gpt56-luna-responses", {
          emptyConfig: true,
          maxRequests: 0,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      const save = vi.fn(async () => {
        const evidence = unknownSessionEvidence(undefined, error);
        expect(evidence.diagnosticWorkspace).toBeTruthy();
        expect(evidence.wire).toEqual([]);
        expect(evidence.providerRequests).toEqual([]);
        expect(JSON.stringify(evidence)).not.toContain("fixture-only-key");
      });
      await finalizeUnknownEvidence({
        originalFetch,
        primaryFailed: true,
        cleanupErrors,
        save,
        unsubscribe: () => {},
      });
      expect(save).toHaveBeenCalledOnce();
      expect(cleanupErrors).toEqual([]);
    } finally {
      const root = getFormalSetupFailureEvidence(error)?.diagnosticWorkspace;
      if (root)
        await (
          await import("node:fs/promises")
        ).rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
      globalThis.fetch = originalFetch;
    }
  });
});

describe.runIf(enabled)(
  "Stage C: unknown metadata, real Responses generation",
  () => {
    it("preserves high preference while omitting unverified controls and replaying saved history", async () => {
      const profile = NATIVE_REAL_PROFILES.find(
        (item) => item.id === "zenmux-gpt56-luna-responses",
      )!;
      const evidencePath =
        ".ohbaby/test-evidence/improve-8/stage-c/unknown-responses.json";
      await mkdir(join(dirname(evidencePath), "previous-runs"), {
        recursive: true,
      });
      try {
        await copyFile(
          evidencePath,
          join(
            dirname(evidencePath),
            "previous-runs",
            `unknown-responses-${Date.now()}.json`,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const originalFetch = globalThis.fetch;
      let metadataFixtures = 0;
      // Only capability discovery is controlled. Every generation request uses the real transport.
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        if (
          method === "GET" &&
          url.origin === "https://zenmux.ai" &&
          url.pathname === "/api/v1/models"
        ) {
          metadataFixtures++;
          return new Response(
            JSON.stringify({
              data: [{ id: profile.model, context_length: 1_050_000 }],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return originalFetch(input, init);
      };
      let session:
        | Awaited<ReturnType<typeof createFormalCacheSession>>
        | undefined;
      let handle: ReturnType<typeof createDaemonServerApp> | undefined;
      let unsubscribe = (): void => {};
      let passed = false,
        phase = "setup";
      let primaryFailed = false;
      let primaryError: unknown;
      const cleanupErrors: string[] = [];
      const permissionErrors: string[] = [];
      const permissionTasks: Promise<void>[] = [];
      const completions: string[] = [];
      let nativeEvidence: unknown;
      let capability: unknown;
      let preservedPreference: unknown;
      const authToken = randomUUID(),
        clientId = randomUUID();
      async function request<T>(
        path: string,
        method = "GET",
        body?: unknown,
      ): Promise<T> {
        const response = await handle!.app.request(path, {
          method,
          headers: {
            authorization: `Bearer ${authToken}`,
            "x-ohbaby-client-id": clientId,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok)
          throw new Error(`UNKNOWN_LIVE_REST_${response.status}`);
        return (await response.json()) as T;
      }
      async function start(resumeSessionId?: string): Promise<void> {
        handle = createDaemonServerApp({
          backend: session!.backend,
          authToken,
          commandRecorder: false,
        });
        await handle.start();
        await request("/v1/clients", "POST", {
          clientId,
          ...(resumeSessionId ? { startupIntent: { resumeSessionId } } : {}),
        });
        unsubscribe = session!.backend.subscribeEvents((event) => {
          if (event.type !== "permission.requested") return;
          permissionTasks.push(
            (async () => {
              const selection = decideControlledPermission(
                event.request,
                await session!.backend.getSnapshot(),
                dirname(session!.readFilePath),
                session!.readFilePath,
              );
              await session!.backend.respondPermission(event.request.id, {
                choiceId: selection.choiceId,
                remember: false,
              });
            })().catch(async () => {
              permissionErrors.push("PERMISSION_HANDLER_FAILED");
              await session!.backend.abortRun(event.request.runId);
            }),
          );
        });
      }
      async function submit(sessionId: string, text: string): Promise<void> {
        const receipt = await request<UiPromptReceipt>("/v1/prompts", "POST", {
          text,
          sessionId,
          clientRequestId: randomUUID(),
        });
        const { completion } = await request<{
          completion: UiPromptCompletion;
        }>(`/v1/prompts/${receipt.promptId}/completion`);
        completions.push(completion.prompt.status);
        expect(completion.prompt.status).toBe("succeeded");
        await Promise.all(permissionTasks);
      }
      try {
        session = await createFormalCacheSession(profile.id, {
          emptyConfig: true,
          maxRequests: 20,
        });
        await start();
        expect(
          (await request<{ model: unknown }>("/v1/model")).model,
        ).toBeNull();
        phase = "save-and-detect";
        await request("/v1/model", "POST", {
          provider: "live-unknown-provider",
          model: profile.model,
          baseUrl: profile.baseUrl,
          interfaceProvider: profile.protocol,
          apiKeyEnv: "ZENMUX_API_KEY",
          maxOutputTokens: 4096,
        });
        type Model = { reasoning?: { status: string; efforts: string[] } };
        let current = (await request<{ model: Model }>("/v1/model")).model;
        const deadline = Date.now() + 20_000;
        while (
          current.reasoning?.status === "detecting" &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          current = (await request<{ model: Model }>("/v1/model")).model;
        }
        capability = current.reasoning;
        expect(current.reasoning).toMatchObject({
          status: "unknown",
          efforts: [],
        });
        expect(metadataFixtures).toBeGreaterThan(0);
        await request("/v1/sessions", "POST", {});
        const sessionId = (
          await request<{ snapshot: UiSnapshot }>("/v1/snapshot")
        ).snapshot.activeSessionId!;
        expect(sessionId).toBeTruthy();
        await request(`/v1/sessions/${sessionId}/reasoning`, "PATCH", {
          reasoning: { enabled: true, effort: "high" },
        });
        phase = "unknown-tool-loop";
        await submit(
          sessionId,
          `Read ${session.readFilePath} exactly once using only the read tool and file_path argument. Report Project, Release and Owner. Do not change files or use shell.`,
        );
        const first = await session.checkpoint("unknown-tool");
        expect(first.answer).toMatchObject({
          project: true,
          release: true,
          owner: true,
        });
        expect(first.persisted.completedTools.length).toBeGreaterThan(0);
        expect(
          first.persisted.completedTools.every((item) => item.allowed),
        ).toBe(true);
        expect(first.privateStateVisible).toBe(false);
        const nativeBefore = session.nativeStateHashes(
          "unknown-before-reopen",
        ).active;
        phase = "unknown-reopen";
        unsubscribe();
        await handle!.dispose();
        await session.reopen();
        await start(sessionId);
        const restored = (
          await request<{ snapshot: UiSnapshot }>("/v1/snapshot")
        ).snapshot.sessions.find(
          (item) => item.id === sessionId,
        ) as unknown as { reasoning?: unknown };
        preservedPreference = restored.reasoning;
        expect(preservedPreference).toEqual({ enabled: true, effort: "high" });
        const nativeAfter = session.nativeStateHashes(
          "unknown-after-reopen",
        ).active;
        expect(nativeAfter).toEqual(nativeBefore);
        const boundary = session.providerRequests.length;
        await submit(
          sessionId,
          "Report the Project, Release and Owner from the prior conversation. Do not use tools.",
        );
        const last = await session.checkpoint("unknown-restored");
        expect(last.answer).toMatchObject({
          project: true,
          release: true,
          owner: true,
        });
        expect(last.privateStateVisible).toBe(false);
        const resumed = session.providerRequests
          .slice(boundary)
          .find((item) => item.purpose === "agent-step");
        expect(resumed).toBeDefined();
        const nativeReplay = auditFormalNativeReplay(
          nativeBefore,
          resumed?.replayStateHashes,
        );
        expect(nativeReplay.valid).toBe(true);
        nativeEvidence = {
          emitted: nativeBefore.length > 0,
          before: nativeBefore,
          after: nativeAfter,
          replay: resumed?.replayStateHashes,
          replayChecked: nativeReplay.exercised,
          valid: nativeReplay.valid,
        };
        const wire = session.wire.filter((item) => item.kind === "generation");
        expect(wire.length).toBeGreaterThanOrEqual(3);
        for (const item of wire) {
          expect(item).toMatchObject({
            protocol: "openai-responses",
            model: profile.model,
            encryptedReasoningRequested: true,
            reasoning: { controlFields: [] },
          });
          if (item.context?.purpose === "agent-step") {
            expect(item.status).toBe(200);
            expect(item.captureError).toBeUndefined();
          }
        }
        expect(
          auditFormalToolExchange(
            wire.filter((item) => item.context?.purpose === "agent-step"),
          ),
        ).toMatchObject({ exercised: true, valid: true });
        expect(permissionErrors).toEqual([]);
        passed = true;
      } catch (error) {
        primaryFailed = true;
        primaryError = error;
        throw error;
      } finally {
        await finalizeUnknownEvidence({
          session,
          handle,
          unsubscribe,
          originalFetch,
          primaryFailed,
          cleanupErrors,
          save: async () => {
            const sessionEvidence = unknownSessionEvidence(
              session,
              primaryError,
            );
            await writeFile(
              evidencePath,
              JSON.stringify(
                {
                  stage: "C",
                  profile: profile.id,
                  metadata: "fixture: exact ID/window, no reasoning fields",
                  generation: "real provider",
                  metadataFixtures,
                  emptyConfig: true,
                  seededVerifiedCapabilities: false,
                  phase,
                  result:
                    passed && cleanupErrors.length === 0 ? "passed" : "failed",
                  capability,
                  preservedPreference,
                  nativeEvidence,
                  completions,
                  permissionErrors,
                  ...(primaryFailed
                    ? {
                        failure: {
                          phase,
                          code:
                            primaryError instanceof Error &&
                            primaryError.name === "AssertionError"
                              ? "ASSERTION_FAILED"
                              : "UNKNOWN_STAGE_C_FAILED",
                        },
                      }
                    : {}),
                  ...sessionEvidence,
                  cleanupErrors: [
                    ...cleanupErrors,
                    ...sessionEvidence.cleanupErrors,
                  ],
                },
                null,
                2,
              ) + "\n",
            );
          },
        });
      }
    });
  },
);
