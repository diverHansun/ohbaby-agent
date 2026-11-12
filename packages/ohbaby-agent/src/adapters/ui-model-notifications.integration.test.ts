import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

describe("model discovery recovery notifications", () => {
  it("publishes actual model configuration and metadata discovery invalidations without replacing chat", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ohbaby-notification-discovery-"),
    );
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const previousKey = process.env.NOTIFICATION_TEST_API_KEY;
    let release!: () => void;
    const discovery = new Promise<void>((resolve) => {
      release = resolve;
    });
    let metadataContext = 262144;
    const fetchMetadata = vi.fn(async () => {
      await discovery;
      return Response.json({
        data: [
          {
            id: "notification-model",
            context_length: metadataContext,
            reasoning: false,
          },
        ],
      });
    });
    process.env.HOME = directory;
    process.env.USERPROFILE = directory;
    vi.stubGlobal("fetch", fetchMetadata);
    const backend = createInProcessUiBackendClient({
      projectDirectory: directory,
    });
    const events: UiEvent[] = [];
    backend.subscribeEvents((event) => {
      events.push(event);
    });
    try {
      await backend.connectModel({
        provider: "notification-provider",
        model: "notification-model",
        apiKey: "fixture-only",
        apiKeyEnv: "NOTIFICATION_TEST_API_KEY",
        baseUrl: "https://notification.example/v1",
        interfaceProvider: "openai-compatible",
        contextWindowTokens: 128000,
      });
      expect(
        events.filter((event) => event.type === "model.invalidated"),
      ).toHaveLength(2);
      release();
      await vi.waitFor(async () => {
        const current = await backend.getCurrentModel();
        expect(current?.contextDiscovery.status).toBe("identified");
        expect(current?.reasoning?.status).toBe("identified");
      });
      expect(
        events.filter((event) => event.type === "model.invalidated").length,
      ).toBeGreaterThanOrEqual(4);
      expect(await backend.getCurrentModel()).toMatchObject({
        model: "notification-model",
        contextWindowTokens: 128000,
        detectedContextWindowTokens: 262144,
        effectiveContextWindowTokens: 128000,
      });
      expect(events.some((event) => event.type === "snapshot.replaced")).toBe(
        false,
      );
      expect(events.some((event) => event.type === "session.changed")).toBe(
        false,
      );
      events.length = 0;
      metadataContext = 524288;
      const discovered = await backend.probeModelContextWindow({
        provider: "notification-provider",
        model: "notification-model",
        apiKey: "fixture-only",
        apiKeyEnv: "NOTIFICATION_TEST_API_KEY",
        baseUrl: "https://notification.example/v1",
        interfaceProvider: "openai-compatible",
      });
      expect(discovered.contextWindowTokens).toBe(524288);
      expect(events.some((event) => event.type === "model.invalidated")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "snapshot.replaced")).toBe(
        false,
      );
      expect(events.some((event) => event.type === "session.changed")).toBe(
        false,
      );
      expect(fetchMetadata).toHaveBeenCalledTimes(2);
      let releaseSelection!: () => void;
      const selectedMetadata = new Promise<void>((resolve) => {
        releaseSelection = resolve;
      });
      fetchMetadata.mockImplementationOnce(async () => {
        await selectedMetadata;
        return Response.json({
          data: [
            {
              id: "notification-model",
              context_length: 1048576,
              reasoning: false,
            },
          ],
        });
      });
      const currentId = (await backend.getCurrentModel())?.id;
      if (!currentId) throw new Error("Expected current model entry");
      events.length = 0;
      try {
        await backend.selectDefaultModel(currentId);
        expect((await backend.getCurrentModel())?.contextDiscovery.status).toBe(
          "detecting",
        );
        const initialEvents = events.filter(
          (event) => event.type === "model.invalidated",
        ).length;
        releaseSelection();
        await vi.waitFor(async () => {
          expect(
            (await backend.getCurrentModel())?.contextDiscovery.status,
          ).toBe("identified");
          expect(
            events.filter((event) => event.type === "model.invalidated").length,
          ).toBeGreaterThan(initialEvents);
        });
        expect(await backend.getCurrentModel()).toMatchObject({
          detectedContextWindowTokens: 1048576,
        });
      } finally {
        releaseSelection();
      }
    } finally {
      release();
      await vi.waitFor(async () => {
        const current = await backend.getCurrentModel();
        expect(current?.contextDiscovery.status).not.toBe("detecting");
        expect(current?.reasoning?.status).not.toBe("detecting");
      });
      await backend.dispose();
      vi.unstubAllGlobals();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousKey === undefined)
        delete process.env.NOTIFICATION_TEST_API_KEY;
      else process.env.NOTIFICATION_TEST_API_KEY = previousKey;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
