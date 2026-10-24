// @vitest-environment jsdom
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferableAbortController } from "node:util";
import { createInProcessUiBackendClient } from "ohbaby-agent";
import { createDaemonServerApp } from "ohbaby-server";
import type { UiSnapshot } from "ohbaby-sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryGoalPersistence } from "../../../../packages/ohbaby-agent/src/goals/persistence.js";
import { createOhbabyWebRuntime } from "../runtime/index.js";
import { OhbabyWebApp } from "./App.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

async function waitFor(check: () => void): Promise<void> {
  const deadline = Date.now() + 3000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw lastError;
}

interface ClientFixture {
  readonly container: HTMLDivElement;
  readonly runtime: ReturnType<typeof createOhbabyWebRuntime>;
  readonly persistence: InMemoryGoalPersistence;
  readonly commands: unknown[];
  dispose(): Promise<void>;
}

async function fixture(
  input: {
    readonly status?: "paused" | "blocked";
    readonly reached?: boolean;
  } = {},
): Promise<ClientFixture> {
  vi.stubGlobal("AbortController", transferableAbortController().constructor);
  vi.stubGlobal(
    "AbortSignal",
    transferableAbortController().signal.constructor,
  );
  vi.stubGlobal("localStorage", undefined);
  const directory = await mkdtemp(join(tmpdir(), "goal-resume-web-"));
  vi.stubEnv("OHBABY_HOME", join(directory, "home"));
  const persistence = new InMemoryGoalPersistence();
  await persistence.append("session_1", {
    type: "create",
    goalId: "goal_web",
    objective: "Finish the goal flow",
    actor: "user",
    budgetLimits: {
      turnBudget: input.reached ? 20 : 30,
      wallClockBudgetMs: input.reached ? 3600000 : 7200000,
    },
  });
  await persistence.append("session_1", {
    type: "update",
    goalId: "goal_web",
    status: input.status ?? "blocked",
    pauseReason: "budget reached",
    turnsUsed: 20,
    wallClockMs: 3600000,
  });
  const timestamp = "2026-10-15T00:00:00.000Z";
  const initialSnapshot: UiSnapshot = {
    activeSessionId: "session_1",
    permissions: [],
    runs: [],
    status: { kind: "idle" },
    sessions: [
      {
        id: "session_1",
        title: "Goal session",
        projectRoot: directory,
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
  const backend = createInProcessUiBackendClient({
    initialSnapshot,
    goalPersistence: persistence,
    workdir: directory,
    projectDirectory: directory,
    llmClient: {
      config: {
        apiKeyEnv: "UNUSED",
        baseUrl: "https://invalid.test",
        interfaceProvider: "openai-compatible",
        maxTokens: 100,
        model: "fixture",
        provider: "fixture",
        temperature: 0,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: (error: unknown) =>
          error instanceof Error && error.name === "AbortError",
        streamResponse: (request) =>
          Promise.resolve(
            (async function* (): AsyncGenerator<
              { textDelta: string; finishReason: "stop" },
              void,
              unknown
            > {
              await new Promise<void>((_resolve, reject) => {
                const abort = (): void => {
                  reject(
                    Object.assign(new Error("aborted"), { name: "AbortError" }),
                  );
                };
                if (request.signal?.aborted) abort();
                else
                  request.signal?.addEventListener("abort", abort, {
                    once: true,
                  });
              });
              yield { textDelta: "", finishReason: "stop" as const };
            })(),
          ),
      },
    },
  });
  const server = createDaemonServerApp({
    backend,
    authToken: "goal-token",
    commandRecorder: false,
  });
  await server.start();
  const commands: unknown[] = [];
  const runtime = createOhbabyWebRuntime(
    {
      baseUrl: "http://localhost",
      directory,
      clientId: "goal-client",
      token: "goal-token",
      startupIntent: { resumeSessionId: "session_1" },
    },
    {
      fetch: async (request, init = {}) => {
        const url = new URL(
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.href
              : request.url,
        );
        if (
          url.pathname === "/v1/commands" &&
          init.method === "POST" &&
          typeof init.body === "string"
        )
          commands.push(JSON.parse(init.body));
        return server.app.request(`${url.pathname}${url.search}`, {
          body: init.body,
          headers: init.headers,
          method: init.method,
          signal: init.signal,
        });
      },
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await runtime.ready;
  await waitFor(() => {
    expect(runtime.store.getSnapshot().sessionSync.status).toBe("ready");
  });
  act(() => {
    root.render(<OhbabyWebApp runtime={runtime} />);
  });
  return {
    container,
    runtime,
    persistence,
    commands,
    async dispose(): Promise<void> {
      act(() => {
        root.unmount();
      });
      container.remove();
      await runtime.dispose();
      await server.dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function setField(
  container: ParentNode,
  selector: string,
  value: string,
): Promise<void> {
  const input = container.querySelector(selector);
  if (
    !(input instanceof HTMLInputElement) &&
    !(input instanceof HTMLTextAreaElement)
  )
    throw new Error(`Missing field ${selector}`);
  const descriptor = Object.getOwnPropertyDescriptor(
    input instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype,
    "value",
  );
  if (!descriptor?.set) throw new Error("Missing value setter");
  await act(async () => {
    descriptor.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit(container: ParentNode, text: string): Promise<void> {
  await setField(container, ".ohb-composer textarea", text);
  const textarea = container.querySelector(".ohb-composer textarea");
  if (!(textarea instanceof HTMLTextAreaElement))
    throw new Error("Missing composer");
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );
    await Promise.resolve();
  });
}

async function click(container: ParentNode, selector: string): Promise<void> {
  const button = container.querySelector(selector);
  if (!(button instanceof HTMLElement))
    throw new Error(`Missing button ${selector}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

describe("goal resume through the rendered app, real Web runtime and command backend", () => {
  it.each([
    {
      action: "create",
      prefix: "/goal ",
      objective: "检查 <台北> & 東京\n\n  保留第二行\n完成后汇报",
    },
    {
      action: "replace",
      prefix: "/goal replace ",
      objective: "检查 <台北> & 東京\n\n  保留第二行\n完成后汇报",
    },
    {
      action: "create",
      prefix: "/goal\n",
      objective: 'status report for "台北"\n  Keep the full objective',
    },
    {
      action: "replace",
      prefix: "/goal replace\n",
      objective: 'resume "quoted" work\n  Keep indentation',
    },
  ] as const)(
    "preserves the complete objective through the composer and $action panel: $prefix",
    async ({ action, prefix, objective }) => {
      const f = await fixture();
      try {
        if (action === "create") {
          await act(async () => {
            await f.runtime.executeSlashCommand({
              allowOverlay: true,
              sessionId: "session_1",
              text: "/goal cancel",
            });
          });
        }
        await submit(f.container, `${prefix}${objective}`);
        await waitFor(() => {
          expect(
            f.container.querySelector<HTMLTextAreaElement>(
              ".ohb-goal-objective-field textarea",
            )?.value,
          ).toBe(objective);
        });
        await click(f.container, '[data-goal-action="save"]');
        await waitFor(() => {
          expect(
            f.container.querySelector(".ohb-structured-success")?.textContent,
          ).toContain(action === "create" ? "goal created" : "objective saved");
        });
        const records = await f.persistence.list("session_1");
        expect(
          records.filter((record) => record.objective !== undefined).at(-1),
        ).toMatchObject({ objective });
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(["create", "replace"] as const)(
    "keeps the saved %s objective after editing a slash-command draft",
    async (action) => {
      const f = await fixture();
      try {
        if (action === "create") {
          await act(async () => {
            await f.runtime.executeSlashCommand({
              allowOverlay: true,
              sessionId: "session_1",
              text: "/goal cancel",
            });
          });
        }
        await submit(
          f.container,
          action === "create"
            ? "/goal Initial draft"
            : "/goal replace Initial draft",
        );
        const selector = ".ohb-goal-objective-field textarea";
        await waitFor(() => {
          expect(
            f.container.querySelector<HTMLTextAreaElement>(selector)?.value,
          ).toBe("Initial draft");
        });
        const objective = "Final objective\n  Keep the edited body";
        await setField(f.container, selector, objective);
        await click(f.container, '[data-goal-action="save"]');
        await waitFor(() => {
          expect(
            f.container.querySelector(".ohb-structured-success")?.textContent,
          ).toContain(action === "create" ? "goal created" : "objective saved");
        });
        expect(
          (await f.persistence.list("session_1"))
            .filter((record) => record.objective !== undefined)
            .at(-1),
        ).toMatchObject({ objective });
        expect(
          f.container.querySelector<HTMLTextAreaElement>(selector)?.value,
        ).toBe(objective);
        expect(
          f.container.querySelector<HTMLButtonElement>(
            '[data-goal-action="save"]',
          )?.disabled,
        ).toBe(true);
      } finally {
        await f.dispose();
      }
    },
  );

  it("prefills the current objective when replace opens without a draft", async () => {
    const f = await fixture();
    try {
      await submit(f.container, "/goal replace");
      await waitFor(() => {
        expect(
          f.container.querySelector<HTMLTextAreaElement>(
            ".ohb-goal-objective-field textarea",
          )?.value,
        ).toBe("Finish the goal flow");
      });
      expect(f.commands).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  });

  it.each([
    ["/goal resume 100 turns 3h", 100, 10800000],
    ["/goal resume 3h 100 turns", 100, 10800000],
    ["/goal resume 100 turns", 100, 7200000],
    ["/goal resume 3h", 30, 10800000],
    ["/goal resume 100 turns\n3h", 100, 10800000],
    ["/goal resume\n3h 100 turns", 100, 10800000],
  ] as const)(
    "submits %s intact and preserves unspecified budgets and usage",
    async (text, turnBudget, wallClockBudgetMs) => {
      const f = await fixture();
      try {
        await submit(f.container, text);
        await waitFor(() => {
          expect(
            f.container.querySelector(".ohb-goal-strip")?.textContent,
          ).toContain("Active goal");
        });
        expect(f.container.querySelector(".ohb-goal-chip")).toBeNull();
        expect(f.commands).toHaveLength(1);
        expect(f.container.querySelector(".ohb-structured-overlay")).toBeNull();
        const records = await f.persistence.list("session_1");
        const resumed = records.find(
          (record) => record.type === "update" && record.status === "active",
        );
        expect(resumed).toMatchObject({
          budgetLimits: { turnBudget, wallClockBudgetMs },
          wallClockMs: 3600000,
        });
        expect(
          records.some(
            (record) => record.turnsUsed !== undefined && record.turnsUsed < 20,
          ),
        ).toBe(false);
        expect(f.commands[0]).toMatchObject({
          raw: text,
          sessionId: "session_1",
        });
      } finally {
        await f.dispose();
      }
    },
  );

  it.each([
    "/goal resume 100 turns extra",
    "/goal resume 100 turns\nextra",
    "/goal resume\n100 turns extra",
  ])(
    "rejects the complete invalid command without changing any goal record: %j",
    async (text) => {
      const f = await fixture();
      try {
        const before = await f.persistence.list("session_1");
        await submit(f.container, text);
        await waitFor(() => {
          expect(f.commands).toHaveLength(1);
        });
        await waitFor(() => {
          expect(
            f.container.querySelector(".ohb-error-banner[role=alert]")
              ?.textContent,
          ).toContain("Invalid resume budget");
        });
        expect(await f.persistence.list("session_1")).toEqual(before);
        expect(f.container.querySelector(".ohb-structured-overlay")).toBeNull();
        expect(f.commands[0]).toMatchObject({
          raw: text,
        });
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(["paused", "blocked"] as const)(
    "opens no-argument resume for %s and resumes with blank optional fields",
    async (status) => {
      const f = await fixture({ status });
      try {
        await submit(f.container, "/goal resume");
        await waitFor(() => {
          expect(
            f.container.querySelector(".ohb-structured-overlay"),
          ).not.toBeNull();
        });
        expect(f.commands).toHaveLength(0);
        await click(f.container, '[data-goal-action="resume"]');
        await waitFor(() => {
          expect(
            f.container.querySelector(".ohb-structured-success")?.textContent,
          ).toContain("goal resumed");
        });
        const records = await f.persistence.list("session_1");
        expect(
          records.find((record) => record.status === "active"),
        ).toMatchObject({
          budgetLimits: { turnBudget: 30, wallClockBudgetMs: 7200000 },
        });
      } finally {
        await f.dispose();
      }
    },
  );

  it("keeps a failed one-axis panel resume open, then atomically applies both limits", async () => {
    const f = await fixture({ reached: true });
    try {
      await submit(f.container, "/goal resume");
      await waitFor(() => {
        expect(
          f.container.querySelector(".ohb-structured-overlay"),
        ).not.toBeNull();
      });
      await click(f.container, ".ohb-goal-optional-limits summary");
      await setField(f.container, '[aria-label="Turn limit"]', "100");
      const before = await f.persistence.list("session_1");
      await click(f.container, '[data-goal-action="resume"]');
      await waitFor(() => {
        expect(
          f.container.querySelector(".ohb-structured-error")?.textContent,
        ).toMatch(/time|wall|duration/iu);
      });
      expect(await f.persistence.list("session_1")).toEqual(before);
      expect(
        f.container.querySelector(".ohb-structured-overlay"),
      ).not.toBeNull();
      await setField(f.container, '[aria-label="Active duration limit"]', "3h");
      await click(f.container, '[data-goal-action="resume"]');
      await waitFor(() => {
        expect(
          f.container.querySelector(".ohb-structured-success")?.textContent,
        ).toContain("goal resumed");
      });
      const records = await f.persistence.list("session_1");
      expect(
        records.find((record) => record.status === "active"),
      ).toMatchObject({
        budgetLimits: { turnBudget: 100, wallClockBudgetMs: 10800000 },
      });
    } finally {
      await f.dispose();
    }
  });

  it("retains backend session validation for parameterized resume", async () => {
    const f = await fixture();
    try {
      const before = await f.persistence.list("session_1");
      await act(async () => {
        const completion = await f.runtime.executeSlashCommand({
          allowOverlay: true,
          sessionId: "wrong-session",
          text: "/goal resume 100 turns 3h",
        });
        expect(completion).toMatchObject({
          status: "failed",
          error: { message: "Session metadata unavailable: wrong-session" },
        });
      });
      expect(await f.persistence.list("session_1")).toEqual(before);
    } finally {
      await f.dispose();
    }
  });

  it("resumes a paused goal directly from the composer strip and falls back to the resume panel when budget is exhausted", async () => {
    const paused = await fixture({ status: "paused", reached: false });
    try {
      await click(paused.container, '[data-goal-strip-action="resume"]');
      await waitFor(() => {
        expect(
          paused.container.querySelector(".ohb-goal-strip")?.textContent,
        ).toContain("Active goal");
      });
      expect(
        paused.container.querySelector(".ohb-structured-overlay"),
      ).toBeNull();
      await click(paused.container, '[data-goal-strip-action="pause"]');
      await waitFor(() => {
        expect(
          paused.container.querySelector(".ohb-goal-strip")?.textContent,
        ).toContain("Paused goal");
      });
    } finally {
      await paused.dispose();
    }

    const exhaustedPaused = await fixture({ status: "paused", reached: true });
    try {
      await click(
        exhaustedPaused.container,
        '[data-goal-strip-action="resume"]',
      );
      await waitFor(() => {
        expect(
          exhaustedPaused.container.querySelector(".ohb-structured-overlay"),
        ).not.toBeNull();
      });
      expect(
        exhaustedPaused.container.querySelector(".ohb-structured-error")
          ?.textContent,
      ).toMatch(/budget|turn|duration|time/iu);
    } finally {
      await exhaustedPaused.dispose();
    }
  });
});
