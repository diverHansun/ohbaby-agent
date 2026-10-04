import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { CoreAPI, UiPermissionRequest } from "ohbaby-sdk";
import { LayoutProvider } from "../layout/context.js";
import { computeLayoutMetrics } from "../layout/metrics.js";
import { DialogManager } from "./manager.js";
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

it("Esc without deny never submits and explains explicit choice", async () => {
  const respondPermission = vi.fn();
  const app = render(
    <PermissionDialog
      client={{ respondPermission } as unknown as CoreAPI}
      request={request}
      context={context}
      ready
      onResync={vi.fn()}
    />,
  );
  await flush();
  app.stdin.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(respondPermission).not.toHaveBeenCalled();
  expect(app.lastFrame()).toContain("Choose an option explicitly");
  app.unmount();
  app.cleanup();
});
it("keeps selected choice identity across reorder", async () => {
  const respondPermission = vi.fn(() => new Promise<void>(() => undefined));
  const deny = { id: "deny", intent: "deny" as const, label: "Reject" };
  const client = { respondPermission } as unknown as CoreAPI;
  const app = render(
    <PermissionDialog
      client={client}
      request={{ ...request, choices: [request.choices[0], deny] }}
      context={context}
      ready
      onResync={vi.fn()}
    />,
  );
  await flush();
  app.rerender(
    <PermissionDialog
      client={client}
      request={{ ...request, choices: [deny, request.choices[0]] }}
      context={context}
      ready
      onResync={vi.fn()}
    />,
  );
  await flush();
  app.stdin.write("\r");
  await flush();
  expect(respondPermission).toHaveBeenCalledWith(
    "a",
    { choiceId: "allow_once" },
    context,
  );
  app.unmount();
  app.cleanup();
});

it.each(["not ready", "no context", "no choices", "too small"])(
  "guards submission while %s",
  async (kind) => {
    const respondPermission = vi.fn(() => new Promise<void>(() => undefined));
    const app = render(
      <PermissionDialog
        client={{ respondPermission } as unknown as CoreAPI}
        request={
          kind === "no choices"
            ? { ...request, choices: [] }
            : {
                ...request,
                choices: [
                  ...request.choices,
                  { id: "deny", label: "Reject", intent: "deny" },
                ],
              }
        }
        ready={kind !== "not ready"}
        context={kind === "no context" ? undefined : context}
        maxHeight={kind === "too small" ? 2 : 18}
        onResync={vi.fn()}
      />,
    );
    await flush();
    app.stdin.write("\r");
    app.stdin.write("\r");
    app.stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(respondPermission).not.toHaveBeenCalled();
    app.unmount();
    app.cleanup();
  },
);
it("reads long labels while pending within a bounded window and explains session scope", async () => {
  const respondPermission = vi.fn(() => new Promise<void>(() => undefined));
  const app = render(
    <PermissionDialog
      client={{ respondPermission } as unknown as CoreAPI}
      request={{
        ...request,
        sessionId: "child",
        sourceLabel: "Worker",
        description: Array.from(
          { length: 30 },
          (_, i) => `body-${String(i)}`,
        ).join("\n"),
        choices: [
          {
            id: "allow_always",
            intent: "allow",
            label: Array.from(
              { length: 20 },
              (_, i) => `label-${String(i)}`,
            ).join("\n"),
          },
        ],
      }}
      ready
      context={context}
      maxHeight={8}
      onResync={vi.fn()}
    />,
  );
  await flush();
  app.stdin.write("\r");
  app.stdin.write("\r");
  await flush();
  expect(respondPermission).toHaveBeenCalledTimes(1);
  expect((app.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(8);
  let frames = app.lastFrame() ?? "";
  for (let i = 0; i < 40; i++) {
    app.stdin.write("\u001b[6~");
    await flush();
    frames += app.lastFrame() ?? "";
    expect((app.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(8);
  }
  expect(frames).toContain("body-29");
  expect(frames).toContain("label-19");
  expect(frames).toContain("this subagent session");
  expect(frames).not.toContain("[allow]");
  app.unmount();
  app.cleanup();
});
it("windows many choices and targets the selected long label", async () => {
  const respondPermission = vi.fn(() => new Promise<void>(() => undefined));
  const choices = Array.from({ length: 10 }, (_, i) => ({
    id: `c${String(i)}`,
    intent: "allow" as const,
    label: `Option ${String(i)}\nFull option ${String(i)}`,
  }));
  const app = render(
    <PermissionDialog
      client={{ respondPermission } as unknown as CoreAPI}
      request={{ ...request, choices }}
      ready
      context={context}
      maxHeight={9}
      onResync={vi.fn()}
    />,
  );
  await flush();
  for (let i = 0; i < 9; i++) {
    app.stdin.write("\u001b[B");
    await flush();
  }
  expect(app.lastFrame()).toContain("> Option 9");
  expect(app.lastFrame()).toContain("Full option 9");
  expect(app.lastFrame()).not.toContain("  Option 0");
  app.stdin.write("\r");
  await flush();
  expect(respondPermission).toHaveBeenCalledWith(
    "a",
    { choiceId: "c9" },
    context,
  );
  app.unmount();
  app.cleanup();
});
it("resyncs an expired response and blocks further replies", async () => {
  const respondPermission = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("expired"), { code: "PERMISSION_NOT_PENDING" }),
    );
  const onResync = vi.fn();
  const app = render(
    <PermissionDialog
      client={{ respondPermission } as unknown as CoreAPI}
      request={request}
      ready
      context={context}
      onResync={onResync}
    />,
  );
  await flush();
  app.stdin.write("\r");
  await flush();
  app.stdin.write("\r");
  await flush();
  expect(onResync).toHaveBeenCalledOnce();
  expect(respondPermission).toHaveBeenCalledOnce();
  expect(app.lastFrame()).toContain("Synchronizing approvals");
  app.unmount();
  app.cleanup();
});
it("shows the actual operation on the first short approval page", async () => {
  const app = render(
    <PermissionDialog
      client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
      request={{
        ...request,
        choices: [
          ...request.choices,
          { id: "reject", label: "Reject", intent: "deny" },
        ],
      }}
      ready
      context={context}
      maxHeight={9}
      onResync={vi.fn()}
    />,
  );
  await flush();
  const frame = app.lastFrame() ?? "";
  expect(frame.split("\n")[2]).toBe("Run command");
  expect(frame.match(/Permission: Approve/gu)).toHaveLength(1);
  expect(frame).not.toContain("Selected option:");
  app.unmount();
  app.cleanup();
});
it("makes synchronization errors visible immediately with their recovery hint", async () => {
  const app = render(
    <PermissionDialog
      client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
      request={request}
      ready={false}
      context={context}
      syncError="Approval connection failed"
      retryHint="Ctrl+R retry recovery"
      maxHeight={9}
      onResync={vi.fn()}
    />,
  );
  await flush();
  expect(app.lastFrame()).toContain("Approval connection failed");
  expect(app.lastFrame()).toContain("Ctrl+R retry recovery");
  expect(app.lastFrame()).not.toContain("Synchronizing approvals...");
  app.unmount();
  app.cleanup();
});
it("preserves operation first and full truncated title/source in an 80x12 reading window", async () => {
  const title = "very-long-operation-".repeat(14) + "TITLE-END";
  const sourceLabel = "long-worker-".repeat(15) + "SOURCE-END";
  const layout = computeLayoutMetrics({ columns: 80, rows: 12 });
  const app = render(
    <LayoutProvider value={layout}>
      <PermissionDialog
        client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
        request={{
          ...request,
          title,
          sourceLabel,
          sessionId: "child",
          choices: [
            ...request.choices,
            { id: "allow_always", label: "Always allow", intent: "allow" },
            { id: "reject", label: "Reject", intent: "deny" },
          ],
        }}
        ready
        context={context}
        maxHeight={layout.approvalRows}
        onResync={vi.fn()}
      />
    </LayoutProvider>,
  );
  await flush();
  expect((app.lastFrame() ?? "").split("\n")[2]).toBe("Run command");
  let frames = app.lastFrame() ?? "";
  let readText = (app.lastFrame() ?? "").split("\n").slice(2, 4).join("");
  for (let i = 0; i < 30; i++) {
    app.stdin.write("\u001b[6~");
    await flush();
    frames += app.lastFrame() ?? "";
    readText += (app.lastFrame() ?? "").split("\n").slice(2, 4).join("");
    expect((app.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(9);
  }
  expect(readText.replace(/\s/gu, "")).toContain(title);
  expect(readText.replace(/\s/gu, "")).toContain(sourceLabel);
  expect(frames).toContain("TITLE-END");
  expect(frames).toContain("SOURCE-END");
  expect(frames).not.toContain("Selected option:");
  app.unmount();
  app.cleanup();
});
it("keeps Ctrl+R recovery distinct from R approval sync retry", async () => {
  const retry = vi.fn();
  const app = render(
    <DialogManager
      client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
      interactions={[]}
      permissions={[request]}
      permissionSync={{
        status: "error",
        binding: null,
        requests: [request],
        permissionRevision: 1,
        attempts: 1,
        error: "Approval sync disconnected",
      }}
      onRetryPermissions={retry}
      approvalRetryHint="Ctrl+R retry recovery"
    />,
  );
  await flush();
  expect(app.lastFrame()).toContain("Approval sync disconnected");
  expect(app.lastFrame()).toContain("R retry approval sync");
  expect(app.lastFrame()).toContain("Ctrl+R retry recovery");
  app.stdin.write("\u0012");
  await flush();
  expect(retry).not.toHaveBeenCalled();
  app.stdin.write("r");
  await flush();
  expect(retry).toHaveBeenCalledOnce();
  app.unmount();
  app.cleanup();
});

it("shows one actionable choice list without static options or internal session IDs", async () => {
  const app = render(
    <PermissionDialog
      client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
      request={{
        ...request,
        sessionId: "session_private_root",
        rootSessionId: "session_private_root",
        choices: [
          request.choices[0],
          { id: "allow_always", intent: "allow", label: "Always allow" },
          { id: "deny", intent: "deny", label: "Reject" },
        ],
      }}
      ready
      context={context}
      onResync={vi.fn()}
    />,
  );
  await flush();
  const frame = app.lastFrame() ?? "";
  expect(frame.match(/Allow once/gu)).toHaveLength(1);
  expect(frame).toContain("Allow matching requests in this session");
  expect(frame).not.toContain("Option:");
  expect(frame).not.toContain("session_private_root");
  expect(frame).not.toContain("PgUp/PgDn");
  expect(frame).not.toMatch(/\d+–\d+\/\d+/u);
  app.stdin.write("\u001b[B");
  await flush();
  expect(app.lastFrame()).toContain("Run command");
  app.unmount();
  app.cleanup();
});

it("keeps the operation visible when choosing a short option beneath a truncated title", async () => {
  const app = render(
    <PermissionDialog
      client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
      request={{
        ...request,
        title: "Long operation ".repeat(20),
        choices: [
          request.choices[0],
          { id: "deny", intent: "deny", label: "Reject" },
        ],
      }}
      ready
      context={context}
      onResync={vi.fn()}
      maxHeight={9}
    />,
  );
  await flush();
  app.stdin.write("\u001b[B");
  await flush();
  expect(app.lastFrame()).toContain("Run command");
  expect(app.lastFrame()).toContain("> Reject");
  app.unmount();
  app.cleanup();
});
it("keeps a custom single-line persistent approval label reachable", async () => {
  const originalLabel = "Allow only the matching workspace requests";
  const app = render(
    <PermissionDialog
      client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
      request={{
        ...request,
        choices: [
          { id: "allow_always", intent: "allow", label: originalLabel },
        ],
      }}
      ready
      context={context}
      onResync={vi.fn()}
    />,
  );
  await flush();
  expect(app.lastFrame()).toContain(originalLabel);
  expect(app.lastFrame()).toContain("Allow matching requests in this session");
  app.unmount();
  app.cleanup();
});

it("does not truncate a fitting error by appending the reading range", async () => {
  const syncError =
    "Approval sync failed: expected session generation 9876543210 end";
  const app = render(
    <LayoutProvider value={computeLayoutMetrics({ columns: 80, rows: 24 })}>
      <PermissionDialog
        client={{ respondPermission: vi.fn() } as unknown as CoreAPI}
        request={{
          ...request,
          description: Array.from(
            { length: 20 },
            (_, i) => `detail-${String(i)}`,
          ).join("\n"),
        }}
        ready={false}
        syncError={syncError}
        context={context}
        onResync={vi.fn()}
        maxHeight={9}
      />
    </LayoutProvider>,
  );
  await flush();
  expect(app.lastFrame()).toContain(syncError);
  app.stdin.write("\u001b[6~");
  await flush();
  expect(app.lastFrame()).toContain(syncError);
  app.unmount();
  app.cleanup();
});

it("keeps the reading position when a short response error occurs", async () => {
  const app = render(
    <PermissionDialog
      client={
        {
          respondPermission: vi
            .fn()
            .mockRejectedValue(new Error("Connection failed")),
        } as unknown as CoreAPI
      }
      request={{
        ...request,
        description: Array.from(
          { length: 20 },
          (_, i) => `detail-${String(i)}`,
        ).join("\n"),
      }}
      ready
      context={context}
      onResync={vi.fn()}
      maxHeight={9}
    />,
  );
  await flush();
  app.stdin.write("\r");
  await flush();
  expect(app.lastFrame()).toContain("detail-0");
  expect(app.lastFrame()).toContain("Error: Connection failed");
  expect(app.lastFrame()?.match(/Error: Connection failed/gu)).toHaveLength(1);
  app.unmount();
  app.cleanup();
});
