/** Interactive injected backend + current compiled Web; not the default CLI. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as stores from "../../packages/ohbaby-agent/src/core/message/database-store.js";
import * as schedulers from "../../packages/ohbaby-agent/src/core/tool-scheduler/scheduler.js";
import { withToolAdmission } from "../../packages/ohbaby-agent/src/core/tool-scheduler/tool-admission.js";
import { createPersistentUiBackendClient } from "../../packages/ohbaby-agent/src/adapters/ui-persistent.js";
import {
  closeDatabase,
  getDatabase,
} from "../../packages/ohbaby-agent/src/services/database/index.js";
import { createDaemonHttpServer } from "../../packages/ohbaby-server/src/runtime/daemon/server.js";
import type { LLMClientInstance } from "../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type { ToolPart } from "../../packages/ohbaby-agent/src/core/message/types.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { release, promise };
}
it
  .runIf(process.env.OHBABY_EXECUTION_UI_HARNESS === "1")
  .each(
    process.env.OHBABY_EXECUTION_UI_AUTORUN === "1"
      ? ["fault", "rpc-first", "terminal-first"]
      : ["interactive"],
  )(
  "serves compiled Web with independent durable-terminal, RPC and physical-operation gates: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-injected-ui-"));
    await mkdir(join(root, "workspace"));
    const workdir = await realpath(join(root, "workspace"));
    vi.stubEnv("OHBABY_HOME", join(root, "home"));
    vi.stubEnv("OHBABY_STORAGE_ROOT", join(root, "storage"));
    const operation = gate();
    const terminal = gate();
    const rpc = gate();
    const evidence: Record<string, unknown>[] = [];
    let failSave = false;
    let terminalEntered = false;
    let aborted = false;
    let abortCalls = 0;
    let providerCalls = 0;
    let invoked = 0;
    let commits = 0;
    const stamp = (type: string, fields: Record<string, unknown> = {}) => {
      const row = { type, at: performance.now(), ...fields };
      evidence.push(row);
      console.log("T5_INJECTED " + JSON.stringify(row));
    };
    const createStore = stores.createDatabaseMessageStore;
    vi.spyOn(stores, "createDatabaseMessageStore").mockImplementation(
      (options) => {
        const store = createStore(options);
        const update = store.updatePart.bind(store);
        store.updatePart = async (id, patch, time) => {
          const current = await store.getPart(id);
          if (
            current?.type === "tool" &&
            current.callId === "a" &&
            patch.metadata?.execution?.phase === "ended" &&
            !terminalEntered
          ) {
            terminalEntered = true;
            stamp("terminal-save-entered");
            await terminal.promise;
            if (failSave) {
              stamp("save-failed");
              throw new Error("fixture terminal storage failure");
            }
          }
          const result = await update(id, patch, time);
          if (patch.metadata?.execution?.phase === "ended") {
            commits++;
            stamp("saved-terminal", {
              callId: current?.type === "tool" ? current.callId : null,
            });
          }
          return result;
        };
        return store;
      },
    );
    const createScheduler = schedulers.createToolScheduler;
    vi.spyOn(schedulers, "createToolScheduler").mockImplementation(
      (options) => {
        const scheduler = createScheduler(options);
        for (const id of ["a", "b"])
          scheduler.register(
            withToolAdmission(
              {
                name: `fixture_${id}`,
                category: "readonly",
                source: "builtin",
                description: "controlled owned integration tool",
                parametersJsonSchema: { type: "object" },
                execute: async (_params, context) => {
                  invoked++;
                  stamp("invoke", { id });
                  if (id === "a") {
                    context.signal.addEventListener(
                      "abort",
                      () => {
                        aborted = true;
                        stamp("abort-signal");
                      },
                      { once: true },
                    );
                    await operation.promise;
                    stamp("physical-operation-ended");
                  }
                  return { output: `DURABLE_${id.toUpperCase()}` };
                },
              },
              { plan: () => [] },
            ),
          );
        return scheduler;
      },
    );
    const llmClient: LLMClientInstance = {
      config: {
        interfaceProvider: "openai-compatible",
        provider: "fixture",
        model: "fixture",
        baseUrl: "https://invalid.test",
        temperature: 0,
        maxTokens: 100,
        modelProfiles: [
          {
            model: "fixture",
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          return Promise.resolve(
            (async function* () {
              if (request.purpose === "session-title") {
                yield {
                  textDelta: "Injected acceptance",
                  finishReason: "stop" as const,
                };
                return;
              }
              providerCalls++;
              stamp("provider", { providerCalls });
              if (providerCalls === 1)
                yield {
                  toolCallDeltas: ["a", "b"].map((id, index) => ({
                    id,
                    index,
                    name: `fixture_${id}`,
                    argumentsDelta: "{}",
                  })),
                  finishReason: "tool_calls" as const,
                };
              else
                yield {
                  textDelta: "INJECTED_FINAL",
                  finishReason: "stop" as const,
                };
            })(),
          );
        },
      },
    };
    const backend = createPersistentUiBackendClient({
      dbPath: join(root, "fixture.db"),
      workdir,
      llmClient,
    });
    const originalAbort = backend.abortRun.bind(backend);
    backend.abortRun = async (...args) => {
      abortCalls++;
      stamp("abort-handler", { abortCalls });
      await originalAbort(...args);
      stamp("abort-accepted");
      await rpc.promise;
      stamp("abort-response");
    };
    const token = randomUUID();
    const server = createDaemonHttpServer({
      backend,
      authToken: token,
      host: "127.0.0.1",
      port: 0,
      webAssetsDir: resolve("apps/ohbaby-web/dist"),
      scopeRoot: workdir,
      listKnownWorkspaceScopes: () => [workdir],
      createWorkspaceBackend: (directory) => {
        if (directory !== workdir)
          throw new Error("Fixture only serves its owned workspace");
        return backend;
      },
    });
    const parts = (): ToolPart[] =>
      getDatabase()
        .prepare<{ data: string }>(
          "SELECT data FROM part WHERE type='tool' ORDER BY rowid",
        )
        .all()
        .map((r) => JSON.parse(r.data) as ToolPart);
    let control: Server | undefined;
    const done = gate();
    let verified = false;
    const failures: string[] = [];
    try {
      await server.start();
      const bootstrap = await fetch(server.url + "/v1/scopes", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bootstrap.status).toBe(200);
      expect(await bootstrap.json()).toMatchObject({
        scopes: [{ directory: workdir }],
      });
      const bootstrapHeaders = {
        authorization: `Bearer ${token}`,
        "x-ohbaby-directory": workdir,
        "x-ohbaby-client-id": "bootstrap-probe",
        "content-type": "application/json",
      };
      const registration = await fetch(server.url + "/v1/clients", {
        method: "POST",
        headers: bootstrapHeaders,
        body: JSON.stringify({ clientId: "bootstrap-probe" }),
      });
      expect(registration.status).toBeLessThan(300);
      const scopedIndex = await fetch(server.url + "/v1/sessions/index", {
        headers: bootstrapHeaders,
      });
      expect(scopedIndex.status).toBe(200);
      control = createServer(async (request, response) => {
        if (
          request.method !== "POST" ||
          request.headers.authorization !== `Bearer ${token}`
        ) {
          response.writeHead(403);
          response.end();
          return;
        }
        try {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const { command } = JSON.parse(raw) as { command: string };
          if (command === "quit") {
            response.end(JSON.stringify({ ok: true }));
            done.release();
            return;
          }
          if (command === "check-b") {
            expect(parts().find((p) => p.callId === "b")?.state).toMatchObject({
              status: "completed",
              output: "DURABLE_B",
            });
            expect(providerCalls).toBe(1);
            expect(invoked).toBe(2);
          } else if (command === "release-operation") operation.release();
          else if (command === "release-terminal") terminal.release();
          else if (command === "fail-terminal") {
            failSave = true;
            terminal.release();
          } else if (command === "release-rpc") rpc.release();
          else if (
            command === "check-cancelled" ||
            command === "check-failed"
          ) {
            const rows = getDatabase()
              .prepare<{
                status: string;
                ended_at: number | null;
              }>("SELECT status,ended_at FROM prompt_submission")
              .all();
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe(
              command === "check-cancelled" ? "cancelled" : "failed",
            );
            expect(rows[0].ended_at).not.toBeNull();
            expect(providerCalls).toBe(1);
            expect(parts().find((p) => p.callId === "b")?.state).toMatchObject({
              status: "completed",
              output: "DURABLE_B",
            });
            if (command === "check-cancelled") {
              expect(aborted).toBe(true);
              expect(abortCalls).toBe(1);
            }
            verified = true;
            if (command === "check-failed")
              expect(
                parts().find((p) => p.callId === "a")?.state.status,
              ).not.toBe("completed");
          } else throw new Error("Unknown injected command");
          stamp("command-pass", {
            command,
            providerCalls,
            invoked,
            commits,
            aborted,
            terminalEntered,
          });
          response.end(JSON.stringify({ ok: true, command }));
        } catch (error) {
          failures.push(String(error));
          stamp("command-failed", { message: String(error) });
          response.writeHead(500);
          response.end(JSON.stringify({ ok: false, message: String(error) }));
        }
      });
      await new Promise<void>((resolve) =>
        control!.listen(0, "127.0.0.1", resolve),
      );
      const address = control.address();
      if (!address || typeof address === "string")
        throw new Error("No control address");
      const controlUrl = `http://127.0.0.1:${address.port}`;
      const privatePath = join(root, "connection.json");
      await writeFile(
        privatePath,
        JSON.stringify({
          url: server.url,
          controlUrl,
          authToken: token,
          workspace: workdir,
        }),
        { mode: 0o600 },
      );
      stamp("ready", {
        topology: "injected persistent backend + compiled Web",
        url: server.url,
        privatePath,
        controlUrl,
        root,
      });
      if (mode !== "interactive") {
        const headers = {
          authorization: `Bearer ${token}`,
          "x-ohbaby-client-id": "automatic-acceptance",
          "x-ohbaby-directory": workdir,
          "content-type": "application/json",
        };
        const request = async (
          path: string,
          body?: unknown,
        ): Promise<Record<string, unknown>> => {
          const result = await fetch(server.url + path, {
            method: body === undefined ? "GET" : "POST",
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10000),
          });
          expect(result.status).toBeLessThan(300);
          return (await result.json()) as Record<string, unknown>;
        };
        const command = async (name: string): Promise<void> => {
          const result = await fetch(controlUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ command: name }),
          });
          expect(result.status).toBe(200);
        };
        await request("/v1/clients", { clientId: "automatic-acceptance" });
        const receipt = await request("/v1/prompts", {
          text: "acceptance",
          clientRequestId: randomUUID(),
        });
        await vi.waitFor(() =>
          expect(parts().find((p) => p.callId === "b")?.state.status).toBe(
            "completed",
          ),
        );
        await command("check-b");
        if (mode === "fault") {
          await command("release-operation");
          await vi.waitFor(() => expect(terminalEntered).toBe(true));
          await command("fail-terminal");
          await request(`/v1/prompts/${String(receipt.promptId)}/completion`);
          await command("check-failed");
        } else {
          const runId = parts().find((p) => p.callId === "a")?.metadata
            ?.execution?.runId;
          let replied = false;
          const abortResponse = request(
            `/v1/sessions/${String(receipt.sessionId)}/abort`,
            {
              rootSessionId: receipt.sessionId,
              permissionEpoch: receipt.permissionEpoch,
              bindingGeneration: receipt.bindingGeneration,
              runtimeEpoch: receipt.runtimeEpoch,
              runId,
            },
          ).then(() => {
            replied = true;
          });
          // Attach a rejection observer immediately while separately driving gates.
          void abortResponse.catch(() => undefined);
          await vi.waitFor(() => {
            expect(aborted).toBe(true);
            expect(terminalEntered).toBe(true);
          });
          if (mode === "rpc-first") {
            await command("release-rpc");
            await abortResponse;
            expect(
              getDatabase()
                .prepare<{
                  ended_at: number | null;
                }>("SELECT ended_at FROM prompt_submission")
                .get()?.ended_at,
            ).toBeNull();
          }
          await command("release-terminal");
          await request(`/v1/prompts/${String(receipt.promptId)}/completion`);
          await command("check-cancelled");
          expect(
            evidence.some((e) => e.type === "physical-operation-ended"),
          ).toBe(false);
          if (mode === "terminal-first") {
            expect(replied).toBe(false);
            await command("release-rpc");
            await abortResponse;
          }
          await command("release-operation");
        }
        await command("quit");
      }
      await done.promise;
      expect(
        verified,
        "Run check-cancelled or check-failed before quitting",
      ).toBe(true);
      expect(failures).toEqual([]);
    } finally {
      operation.release();
      terminal.release();
      rpc.release();
      control?.closeAllConnections();
      if (control)
        await new Promise<void>((resolve) => control!.close(() => resolve()));
      await server.stop();
      await backend.dispose();
      closeDatabase();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await writeFile(
        join(root, "evidence.json"),
        JSON.stringify({ evidence, failures }, null, 2),
      );
      await rm(join(root, "connection.json"), { force: true });
      stamp("closed", { root, failures: failures.length });
    }
  },
  3600000,
);
