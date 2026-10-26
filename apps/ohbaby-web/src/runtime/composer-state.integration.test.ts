import type { UiCurrentModelConfig, UiPermissionState } from "ohbaby-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectViewModel } from "../ui/session/selectors.js";
import { DEFAULT, fakeDaemon } from "./fake-daemon.test-support.js";
import { createOhbabyWebRuntime, type OhbabyWebRuntime } from "./index.js";

const runtimes: OhbabyWebRuntime[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      location: { pathname: "/", search: "" },
      history: { state: null, replaceState: () => undefined },
    }),
  );
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.unstubAllGlobals();
});

async function start(fetchImpl: typeof fetch): Promise<OhbabyWebRuntime> {
  const runtime = createOhbabyWebRuntime(
    { baseUrl: "http://127.0.0.1:4096", clientId: "review", token: "test" },
    { fetch: fetchImpl },
  );
  runtimes.push(runtime);
  await runtime.ready;
  await vi.waitFor(() => {
    expect({
      loaded: runtime.store.getSnapshot().currentModelLoaded,
      error: runtime.store.getSnapshot().error,
    }).toEqual({ loaded: true, error: null });
  });
  return runtime;
}

function connectedClient(
  runtime: OhbabyWebRuntime,
): NonNullable<OhbabyWebRuntime["client"]> {
  const client = runtime.client;
  if (!client) throw new Error("Expected connected client");
  return client;
}

const fullAccess: UiPermissionState = {
  mode: "auto",
  level: "full-access",
  sessionRules: [],
};

it("shows acknowledged and streamed permission changes before a draft has a session", async () => {
  const daemon = fakeDaemon();
  const runtime = await start(async (input, init) => {
    if (
      new URL(input instanceof Request ? input.url : input).pathname ===
      "/v1/permission"
    )
      return Response.json({ ok: true, permission: fullAccess });
    return daemon.fetch(input, init);
  });
  expect(runtime.store.getSnapshot().view.snapshot).toBeNull();
  await connectedClient(runtime).setPermission({ level: "full-access" });
  expect(
    selectViewModel(runtime.store.getSnapshot()).composer.permissionLevel,
  ).toBe("full-access");
  daemon.emit(
    DEFAULT,
    {
      type: "permission.updated",
      permission: { ...fullAccess, level: "default" },
    },
    10,
  );
  await vi.waitFor(() => {
    expect(
      selectViewModel(runtime.store.getSnapshot()).composer.permissionLevel,
    ).toBe("default");
  });
  daemon.emit(
    DEFAULT,
    { type: "permission.updated", permission: fullAccess },
    9,
  );
  await connectedClient(runtime).getCurrentModel();
  expect(
    selectViewModel(runtime.store.getSnapshot()).composer.permissionLevel,
  ).toBe("default");
});

it("ignores a permission acknowledgment after leaving its client", async () => {
  const daemon = fakeDaemon();
  let resolve!: (response: Response) => void;
  const runtime = await start(async (input, init) => {
    if (
      new URL(input instanceof Request ? input.url : input).pathname ===
      "/v1/permission"
    )
      return new Promise<Response>((done) => {
        resolve = done;
      });
    return daemon.fetch(input, init);
  });
  const pending = connectedClient(runtime).setPermission({
    level: "full-access",
  });
  await runtime.openDraft();
  resolve(Response.json({ ok: true, permission: fullAccess }));
  await pending;
  expect(
    selectViewModel(runtime.store.getSnapshot()).composer.permissionLevel,
  ).toBe("default");
});

it("shares an invalidation read with model subscribers and refreshes on focus without SSE", async () => {
  const daemon = fakeDaemon();
  let model: UiCurrentModelConfig | null = null;
  let reads = 0;
  const runtime = await start(async (input, init) => {
    if (
      new URL(input instanceof Request ? input.url : input).pathname ===
      "/v1/model"
    ) {
      reads++;
      await Promise.resolve();
      return Response.json({ ok: true, model });
    }
    return daemon.fetch(input, init);
  });
  const client = connectedClient(runtime);
  let observed: UiCurrentModelConfig | null | undefined;
  client.subscribeEvents((event) => {
    if (event.type === "model.invalidated")
      void client.getCurrentModel().then((value) => {
        observed = value;
      });
  });
  model = {
    id: "test-model",
    source: "default",
    provider: "local",
    baseUrl: "http://127.0.0.1:9/v1",
    interfaceProvider: "openai-compatible",
    model: "first",
    contextWindowTokens: 32000,
  };
  const before = reads;
  daemon.emit(DEFAULT, { type: "model.invalidated" });
  await vi.waitFor(() => {
    expect(observed?.model).toBe("first");
  });
  expect(reads - before).toBe(1);
  model = { ...model, model: "external" };
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => {
    expect(runtime.store.getSnapshot().currentModel?.model).toBe("external");
  });
});
