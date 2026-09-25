import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { CoreAPI, UiPermissionRequest } from "ohbaby-sdk";
import { PermissionDialog } from "./permission-dialog.js";

const request: UiPermissionRequest = {
  id: "a",
  sessionId: "root",
  rootSessionId: "root",
  runId: "run",
  callId: "call",
  messageId: "message",
  createdAt: 1,
  title: "Approve",
  description: "Run command",
  choices: [{ id: "allow_once", intent: "allow", label: "Allow once" }],
};
const context = {
  permissionEpoch: "epoch",
  rootSessionId: "root",
  bindingGeneration: 1,
};
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("approval response ownership", () => {
  it.each(["request", "root", "generation", "epoch", "return"] as const)(
    "ignores the previous response after changing %s",
    async (changed) => {
      let rejectFirst!: (error: Error) => void;
      const respondPermission = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectFirst = reject;
            }),
        )
        .mockImplementation(() => new Promise<void>(() => undefined));
      const client = { respondPermission } as unknown as CoreAPI;
      const onResync = vi.fn();
      const app = render(
        <PermissionDialog
          client={client}
          request={request}
          context={context}
          ready
          onResync={onResync}
        />,
      );
      try {
        await flush();
        app.stdin.write("\r");
        await flush();
        expect(respondPermission).toHaveBeenCalledTimes(1);
        const nextRequest =
          changed === "request" || changed === "return"
            ? { ...request, id: "b" }
            : changed === "root"
              ? { ...request, rootSessionId: "other" }
              : request;
        const nextContext =
          changed === "root"
            ? { ...context, rootSessionId: "other" }
            : changed === "generation"
              ? { ...context, bindingGeneration: 2 }
              : changed === "epoch"
                ? { ...context, permissionEpoch: "new-epoch" }
                : context;
        app.rerender(
          <PermissionDialog
            client={client}
            request={nextRequest}
            context={nextContext}
            ready
            onResync={onResync}
          />,
        );
        await flush();
        if (changed === "return") {
          app.rerender(
            <PermissionDialog
              client={client}
              request={request}
              context={context}
              ready
              onResync={onResync}
            />,
          );
          await flush();
        }
        app.stdin.write("\r");
        await flush();
        expect(respondPermission).toHaveBeenCalledTimes(2);
        rejectFirst(
          Object.assign(new Error("Stale approval failure"), {
            code: "PERMISSION_NOT_PENDING",
          }),
        );
        await flush();
        app.stdin.write("\r");
        await flush();
        expect(onResync).not.toHaveBeenCalled();
        expect(app.lastFrame()).not.toContain("Stale approval failure");
        expect(respondPermission).toHaveBeenCalledTimes(2);
        expect(app.lastFrame()).toContain("sending...");
      } finally {
        app.unmount();
        app.cleanup();
      }
    },
  );
});
