// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { UiBackendClient, UiCompactSessionResult } from "ohbaby-sdk";
import { useCompactRequest } from "./use-compact-request.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const usage = {
  contextLimit: 100000,
  currentTokens: 12000,
  modelId: "test",
  remainingTokens: 88000,
  usageRatio: 0.12,
};

function result(
  status: UiCompactSessionResult["status"],
  error?: string,
): UiCompactSessionResult {
  return {
    status,
    sessionId: "session",
    usageBefore: { ...usage, currentTokens: 112000 },
    usageAfter: usage,
    ...(error === undefined ? {} : { error }),
  };
}

function mount(
  compactSession: UiBackendClient["compactSession"],
  onError = vi.fn(),
): {
  readonly state: () => ReturnType<typeof useCompactRequest>;
  readonly switchSession: (sessionId: string) => void;
  readonly unmount: () => void;
} {
  let latest!: ReturnType<typeof useCompactRequest>;
  const client = { compactSession };
  function Probe({ sessionId }: { sessionId: string }): null {
    latest = useCompactRequest(client, sessionId, onError);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(<Probe sessionId="session" />);
  });
  return {
    state: () => latest,
    switchSession: (sessionId): void => {
      act(() => {
        root.render(<Probe sessionId={sessionId} />);
      });
    },
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
    },
  };
}

describe("useCompactRequest", () => {
  it.each(["result", "rejection"])(
    "does not show a late %s failure in another session",
    async (failureKind) => {
      let complete!: (value: UiCompactSessionResult) => void;
      let fail!: (error: Error) => void;
      const onError = vi.fn();
      const hook = mount(
        () =>
          new Promise<UiCompactSessionResult>((resolve, reject) => {
            complete = resolve;
            fail = reject;
          }),
        onError,
      );
      try {
        act(() => {
          hook.state().start("session");
        });
        hook.switchSession("other");
        expect(hook.state().isCompacting("session")).toBe(true);
        expect(hook.state().isCompacting("other")).toBe(false);
        await act(async () => {
          if (failureKind === "result")
            complete(result("failed", "previous session failure"));
          else fail(new Error("previous session failure"));
          await Promise.resolve();
        });
        expect(hook.state().isCompacting("session")).toBe(false);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        hook.unmount();
      }
    },
  );

  it("tracks the request per session until the server answers", async () => {
    let complete!: (value: UiCompactSessionResult) => void;
    const hook = mount(
      () =>
        new Promise<UiCompactSessionResult>((resolve) => {
          complete = resolve;
        }),
    );
    try {
      act(() => {
        hook.state().start("session");
      });
      expect(hook.state().isCompacting("session")).toBe(true);
      expect(hook.state().isCompacting("other")).toBe(false);
      await act(async () => {
        complete(result("compacted"));
        await Promise.resolve();
      });
      expect(hook.state().isCompacting("session")).toBe(false);
      // A compacted result is shown by the durable conversation notice instead.
      expect(hook.state().notice).toBeNull();
    } finally {
      hook.unmount();
    }
  });

  it("reports not-needed as a transient notice", async () => {
    const hook = mount(vi.fn().mockResolvedValue(result("not-needed")));
    try {
      await act(async () => {
        hook.state().start("session");
        await Promise.resolve();
      });
      expect(hook.state().notice).toEqual({
        sessionId: "session",
        text: "Nothing to compact",
      });
    } finally {
      hook.unmount();
    }
  });

  it.each([
    ["failed", "provider failed", "Compaction failed: provider failed"],
    ["inflated", undefined, "Compaction did not reduce context"],
  ] as const)(
    "surfaces a %s result as an error",
    async (status, error, message) => {
      const onError = vi.fn();
      const hook = mount(
        vi.fn().mockResolvedValue(result(status, error)),
        onError,
      );
      try {
        await act(async () => {
          hook.state().start("session");
          await Promise.resolve();
        });
        expect(onError).toHaveBeenCalledWith(message);
      } finally {
        hook.unmount();
      }
    },
  );

  it("ignores a second start while one is pending", () => {
    const compactSession = vi.fn(
      () => new Promise<UiCompactSessionResult>(() => undefined),
    );
    const hook = mount(compactSession);
    try {
      act(() => {
        hook.state().start("session");
        hook.state().start("session");
      });
      expect(compactSession).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
    }
  });

  it("aborts pending requests on unmount without reporting an error", async () => {
    let signal: AbortSignal | undefined;
    const onError = vi.fn();
    const hook = mount(
      (input) =>
        new Promise<UiCompactSessionResult>((_, reject) => {
          signal = input?.signal;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
      onError,
    );
    act(() => {
      hook.state().start("session");
    });
    hook.unmount();
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
