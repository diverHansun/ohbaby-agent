import { describe, expect, it } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import {
  createDaemonRpcFailure,
  createDaemonRpcRequest,
  createDaemonRpcSuccess,
  DAEMON_RPC_METHODS,
  parseDaemonRpcRequest,
  parseDaemonSseEvent,
} from "./protocol.js";

describe("daemon protocol", () => {
  it("creates serializable rpc requests", () => {
    expect(
      createDaemonRpcRequest({
        clientId: "client_1",
        id: "rpc_1",
        method: "getSnapshot",
        params: [],
      }),
    ).toEqual({
      clientId: "client_1",
      id: "rpc_1",
      method: "getSnapshot",
      params: [],
    });
  });

  it("accepts supported rpc methods and rejects unknown methods", () => {
    expect(
      parseDaemonRpcRequest({
        clientId: "client_1",
        id: "rpc_1",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      }),
    ).toEqual({
      clientId: "client_1",
      id: "rpc_1",
      method: "initializeClient",
      params: [{ resumeSessionId: "session_1" }],
    });

    expect(() =>
      parseDaemonRpcRequest({
        clientId: "client_1",
        id: "rpc_1",
        method: "unknown",
        params: [],
      }),
    ).toThrow("Unsupported daemon rpc method");
  });

  it("round-trips success and failure responses through JSON", () => {
    const success = createDaemonRpcSuccess("rpc_1", {
      activeSessionId: null,
    });
    const failure = createDaemonRpcFailure("rpc_2", new TypeError("bad rpc"));

    expect(JSON.parse(JSON.stringify(success))).toEqual({
      id: "rpc_1",
      ok: true,
      result: { activeSessionId: null },
    });
    expect(JSON.parse(JSON.stringify(failure))).toEqual({
      error: {
        message: "bad rpc",
        name: "TypeError",
      },
      id: "rpc_2",
      ok: false,
    });
  });

  it("parses supported SSE event envelopes", () => {
    const uiEvent: UiEvent = {
      session: {
        createdAt: "2026-06-12T00:00:00.000Z",
        id: "session_1",
        messages: [],
        title: "Session",
        updatedAt: "2026-06-12T00:00:00.000Z",
      },
      type: "session.updated",
    };

    expect(
      parseDaemonSseEvent({ type: "hello", clientId: "client_1" }),
    ).toEqual({ clientId: "client_1", type: "hello" });
    expect(parseDaemonSseEvent({ type: "ui.event", event: uiEvent })).toEqual({
      event: uiEvent,
      type: "ui.event",
    });
    expect(
      parseDaemonSseEvent({ type: "error", message: "stream died" }),
    ).toEqual({ message: "stream died", type: "error" });
  });

  it("covers every CoreAPI method", () => {
    expect(DAEMON_RPC_METHODS).toEqual([
      "getSnapshot",
      "initializeClient",
      "getContextWindowUsage",
      "listCommands",
      "submitPrompt",
      "compactSession",
      "getCurrentModel",
      "connectModel",
      "setSearchApiKey",
      "executeCommand",
      "respondPermission",
      "respondInteraction",
      "abortRun",
    ]);
  });
});
