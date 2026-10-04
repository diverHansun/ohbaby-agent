import { expect, it, vi } from "vitest";
import type { UiBackendClient } from "ohbaby-sdk";
import { DaemonClientViewCoordinator } from "./client-view.js";
import { initializePermissionClient } from "./permission-access.js";

it("makes repeated startup initialization preserve selection and authorization binding", async () => {
  const getSessionIndex = vi.fn().mockResolvedValue([]);
  const backend = { getSessionIndex } as unknown as UiBackendClient;
  const views = new DaemonClientViewCoordinator();
  const intent = {
    startupSessionMode: { type: "fresh" },
    initialPermission: { level: "default", mode: "auto" },
  };
  const first = await initializePermissionClient(
    backend,
    views,
    "client",
    intent,
    "epoch",
  );
  views.selectSession("client", "selected-later", first.bindingGeneration);
  const selected = views.binding("client", "epoch");
  expect(
    await initializePermissionClient(backend, views, "client", intent, "epoch"),
  ).toEqual(selected);
  expect(getSessionIndex).toHaveBeenCalledTimes(1);
});
