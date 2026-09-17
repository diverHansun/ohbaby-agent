import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { render } from "ink-testing-library";
import { OhbabyTerminalApp } from "ohbaby-cli";
import type { UiReasoningCapabilityView } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import { auditFormalToolExchange } from "./formal-cache-observer.js";
import { createFormalCacheSession } from "./formal-cache-session.js";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";
import { decideControlledPermission } from "./formal-cache-live-context.js";
import {
  flush,
  promptIsReady,
  waitForFrame,
} from "../integration/tui/helpers.js";

const enabled = process.env.OHBABY_RUN_REAL_CONNECT_TUI === "1";
const supported = [
  "zenmux-gpt56-luna-chat",
  "zenmux-gpt56-luna-responses",
  "zenmux-claude-sonnet5-anthropic",
];

describe.runIf(enabled)("Stage D: real TUI public connect", () => {
  it("configures by stdin from empty and performs a real tool exchange", async () => {
    const profile = NATIVE_REAL_PROFILES.find(
      (item) =>
        item.id === process.env.OHBABY_REAL_TUI_PROFILE &&
        supported.includes(item.id),
    );
    if (!profile) throw new Error("Select one supported TUI profile");
    const selectedEffort = process.env.OHBABY_REAL_TUI_EFFORT || "medium";
    const evidencePath = join(
      ".ohbaby/test-evidence/improve-8/stage-d/tui",
      `${profile.protocol}${selectedEffort === "medium" ? "" : `-effort-${selectedEffort}`}.json`,
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
          `${profile.protocol}-${String(Date.now())}.json`,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const session = await createFormalCacheSession(profile.id, {
      maxRequests: 20,
      emptyConfig: true,
    });
    const app = render(
      <OhbabyTerminalApp
        client={session.backend}
        subscribeEvents={(listener) =>
          session.backend.subscribeEvents(listener)
        }
      />,
    );
    const permissionTasks: Promise<void>[] = [];
    const permissionErrors: string[] = [];
    const off = session.backend.subscribeEvents((event) => {
      if (event.type !== "permission.requested") return;
      permissionTasks.push(
        (async (): Promise<void> => {
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
          permissionErrors.push("PERMISSION_HANDLER_FAILED");
          await session.backend.abortRun(event.request.runId);
        }),
      );
    });
    let passed = false,
      phase = "open-connect";
    let savedProtocol: string | undefined;
    let discoveredReasoning: UiReasoningCapabilityView | undefined;
    let checkpoint: Awaited<ReturnType<typeof session.checkpoint>> | undefined;
    const frames: Record<string, string> = {};
    const cleanupErrors: string[] = [];
    async function key(value: string): Promise<void> {
      app.stdin.write(value);
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    async function field(value: string): Promise<void> {
      await key("\r");
      await key(value);
      await key("\r");
    }
    try {
      await waitForFrame(app, promptIsReady, 15_000);
      expect(await session.backend.getCurrentModel()).toBeNull();
      await key("/connect");
      await key("\r");
      await waitForFrame(
        app,
        (frame) => frame.includes("Provider") && frame.includes("Protocol"),
      );
      await field("zenmux");
      await key("\u001B[6~");
      await field(profile.baseUrl);
      await key("\u001B[6~");
      await field("ZENMUX_API_KEY");
      // Choose protocol and the output limit before model name makes the draft saveable.
      for (let i = 0; i < 4; i++) await key("\u001B[6~");
      await field("4096");
      await key("\u001B[6~");
      await key("\r");
      if (profile.protocol === "openai-responses") await key("\u001B[B");
      await key("\r");
      for (let i = 0; i < 3; i++) await key("\u001B[5~");
      await field(profile.model);
      phase = "save";
      frames.configured = await waitForFrame(
        app,
        (frame) => frame.includes("saved"),
        30_000,
      );
      const config = JSON.parse(
        await readFile(join(session.root, "config/model.json"), "utf8"),
      ) as { apiConfig: { interfaceProvider: string } };
      savedProtocol = config.apiConfig.interfaceProvider;
      expect(savedProtocol).toBe(profile.protocol);
      expect(frames.configured).toContain(profile.model);
      phase = "discover-reasoning-default";
      const discoveryDeadline = Date.now() + 30_000;
      do {
        discoveredReasoning = (await session.backend.getCurrentModel())
          ?.reasoning;
        if (discoveredReasoning?.status === "identified") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < discoveryDeadline);
      expect(discoveredReasoning).toMatchObject({
        status: "identified",
        mode: "effort",
        default: { enabled: true, effort: "medium" },
      });
      expect(discoveredReasoning?.efforts).toContain("medium");
      expect(discoveredReasoning?.efforts).toContain(selectedEffort);
      await key("\u001B");
      await waitForFrame(app, promptIsReady, 15_000);
      if (selectedEffort !== "medium") {
        phase = "select-effort";
        await key("/effort");
        await key("\r");
        frames.effort = await waitForFrame(
          app,
          (frame) =>
            frame.includes("Reasoning Effort") &&
            frame.includes(selectedEffort),
        );
        const options = discoveredReasoning?.efforts ?? [];
        const movement =
          options.indexOf(selectedEffort) - options.indexOf("medium");
        for (let index = 0; index < Math.abs(movement); index++)
          await key(movement > 0 ? "\u001B[B" : "\u001B[A");
        await key("\r");
        await waitForFrame(app, promptIsReady, 15_000);
      }
      phase = "real-tool-loop";
      await key(
        `Use the read tool exactly once on ${session.readFilePath}, with only file_path. Report Project, Release and Owner exactly. Do not use shell or change files.`,
      );
      await key("\r");
      await waitForFrame(
        app,
        (frame) =>
          frame.includes("Cedar") &&
          frame.includes("Lin") &&
          frame.includes("17"),
        180_000,
      );
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const snapshot = await session.backend.getSnapshot();
        if (snapshot.prompts?.some((prompt) => prompt.status === "succeeded"))
          break;
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await Promise.all(permissionTasks);
      checkpoint = await session.checkpoint("tui-real-tool");
      expect(checkpoint.answer).toMatchObject({
        project: true,
        release: true,
        owner: true,
      });
      expect(checkpoint.toolCalls).toContainEqual({
        name: "read",
        status: "completed",
      });
      expect(checkpoint.persisted.completedTools.length).toBeGreaterThan(0);
      expect(
        checkpoint.persisted.completedTools.every((item) => item.allowed),
      ).toBe(true);
      expect(checkpoint.privateStateVisible).toBe(false);
      const primary = session.wire.filter(
        (item) =>
          item.kind === "generation" && item.context?.purpose === "agent-step",
      );
      expect(primary.length).toBeGreaterThanOrEqual(2);
      for (const item of primary)
        expect(item).toMatchObject({
          protocol: profile.protocol,
          model: profile.model,
          status: 200,
          reasoning: { effort: selectedEffort },
        });
      if (selectedEffort !== "medium") {
        const snapshot = await session.backend.getSnapshot();
        const active = snapshot.sessions.find(
          (candidate) => candidate.id === snapshot.activeSessionId,
        );
        expect(active?.reasoning).toMatchObject({
          enabled: true,
          effort: selectedEffort,
        });
      }
      expect(
        auditFormalToolExchange(
          primary.filter((item) => item.kind === "generation"),
        ),
      ).toMatchObject({ exercised: true, valid: true });
      expect(permissionErrors).toEqual([]);
      frames.completed = app.lastFrame() ?? "";
      passed = true;
    } finally {
      off();
      try {
        app.unmount();
      } catch {
        cleanupErrors.push("TUI_UNMOUNT_FAILED");
      }
      try {
        await session.close();
      } catch {
        cleanupErrors.push("BACKEND_CLOSE_FAILED");
      }
      await writeFile(
        evidencePath,
        JSON.stringify(
          {
            stage: "D",
            entry: "TerminalApp stdin with persistent backend",
            profile: profile.id,
            emptyConfig: true,
            seededVerifiedCapabilities: false,
            phase,
            result: passed && cleanupErrors.length === 0 ? "passed" : "failed",
            savedProtocol,
            discoveredReasoning,
            frames,
            checkpoint,
            permissionErrors,
            cleanupErrors,
            providerRequests: session.providerRequests,
            wire: session.wire,
          },
          null,
          2,
        ) + "\n",
      );
    }
    expect(cleanupErrors).toEqual([]);
  });
});
