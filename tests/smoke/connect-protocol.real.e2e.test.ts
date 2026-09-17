import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  UiConnectModelResult,
  UiPromptCompletion,
  UiPromptReceipt,
  UiSnapshot,
} from "ohbaby-sdk";
import { createDaemonServerApp } from "../../packages/ohbaby-server/src/app/create-app.js";
import { createFormalCacheSession } from "./formal-cache-session.js";
import { decideControlledPermission } from "./formal-cache-live-context.js";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";

const profiles = [
  "zenmux-gpt56-luna-chat",
  "zenmux-gpt56-luna-responses",
  "zenmux-claude-sonnet5-anthropic",
];
const enabled = process.env.OHBABY_RUN_REAL_CONNECT_PROTOCOL === "1";

describe.runIf(enabled)("Stage A: real public connect protocol", () => {
  it("saves through REST, reads a controlled file and continues after SQLite reopen", async () => {
    const profile = NATIVE_REAL_PROFILES.find(
      (item) =>
        item.id === process.env.OHBABY_REAL_CONNECT_PROFILE &&
        profiles.includes(item.id),
    );
    if (!profile) throw new Error("Select one supported Stage A profile");
    const evidencePath = join(
      ".ohbaby/test-evidence/improve-8/stage-a",
      `${profile.protocol}.json`,
    );
    await mkdir(dirname(evidencePath), { recursive: true });
    // Preserve the previous safe artifact when repeating a paid attempt.
    const archiveDir = join(dirname(evidencePath), "previous-runs");
    await mkdir(archiveDir, { recursive: true });
    try {
      await copyFile(
        evidencePath,
        join(archiveDir, `${profile.protocol}-${Date.now()}.json`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const session = await createFormalCacheSession(profile.id, {
      maxRequests: 20,
    });
    const authToken = randomUUID();
    const clientId = randomUUID();
    let handle = createDaemonServerApp({
      backend: session.backend,
      authToken,
      commandRecorder: false,
    });
    let phase = "connect";
    let failure: { code: string; phase: string } | undefined;
    const rest: { method: string; path: string; status: number }[] = [];
    const completions: { status: string; errorCode?: string }[] = [];
    const permissions: { allowed: boolean; toolName: string }[] = [];
    const permissionErrors: string[] = [];
    const visibleContextWindows: {
      phase: string;
      tokens: number;
      currentTokens: number;
    }[] = [];
    const pending = new Set<Promise<void>>();
    let offPermission = (): void => {};
    let saved:
      | {
          saved: boolean;
          protocol: string;
          persistedProtocol: string;
          contextWindowTokens: number;
          contextWindowSource: string;
        }
      | undefined;
    let sessionId: string | undefined;

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
        path: path.replace(/\/v1\/prompts\/[^/]+\//u, "/v1/prompts/:id/"),
        status: response.status,
      });
      if (!response.ok) throw new Error(`REST_STATUS_${response.status}`);
      return (await response.json()) as T;
    }

    async function start(): Promise<void> {
      await handle.start();
      await request("/v1/clients", "POST", {
        clientId,
        ...(sessionId ? { startupIntent: { resumeSessionId: sessionId } } : {}),
      });
      offPermission = session.backend.subscribeEvents((event) => {
        if (event.type !== "permission.requested") return;
        const task = (async () => {
          const selection = decideControlledPermission(
            event.request,
            await session.backend.getSnapshot(),
            dirname(session.readFilePath),
            session.readFilePath,
          );
          permissions.push({
            allowed: selection.decision.allowed,
            toolName: selection.decision.toolName,
          });
          await session.backend.respondPermission(event.request.id, {
            choiceId: selection.choiceId,
            remember: false,
          });
        })().catch(async () => {
          permissionErrors.push("PERMISSION_HANDLER_FAILED");
          await session.backend.abortRun(event.request.runId);
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
    }

    async function submit(
      text: string,
    ): Promise<Awaited<ReturnType<typeof session.checkpoint>>> {
      const receipt = await request<UiPromptReceipt>("/v1/prompts", "POST", {
        text,
        clientRequestId: randomUUID(),
        ...(sessionId ? { sessionId } : {}),
      });
      sessionId = receipt.sessionId;
      const { completion } = await request<{ completion: UiPromptCompletion }>(
        `/v1/prompts/${receipt.promptId}/completion`,
      );
      await Promise.all([...pending]);
      completions.push({
        status: completion.prompt.status,
        ...(completion.prompt.error
          ? { errorCode: completion.prompt.error.code }
          : {}),
      });
      expect(completion.prompt.status).toBe("succeeded");
      // The visible answer must survive the public web snapshot projection too.
      const { snapshot } = await request<{ snapshot: UiSnapshot }>(
        "/v1/snapshot",
      );
      const contextWindow = snapshot.contextWindowUsages?.find(
        (item) => item.sessionId === sessionId,
      );
      expect(contextWindow?.contextWindowTokens).toBe(
        saved?.contextWindowTokens,
      );
      expect(contextWindow?.currentTokens).toBeGreaterThan(0);
      if (contextWindow)
        visibleContextWindows.push({
          phase,
          tokens: contextWindow.contextWindowTokens,
          currentTokens: contextWindow.currentTokens,
        });
      const visible = snapshot.sessions
        .find((item) => item.id === sessionId)
        ?.messages.findLast((item) => item.role === "assistant")?.parts;
      expect(
        visible?.some(
          (part) => part.type === "text" && part.text.includes("Lin"),
        ),
      ).toBe(true);
      expect(
        visible?.some(
          (part) => (part as { type: string }).type === "model-state",
        ),
      ).toBe(false);
      return session.checkpoint(phase);
    }

    try {
      await start();
      const { model } = await request<{ model: UiConnectModelResult }>(
        "/v1/model",
        "POST",
        {
          provider: "zenmux",
          model: profile.model,
          interfaceProvider: profile.protocol,
          baseUrl: profile.baseUrl,
          apiKeyEnv: "ZENMUX_API_KEY",
          contextWindowTokens: session.contextWindow.tokens,
          maxOutputTokens: 4096,
        },
      );
      const persisted = JSON.parse(
        await readFile(model.modelJsonPath, "utf8"),
      ) as { apiConfig: { interfaceProvider: string } };
      saved = {
        saved: model.saved,
        protocol: model.interfaceProvider,
        persistedProtocol: persisted.apiConfig.interfaceProvider,
        contextWindowTokens: model.contextWindowTokens,
        contextWindowSource: model.contextWindowSource,
      };
      expect(saved).toMatchObject({
        saved: true,
        protocol: profile.protocol,
        persistedProtocol: profile.protocol,
      });
      phase = "first-read";
      const first = await submit(
        `Use the read tool exactly once on ${session.readFilePath}, with only the file_path argument. Report Project, Release and Owner exactly. Do not use shell commands or change any files.`,
      );
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
      const toolIds = session.allToolPartIds();
      const native = session.activeNativeFingerprint("before-reopen");
      expect(native.count).toBeGreaterThan(0);
      const states = session.nativeStateHashes("before-reopen");
      phase = "reopen";
      offPermission();
      await handle.dispose();
      await session.reopen();
      expect(session.activeNativeFingerprint("after-reopen")).toEqual(native);
      handle = createDaemonServerApp({
        backend: session.backend,
        authToken,
        commandRecorder: false,
      });
      await start();
      phase = "post-reopen";
      const continued = await submit(
        "Using the earlier conversation only, report the Project, Release and Owner fields again. Do not use any tools.",
      );
      expect(continued.answer).toMatchObject({
        project: true,
        release: true,
        owner: true,
      });
      expect(continued.cache.sessionId).toBe(sessionId);
      expect(session.allToolPartIds()).toEqual(toolIds);
      expect(
        session.providerRequests
          .filter((item) => item.purpose === "agent-step")
          .at(-1)?.replayStateHashes,
      ).toEqual(states.active);
      phase = "wire-selection";
      const requests = session.wire.filter(
        (item) => item.kind === "generation",
      );
      expect(requests.length).toBeGreaterThanOrEqual(3);
      const expectedPath = {
        "openai-compatible": "/api/v1/chat/completions",
        "openai-responses": "/api/v1/responses",
        anthropic: "/api/anthropic/v1/messages",
      }[profile.protocol];
      expect(
        requests.every(
          (item) =>
            item.protocol === profile.protocol && item.path === expectedPath,
        ),
      ).toBe(true);
      // Session-title generation is best effort in production. Preserve its
      // transport failure evidence without treating it as a failed user turn.
      const agentRequests = requests.filter(
        (item) => item.context?.purpose === "agent-step",
      );
      expect(agentRequests.length).toBeGreaterThanOrEqual(3);
      expect(agentRequests.every((item) => item.status === 200)).toBe(true);
      expect(session.wire.length).toBeLessThanOrEqual(20);
      expect(session.providerRequests.every((item) => item.settled)).toBe(true);
      expect(permissionErrors).toEqual([]);
    } catch (error) {
      failure = {
        phase,
        code:
          error instanceof Error && error.name === "AssertionError"
            ? "ASSERTION_FAILED"
            : "LIVE_RUN_FAILED",
      };
      throw new Error(`${failure.code} at ${phase}`);
    } finally {
      try {
        await session.save(evidencePath);
        const evidence = JSON.parse(
          await readFile(evidencePath, "utf8"),
        ) as Record<string, unknown>;
        await writeFile(
          evidencePath,
          JSON.stringify(
            {
              ...evidence,
              stage: "A",
              entry: "createDaemonServerApp REST -> persistent backend",
              maxHttpRequests: 20,
              seededVerifiedCapabilities: true,
              seededContextWindow: session.contextWindow,
              contextWindowTokens: saved?.contextWindowTokens,
              contextWindowSource: saved?.contextWindowSource,
              saved,
              visibleContextWindows,
              rest,
              completions,
              permissions,
              permissionErrors,
              result: failure ? "failed" : "passed",
              ...(failure
                ? { failure, diagnosticWorkspace: session.root }
                : {}),
            },
            null,
            2,
          ) + "\n",
        );
        process.stdout.write(
          JSON.stringify({
            protocol: profile.protocol,
            evidencePath,
            result: failure ? "failed" : "passed",
            httpRequests: session.wire.length,
          }) + "\n",
        );
      } finally {
        offPermission();
        await handle.dispose();
        await session.close();
        if (!failure) await rm(session.root, { recursive: true, force: true });
      }
    }
  }, 600_000);
});
