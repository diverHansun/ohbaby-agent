import { describe, expect, it, vi } from "vitest";
import type { UiBackendClient, UiSessionCreationResult } from "ohbaby-sdk";
import { DaemonClientViewCoordinator } from "./client-view.js";
import { createOrReuseClientSession } from "./session-access.js";

const session = (id: string, created = false): UiSessionCreationResult => ({
  id,
  created,
  title: id,
  createdAt: "2026-09-27",
  updatedAt: "2026-09-27",
});
const reuse = { reuseInactiveEmpty: { excludeSessionIds: [] as string[] } };
function setup(): DaemonClientViewCoordinator {
  const views = new DaemonClientViewCoordinator();
  views.initializeClient("a", { sessions: [session("empty")] }, {});
  return views;
}
describe("session creation operation", () => {
  it("preserves explicit creation by default and returns the actual outcome", async () => {
    const views = setup();
    const createSession = vi.fn(() => Promise.resolve(session("new", true)));
    const result = await createOrReuseClientSession(
      { createSession },
      views,
      "a",
      "epoch",
    );
    expect(createSession).toHaveBeenCalledWith(undefined);
    expect(result).toMatchObject({
      created: true,
      changed: true,
      session: { id: "new" },
    });
  });
  it("reports existing empty B as reused when switching from A", async () => {
    const views = setup();
    const result = await createOrReuseClientSession(
      { createSession: () => Promise.resolve(session("empty")) },
      views,
      "a",
      "epoch",
      reuse,
    );
    expect(result).toMatchObject({ created: false, changed: true });
  });
  it("fails after an excluded candidate is returned instead of looping or creating again", async () => {
    const views = setup();
    views.initializeClient(
      "b",
      { sessions: [session("empty")] },
      { resumeSessionId: "empty" },
    );
    const createSession = vi.fn(() => Promise.resolve(session("empty")));
    await expect(
      createOrReuseClientSession({ createSession }, views, "a", "epoch", reuse),
    ).rejects.toMatchObject({ code: "SESSION_CREATION_CONTRACT" });
    expect(createSession).toHaveBeenCalledTimes(1);
  });
  it("shares equal concurrent operations", async () => {
    const views = setup();
    let finish!: (value: ReturnType<typeof session>) => void;
    const createSession = vi.fn(
      () =>
        new Promise<ReturnType<typeof session>>((resolve) => {
          finish = resolve;
        }),
    );
    const backend = { createSession };
    const first = createOrReuseClientSession(
      backend,
      views,
      "a",
      "epoch",
      reuse,
    );
    const second = createOrReuseClientSession(
      backend,
      views,
      "a",
      "epoch",
      reuse,
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    finish(session("empty"));
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
  });
  it("keeps force-new and reuse as separate concurrent operations", async () => {
    const views = setup();
    const finish: ((value: ReturnType<typeof session>) => void)[] = [];
    const createSession = vi.fn(
      () =>
        new Promise<ReturnType<typeof session>>((resolve) =>
          finish.push(resolve),
        ),
    );
    const first = createOrReuseClientSession(
      { createSession },
      views,
      "a",
      "epoch",
      reuse,
    );
    const second = createOrReuseClientSession(
      { createSession },
      views,
      "a",
      "epoch",
    );
    const settled = Promise.allSettled([first, second]);
    expect(createSession).toHaveBeenCalledTimes(2);
    finish[0](session("empty"));
    finish[1](session("fresh", true));
    await settled;
  });
  it.each([false, true])(
    "rejects a new row claimed while creation returns (settled=%s) without creating another row",
    async (settled) => {
      const views = setup();
      const createSession = vi.fn(() => {
        const release = views.beginSessionOperation("b", "fresh");
        if (settled) release();
        return Promise.resolve(session("fresh", true));
      });
      await expect(
        createOrReuseClientSession(
          { createSession },
          views,
          "a",
          "epoch",
          reuse,
        ),
      ).rejects.toMatchObject({
        code: "SESSION_CREATION_CONFLICT",
        retryable: true,
      });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(views.binding("a", "epoch").rootSessionId).toBeNull();
    },
  );
  it("rechecks a reused candidate when submit started and settled while the empty read awaited", async () => {
    const views = setup();
    let calls = 0;
    const backend: Pick<UiBackendClient, "createSession"> = {
      createSession: () => {
        calls += 1;
        if (calls === 1) {
          const release = views.beginSessionOperation("b", "empty");
          release();
          return Promise.resolve(session("empty"));
        }
        return Promise.resolve(session("fresh", true));
      },
    };
    const result = await createOrReuseClientSession(
      backend,
      views,
      "a",
      "epoch",
      reuse,
    );
    expect(result.session.id).toBe("fresh");
    expect(calls).toBe(2);
  });
});
