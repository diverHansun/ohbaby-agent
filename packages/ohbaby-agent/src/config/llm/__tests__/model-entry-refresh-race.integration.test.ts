import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startModelEntryDiscovery } from "../apply-active-model-config.js";
import { coordinateModelConfig } from "../config-coordination.js";
import * as writer from "../writer.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["context", "reasoning"] as const)(
  "rejects a superseded %s write queued behind its replacement refresh",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "model-entry-refresh-race-"));
    const options = {
      modelJsonPath: join(root, "model.json"),
      envPath: join(root, ".env"),
    };
    const original = JSON.stringify({
      schemaVersion: 2,
      activeProfileId: "one",
      models: [
        {
          id: "one",
          provider: "custom",
          model: "unknown",
          baseUrl: "https://refresh.invalid/v1",
          interfaceProvider:
            stage === "reasoning" ? "anthropic" : "openai-compatible",
          reasoning: { effort: stage === "reasoning" ? "minimal" : "high" },
        },
      ],
    });
    const oldRequested = deferred<undefined>();
    const replacementRequested = deferred<undefined>();
    const oldResponse = deferred<Response>();
    const replacementResponse = deferred<Response>();
    const lockHeld = deferred<undefined>();
    const releaseLock = deferred<undefined>();
    const writeQueued = deferred<undefined>();
    const writeMetadata = writer.writeModelEntryMetadata;
    // Observe the real write entering the queue; do not replace its disk effects.
    vi.spyOn(writer, "writeModelEntryMetadata").mockImplementation(
      (...args) => {
        const result = writeMetadata(...args);
        writeQueued.resolve(undefined);
        return result;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => {
          oldRequested.resolve(undefined);
          return oldResponse.promise;
        })
        .mockImplementationOnce(() => {
          replacementRequested.resolve(undefined);
          return replacementResponse.promise;
        }),
    );
    let oldTask: ReturnType<typeof startModelEntryDiscovery> | undefined;
    let replacementTask:
      | ReturnType<typeof startModelEntryDiscovery>
      | undefined;
    let blocker: Promise<void> | undefined;
    try {
      await writeFile(options.modelJsonPath, original);
      oldTask = startModelEntryDiscovery("one", options);
      await oldRequested.promise;
      blocker = coordinateModelConfig(options.modelJsonPath, async () => {
        lockHeld.resolve(undefined);
        await releaseLock.promise;
      });
      await lockHeld.promise;
      replacementTask = startModelEntryDiscovery("one", {
        ...options,
        forceActiveProbe: true,
      });
      oldResponse.resolve(
        Response.json({
          data: [
            {
              id: "unknown",
              ...(stage === "context"
                ? { context_length: 111111, reasoning: false }
                : {
                    reasoning_capabilities: {
                      mode: "effort",
                      wire: "anthropic-adaptive",
                      supportsDisabled: true,
                      efforts: ["minimal", "high"],
                    },
                  }),
            },
          ],
        }),
      );
      await writeQueued.promise;
      releaseLock.resolve(undefined);
      await blocker;
      await replacementRequested.promise;
      await expect(oldTask).resolves.toMatchObject({
        reasoningReason: "cancelled",
      });
      replacementResponse.resolve(new Response("", { status: 401 }));
      await replacementTask;

      expect(await readFile(options.modelJsonPath, "utf8")).toBe(original);
      const entry = (await writer.readModelSettings(options)).models[0];
      expect(entry.detectedContextWindowTokens).toBeUndefined();
      expect(entry.reasoningDefault?.effort).toBe(
        stage === "reasoning" ? "minimal" : "high",
      );
      expect(entry.reasoningNotice).toBeUndefined();
      expect(entry.contextDiscovery).toMatchObject({
        status: "unknown",
        reason: "authentication",
      });
    } finally {
      releaseLock.resolve(undefined);
      oldResponse.resolve(new Response("", { status: 401 }));
      replacementResponse.resolve(new Response("", { status: 401 }));
      await blocker;
      await oldTask;
      await replacementTask;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  },
);
