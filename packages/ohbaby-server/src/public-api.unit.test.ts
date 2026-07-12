import { describe, expect, it } from "vitest";
import {
  InstanceStore,
  PermissionRouter,
  createDaemonAuthToken,
  createRemoteCoreApiHost,
  daemonAuthHeader,
  listDaemonConnections,
  readDaemonStatus,
  resolveWorkspaceScope,
  startDaemonServer,
  stopDaemonFromState,
} from "./index.js";

describe("ohbaby-server public API", () => {
  it("exports explicit server and remote entrypoints", () => {
    expect(createDaemonAuthToken).toBeTypeOf("function");
    expect(daemonAuthHeader).toBeTypeOf("function");
    expect(InstanceStore).toBeTypeOf("function");
    expect(PermissionRouter).toBeTypeOf("function");
    expect(createRemoteCoreApiHost).toBeTypeOf("function");
    expect(listDaemonConnections).toBeTypeOf("function");
    expect(readDaemonStatus).toBeTypeOf("function");
    expect(resolveWorkspaceScope).toBeTypeOf("function");
    expect(startDaemonServer).toBeTypeOf("function");
    expect(stopDaemonFromState).toBeTypeOf("function");
  });
});
