import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  UiPromptCompletion,
  UiPromptReceipt,
  UiSnapshot,
} from "ohbaby-sdk";
import { createDaemonServerApp } from "../../packages/ohbaby-server/src/app/create-app.js";
import {
  createFormalCacheSession,
  finalizeReasoningEvidence,
  getFormalSetupFailureEvidence,
} from "./formal-cache-session.js";
import {
  auditFormalNativeReplay,
  auditFormalToolExchange,
  hasValidFormalToolPairing,
  type FormalCacheGenerationEvidence,
} from "./formal-cache-observer.js";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";
import { decideControlledPermission } from "./formal-cache-live-context.js";
import * as persistent from "../../packages/ohbaby-agent/src/adapters/ui-persistent.js";
import * as loaders from "../../packages/ohbaby-agent/src/config/llm/loaders.js";

// Spies below are used only by the no-network restoration tests; default exports
// are the original filesystem implementation, including in opted-in live runs.
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const enabled = process.env.OHBABY_RUN_REAL_SESSION_REASONING === "1";
const supported = [
  "zenmux-gpt56-luna-chat",
  "zenmux-gpt56-luna-responses",
  "zenmux-claude-sonnet5-anthropic",
];

describe("Stage C finalizer boundaries (no network)", () => {
  it("attempts close, restoration and safe evidence after disposal failures without replacing the primary error", async () => {
    const original = new Error("original assertion");
    const cleanupErrors: string[] = [],
      visited: string[] = [];
    const save = vi.fn(async () => {
      visited.push("save");
    });
    await expect(
      (async () => {
        try {
          throw original;
        } finally {
          await finalizeReasoningEvidence({
            primaryFailed: true,
            cleanupErrors,
            save,
            cleanup: [
              {
                code: "DAEMON_DISPOSE_FAILED",
                run: () => {
                  visited.push("daemon");
                  throw new Error("private dispose");
                },
              },
              {
                code: "SESSION_CLOSE_FAILED",
                run: async () => {
                  visited.push("close");
                  throw new Error("private close");
                },
              },
              {
                code: "RESTORE_FAILED",
                run: () => {
                  visited.push("restore");
                },
              },
            ],
          });
        }
      })(),
    ).rejects.toBe(original);
    expect(visited).toEqual(["daemon", "close", "restore", "save"]);
    expect(cleanupErrors).toEqual([
      "DAEMON_DISPOSE_FAILED",
      "SESSION_CLOSE_FAILED",
    ]);
    expect(JSON.stringify(cleanupErrors)).not.toContain("private");
  });
  it("marks cleanup failure as failed when there was no earlier failure, after saving evidence", async () => {
    const cleanupErrors: string[] = [];
    const save = vi.fn(async () => {});
    await expect(
      finalizeReasoningEvidence({
        primaryFailed: false,
        cleanupErrors,
        save,
        cleanup: [
          {
            code: "CLOSE_FAILED",
            run: () => {
              throw new Error("private");
            },
          },
        ],
      }),
    ).rejects.toThrow("STAGE_C_CLEANUP_FAILED");
    expect(save).toHaveBeenCalledOnce();
    expect(cleanupErrors).toEqual(["CLOSE_FAILED"]);
  });
  it("preserves the primary failure if the evidence destination also fails", async () => {
    const cleanupErrors: string[] = [];
    const original = new Error("original assertion");
    await expect(
      (async () => {
        try {
          throw original;
        } finally {
          await finalizeReasoningEvidence({
            primaryFailed: true,
            cleanupErrors,
            cleanup: [],
            save: async () => {
              throw new Error("private filesystem failure");
            },
          });
        }
      })(),
    ).rejects.toBe(original);
    expect(cleanupErrors).toEqual(["EVIDENCE_WRITE_FAILED"]);
  });
});

describe("formal session restoration boundaries (no network)", () => {
  it.each(["directory", "config-write", "backend-construction"] as const)(
    "restores fetch, homedir and env after %s setup failure",
    async (fault) => {
      const homedir = os.homedir,
        fetch = globalThis.fetch;
      const original = new Error("private setup failure");
      vi.stubEnv("OHBABY_HOME", "original-test-home");
      vi.stubEnv("ZENMUX_API_KEY", undefined);
      vi.spyOn(loaders, "loadEnvFile").mockResolvedValue({
        ZENMUX_API_KEY: "fixture-only-key",
      });
      if (fault === "directory")
        vi.spyOn(fs, "mkdir").mockRejectedValueOnce(original);
      if (fault === "config-write") {
        const realWrite = fs.writeFile;
        vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          if (String(args[0]).endsWith("model.json")) throw original;
          await realWrite(...args);
        });
      }
      if (fault === "backend-construction")
        vi.spyOn(
          persistent,
          "createPersistentUiBackendClient",
        ).mockImplementationOnce(() => {
          throw original;
        });
      let root: string | undefined;
      try {
        await expect(
          createFormalCacheSession("zenmux-gpt56-luna-chat", {
            emptyConfig: fault !== "config-write",
          }),
        ).rejects.toBe(original);
        const failure = getFormalSetupFailureEvidence(original);
        root = failure?.diagnosticWorkspace;
        expect(failure).toBeDefined();
        expect(failure?.wire).toEqual([]);
        expect(JSON.stringify(failure)).not.toContain("private");
        expect(os.homedir).toBe(homedir);
        expect(globalThis.fetch).toBe(fetch);
        expect(process.env.OHBABY_HOME).toBe("original-test-home");
        expect(process.env.ZENMUX_API_KEY).toBeUndefined();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        os.homedir = homedir;
        globalThis.fetch = fetch;
        if (root) await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("restores all globals even when backend disposal and database close both reject", async () => {
    const homedir = os.homedir,
      fetch = globalThis.fetch;
    vi.stubEnv("OHBABY_HOME", "original-test-home");
    vi.stubEnv("ZENMUX_API_KEY", "fixture-only-key");
    const dispose = vi.fn(async () => {
      throw new Error("private dispose");
    });
    vi.spyOn(persistent, "createPersistentUiBackendClient").mockReturnValue({
      subscribeEvents: () => () => {},
      dispose,
    } as unknown as ReturnType<
      typeof persistent.createPersistentUiBackendClient
    >);
    vi.spyOn(persistent, "closePersistentUiBackendDatabase").mockImplementation(
      () => {
        throw new Error("private close");
      },
    );
    let session:
      | Awaited<ReturnType<typeof createFormalCacheSession>>
      | undefined;
    try {
      session = await createFormalCacheSession("zenmux-gpt56-luna-chat", {
        emptyConfig: true,
      });
      expect(os.homedir).not.toBe(homedir);
      expect(globalThis.fetch).not.toBe(fetch);
      await expect(session.close()).rejects.toThrow(
        "FORMAL_SESSION_CLEANUP_FAILED",
      );
      expect(session.cleanupErrors).toEqual([
        "BACKEND_DISPOSE_FAILED",
        "DATABASE_CLOSE_FAILED",
      ]);
      expect(os.homedir).toBe(homedir);
      expect(globalThis.fetch).toBe(fetch);
      expect(process.env.OHBABY_HOME).toBe("original-test-home");
      expect(process.env.ZENMUX_API_KEY).toBe("fixture-only-key");
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      os.homedir = homedir;
      globalThis.fetch = fetch;
      if (session) await rm(session.root, { recursive: true, force: true });
    }
  });
});

describe.runIf(enabled)("Stage C: public per-session reasoning", () => {
  it("starts empty, discovers, freezes accepted choices, and restores independent sessions", async () => {
    const profile = NATIVE_REAL_PROFILES.find(
      (item) =>
        item.id === process.env.OHBABY_REAL_REASONING_PROFILE &&
        supported.includes(item.id),
    );
    if (!profile) throw new Error("Select a supported Stage C profile");
    const evidencePath = join(
      ".ohbaby/test-evidence/improve-8/stage-c",
      `${profile.protocol}.json`,
    );
    await mkdir(join(dirname(evidencePath), "previous-runs"), {
      recursive: true,
    });
    try {
      await copyFile(
        evidencePath,
        join(
          dirname(evidencePath),
          "previous-runs",
          `${profile.protocol}-${Date.now()}.json`,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let session!: Awaited<ReturnType<typeof createFormalCacheSession>>;
    const authToken = randomUUID(),
      clientId = randomUUID();
    let handle!: ReturnType<typeof createDaemonServerApp>;
    let phase = "setup",
      passed = false;
    let primaryError: unknown;
    let primaryFailed = false;
    const cleanupErrors: string[] = [];
    let nativeReplay: ReturnType<typeof auditFormalNativeReplay> | undefined;
    let restoredWireNativeCounts: number[] | undefined;
    let toolExchange: ReturnType<typeof auditFormalToolExchange> | undefined;
    let nativeBefore: { active: string[]; retired: string[] } | undefined;
    let nativeAfter: { active: string[]; retired: string[] } | undefined;
    const rest: { method: string; path: string; status: number }[] = [];
    const turns: {
      session: string;
      status: string;
      effort: string;
      providerStart: number;
      providerEnd: number;
    }[] = [];
    const permissions: Promise<void>[] = [];
    const permissionFailures: string[] = [];
    let unsubscribe = (): void => {};
    let discovered: unknown;
    let preferenceRestore: unknown;
    async function request<T>(
      path: string,
      method = "GET",
      body?: unknown,
    ): Promise<T> {
      const response = await handle.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${authToken}`,
          "x-ohbaby-client-id": clientId,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180_000),
      });
      rest.push({
        method,
        path: path.replace(/\/(sessions|prompts)\/[^/]+/u, "/$1/:id"),
        status: response.status,
      });
      if (!response.ok) throw new Error(`STAGE_C_REST_${response.status}`);
      return (await response.json()) as T;
    }
    async function start(resumeSessionId?: string): Promise<void> {
      await handle.start();
      await request("/v1/clients", "POST", {
        clientId,
        ...(resumeSessionId ? { startupIntent: { resumeSessionId } } : {}),
      });
      unsubscribe = session.backend.subscribeEvents((event) => {
        if (event.type !== "permission.requested") return;
        permissions.push(
          (async () => {
            const selection = decideControlledPermission(
              event.request,
              await session.backend.getSnapshot(),
              dirname(session.readFilePath),
              session.readFilePath,
            );
            await session.backend.respondPermission(event.request.id, {
              choiceId: selection.choiceId,
              remember: false,
            });
          })().catch(async () => {
            permissionFailures.push("CONTROLLED_PERMISSION_FAILED");
            await session.backend.abortRun(event.request.runId);
          }),
        );
      });
    }
    async function snapshot(): Promise<UiSnapshot> {
      return (await request<{ snapshot: UiSnapshot }>("/v1/snapshot")).snapshot;
    }
    async function newSession(): Promise<string> {
      await request("/v1/sessions", "POST", {});
      const id = (await snapshot()).activeSessionId;
      if (!id) throw new Error("Missing created session");
      return id;
    }
    async function setEffort(id: string, effort: string): Promise<void> {
      await request(`/v1/sessions/${id}/reasoning`, "PATCH", {
        reasoning: { enabled: true, effort },
      });
    }
    async function turn(
      id: string,
      label: string,
      text: string,
      effort: string,
      afterAccepted?: () => Promise<void>,
    ): Promise<{
      providers: typeof session.providerRequests;
      wire: FormalCacheGenerationEvidence[];
    }> {
      const providerStart = session.providerRequests.length;
      const receipt = await request<UiPromptReceipt>("/v1/prompts", "POST", {
        text,
        sessionId: id,
        clientRequestId: randomUUID(),
      });
      await afterAccepted?.();
      const { completion } = await request<{ completion: UiPromptCompletion }>(
        `/v1/prompts/${receipt.promptId}/completion`,
      );
      await Promise.all(permissions);
      const providerEnd = session.providerRequests.length;
      turns.push({
        session: label,
        status: completion.prompt.status,
        effort,
        providerStart,
        providerEnd,
      });
      expect(completion.prompt.status).toBe("succeeded");
      const providers = session.providerRequests
        .slice(providerStart, providerEnd)
        .filter((row) => row.sessionId === id && row.purpose === "agent-step");
      expect(providers.length).toBeGreaterThan(0);
      const turnWire: FormalCacheGenerationEvidence[] = [];
      for (const row of providers) {
        const wire = session.wire.filter(
          (item) => item.kind === "generation" && item.context?.id === row.id,
        );
        expect(wire.length).toBeGreaterThan(0);
        for (const item of wire) {
          expect(item).toMatchObject({
            kind: "generation",
            protocol: profile!.protocol,
            model: profile!.model,
            status: 200,
            reasoning: { effort },
          });
          if (profile!.protocol === "openai-responses")
            expect(item).toMatchObject({ encryptedReasoningRequested: true });
          if (item.kind === "generation") {
            turnWire.push(item);
            expect(item.captureError).toBeUndefined();
            expect(hasValidFormalToolPairing(item.toolPairing)).toBe(true);
          }
        }
      }
      return { providers, wire: turnWire };
    }
    try {
      session = await createFormalCacheSession(profile.id, {
        maxRequests: 20,
        emptyConfig: true,
      });
      handle = createDaemonServerApp({
        backend: session.backend,
        authToken,
        commandRecorder: false,
      });
      phase = "empty-start";
      await start();
      expect((await request<{ model: unknown }>("/v1/model")).model).toBeNull();
      await expect(
        readFile(join(session.root, "config/model.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      phase = "public-save-discovery";
      const saved = await request<{ model: { saved: boolean } }>(
        "/v1/model",
        "POST",
        {
          provider: "zenmux",
          model: profile.model,
          baseUrl: profile.baseUrl,
          interfaceProvider: profile.protocol,
          apiKeyEnv: "ZENMUX_API_KEY",
          maxOutputTokens: 4096,
        },
      );
      expect(saved.model.saved).toBe(true);
      type CapabilityModel = {
        reasoning?: {
          status: string;
          supportsDisabled?: boolean;
          efforts: readonly string[];
          default?: { enabled?: boolean; effort?: string };
        };
      };
      let current = (await request<{ model: CapabilityModel }>("/v1/model"))
        .model;
      const deadline = Date.now() + 20_000;
      while (
        current.reasoning?.status === "detecting" &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        current = (await request<{ model: CapabilityModel }>("/v1/model"))
          .model;
      }
      discovered = current.reasoning;
      while (
        !session.wire.some((item) => item.kind === "metadata") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(session.wire.some((item) => item.kind === "metadata")).toBe(true);
      expect(current.reasoning).toMatchObject({
        status: "identified",
        supportsDisabled: false,
        default: { enabled: true, effort: "medium" },
      });
      expect(current.reasoning?.efforts).toEqual(
        expect.arrayContaining(["medium", "high"]),
      );
      const a = await newSession();
      await setEffort(a, "medium");
      phase = "active-choice-freeze";
      const firstTurn = await turn(
        a,
        "A",
        `Use the read tool exactly once on ${session.readFilePath}, with only file_path. Report Project, Release and Owner exactly. Do not use shell commands or change files.`,
        "medium",
        () => setEffort(a, "high"),
      );
      // A following agent request must serialize the real read call and result.
      toolExchange = auditFormalToolExchange(
        firstTurn.wire.filter(
          (item) => item.context?.id !== firstTurn.providers[0]?.id,
        ),
      );
      expect(toolExchange).toMatchObject({ exercised: true, valid: true });
      const first = await session.checkpoint("A-first-tool");
      expect(first.answer).toMatchObject({
        project: true,
        release: true,
        owner: true,
      });
      expect(first.toolCalls).toContainEqual({
        name: "read",
        status: "completed",
      });
      expect(first.persisted.completedTools.length).toBeGreaterThan(0);
      expect(first.persisted.completedTools.every((item) => item.allowed)).toBe(
        true,
      );
      expect(first.privateStateVisible).toBe(false);
      nativeBefore = session.nativeStateHashes("before-reopen");
      phase = "independent-session";
      const b = await newSession();
      expect(b).not.toBe(a);
      await setEffort(b, "medium");
      await turn(
        b,
        "B",
        "Reply only SESSION_B_OK. Do not call tools.",
        "medium",
      );
      await request(`/v1/sessions/${a}/select`, "PATCH", {});
      phase = "sqlite-reopen";
      unsubscribe();
      await handle.dispose();
      await session.reopen();
      nativeAfter = session.nativeStateHashes("after-reopen");
      expect(nativeAfter.active).toEqual(nativeBefore.active);
      handle = createDaemonServerApp({
        backend: session.backend,
        authToken,
        commandRecorder: false,
      });
      await start(a);
      const restored = await snapshot();
      const sessionA = restored.sessions.find(
        (item) => item.id === a,
      ) as unknown as { reasoning?: unknown };
      const sessionB = restored.sessions.find(
        (item) => item.id === b,
      ) as unknown as { reasoning?: unknown };
      expect(sessionA.reasoning).toEqual({ enabled: true, effort: "high" });
      expect(sessionB.reasoning).toEqual({ enabled: true, effort: "medium" });
      preferenceRestore = { A: sessionA.reasoning, B: sessionB.reasoning };
      phase = "restored-choice";
      const restoredTurn = await turn(
        a,
        "A-restored",
        "Use only the earlier conversation to report Project, Release and Owner again. No tools.",
        "high",
      );
      nativeReplay = auditFormalNativeReplay(
        nativeBefore.active,
        restoredTurn.providers[0]?.replayStateHashes,
      );
      restoredWireNativeCounts = restoredTurn.wire
        .filter((item) => item.context?.id === restoredTurn.providers[0]?.id)
        .map((item) => item.nativeInputCount ?? 0);
      expect(nativeReplay.valid).toBe(true);
      const last = await session.checkpoint("A-restored");
      expect(last.answer).toMatchObject({
        project: true,
        release: true,
        owner: true,
      });
      expect(last.privateStateVisible).toBe(false);
      expect(permissionFailures).toEqual([]);
      passed = true;
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
      throw error;
    } finally {
      await finalizeReasoningEvidence({
        primaryFailed,
        cleanupErrors,
        cleanup: [
          { code: "PERMISSION_UNSUBSCRIBE_FAILED", run: () => unsubscribe() },
          { code: "DAEMON_DISPOSE_FAILED", run: () => handle?.dispose() },
          { code: "SESSION_CLOSE_FAILED", run: () => session?.close() },
        ],
        save: async () => {
          await writeFile(
            evidencePath,
            JSON.stringify(
              {
                stage: "C",
                profile: profile.id,
                emptyConfig: true,
                seededVerifiedCapabilities: false,
                phase,
                result:
                  passed && cleanupErrors.length === 0 ? "passed" : "failed",
                ...(primaryFailed
                  ? {
                      failure: {
                        phase,
                        code:
                          primaryError instanceof Error &&
                          primaryError.name === "AssertionError"
                            ? "ASSERTION_FAILED"
                            : "STAGE_C_FAILED",
                      },
                    }
                  : {}),
                cleanupErrors: [
                  ...cleanupErrors,
                  ...(session?.cleanupErrors ??
                    getFormalSetupFailureEvidence(primaryError)
                      ?.cleanupErrors ??
                    []),
                ],
                diagnosticWorkspace:
                  session?.root ??
                  getFormalSetupFailureEvidence(primaryError)
                    ?.diagnosticWorkspace,
                discovered,
                preferenceRestore,
                turns,
                rest,
                permissionFailures,
                nativeBefore,
                nativeAfter,
                nativeReplay,
                restoredWireNativeCounts,
                toolExchange,
                providerRequests: session?.providerRequests ?? [],
                wire:
                  session?.wire ??
                  getFormalSetupFailureEvidence(primaryError)?.wire ??
                  [],
              },
              null,
              2,
            ) + "\n",
          );
        },
      });
    }
  });
});
