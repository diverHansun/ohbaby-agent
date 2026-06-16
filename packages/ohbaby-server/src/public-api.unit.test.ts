import { describe, expect, it } from "vitest";
import {
  DaemonPromptQueue,
  PermissionRouter,
  createDaemonAuthToken,
  createRemoteCoreApiHost,
  daemonAuthHeader,
  readDaemonStatus,
  startDaemonServer,
  stopDaemonFromState,
} from "./index.js";

describe("ohbaby-server public API", () => {
  it("exports explicit server and remote entrypoints", () => {
    expect(createDaemonAuthToken).toBeTypeOf("function");
    expect(daemonAuthHeader).toBeTypeOf("function");
    expect(DaemonPromptQueue).toBeTypeOf("function");
    expect(PermissionRouter).toBeTypeOf("function");
    expect(createRemoteCoreApiHost).toBeTypeOf("function");
    expect(readDaemonStatus).toBeTypeOf("function");
    expect(startDaemonServer).toBeTypeOf("function");
    expect(stopDaemonFromState).toBeTypeOf("function");
  });
});
