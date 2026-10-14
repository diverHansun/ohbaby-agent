// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { UiCompactSessionResult, UiContextWindowUsage } from "ohbaby-sdk";
import { CompactOverlayBody } from "./CompactOverlay.js";
import { StructuredCommandOverlay } from "./StructuredCommandOverlay.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Runs an interaction inside act and lets pending microtasks settle.
async function flush(interaction: () => unknown): Promise<void> {
  await act(async () => {
    interaction();
    await Promise.resolve();
  });
}

describe("CompactOverlayBody", () => {
  it.each([
    { committed: false, name: "transport abort shows neutral Stop feedback" },
    {
      committed: true,
      name: "an authoritative result already obtained is not overwritten by Stop",
    },
  ])("Stop aborts its own request: $name", async ({ committed }) => {
    let signal: AbortSignal | undefined;
    let complete!: (value: UiCompactSessionResult) => void;
    let fail!: (error: Error) => void;
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
      compactSession: (input?: {
        readonly signal?: AbortSignal;
      }): Promise<UiCompactSessionResult> => {
        signal = input?.signal;
        return new Promise<UiCompactSessionResult>((resolve, reject) => {
          complete = resolve;
          fail = reject;
        });
      },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await flush(() => {
        root.render(<CompactOverlayBody client={client} sessionId="session" />);
      });
      await flush(() => container.querySelector("button")?.click());
      expect(container.textContent).toContain("Compacting session…");
      expect(
        container.querySelector('button[title="Compact session"]')?.textContent,
      ).toBe("Compacting…");
      const stop = container.querySelector<HTMLButtonElement>(
        'button[title="Stop compaction"]',
      );
      expect(stop).not.toBeNull();
      expect(stop?.className).toBe("ohb-button");
      await flush(() => stop?.click());
      expect(signal?.aborted).toBe(true);
      await flush(() => {
        if (committed) {
          const usage = {
            contextLimit: 100000,
            currentTokens: 12000,
            modelId: "test",
            remainingTokens: 88000,
            usageRatio: 0.12,
          };
          complete({
            status: "compacted",
            sessionId: "session",
            usageBefore: usage,
            usageAfter: usage,
          });
        } else fail(new DOMException("Aborted", "AbortError"));
      });
      if (committed) {
        expect(
          container.querySelector(".ohb-structured-success")?.textContent,
        ).toBe("Compacted · 12,000 → 12,000 tokens");
      } else {
        // Abort alone cannot tell whether the server committed; never claim either outcome.
        expect(
          container.querySelector(".ohb-structured-idle")?.textContent,
        ).toBe(
          "Stopped waiting. If compaction had already finished, its result stays in the conversation.",
        );
        expect(container.textContent).not.toContain("Compacted");
      }
      expect(
        container.querySelector('button[title="Stop compaction"]'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("cancels the pending request when the overlay unmounts", async () => {
    let signal: AbortSignal | undefined;
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
      compactSession: (input?: {
        readonly signal?: AbortSignal;
      }): Promise<UiCompactSessionResult> => {
        signal = input?.signal;
        return new Promise<UiCompactSessionResult>(() => undefined);
      },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    await flush(() => {
      root.render(<CompactOverlayBody client={client} sessionId="session" />);
    });
    await flush(() => container.querySelector("button")?.click());
    act(() => {
      root.unmount();
    });
    expect(signal?.aborted).toBe(true);
  });

  it("refreshes current usage after transport cancellation without claiming a rollback", async () => {
    let rejectRequest!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    const client = {
      getContextWindowUsage: vi
        .fn()
        .mockResolvedValueOnce({
          sessionId: "session",
          modelId: "test",
          currentTokens: 92000,
          contextWindowTokens: 100000,
          contextWindowRatio: 0.92,
          estimatedAt: "2026-10-13T00:00:00Z",
        })
        .mockResolvedValueOnce({
          sessionId: "session",
          modelId: "test",
          currentTokens: 12000,
          contextWindowTokens: 100000,
          contextWindowRatio: 0.12,
          estimatedAt: "2026-10-13T00:00:01Z",
        }),
      compactSession: (input?: {
        readonly signal?: AbortSignal;
      }): Promise<UiCompactSessionResult> => {
        signal = input?.signal;
        return new Promise<UiCompactSessionResult>((_, reject) => {
          rejectRequest = reject;
        });
      },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await flush(() => {
        root.render(<CompactOverlayBody client={client} sessionId="session" />);
      });
      await flush(() => container.querySelector("button")?.click());
      await flush(() =>
        container
          .querySelector<HTMLButtonElement>('button[title="Stop compaction"]')
          ?.click(),
      );
      expect(signal?.aborted).toBe(true);
      await flush(() => {
        rejectRequest(new DOMException("Aborted", "AbortError"));
      });
      expect(container.textContent).toContain("12%");
      expect(container.textContent).toContain("Stopped waiting.");
      expect(container.textContent).not.toContain("Compaction stopped");
      expect(container.textContent).not.toContain("Compacted");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("labels token counts as local estimates and reports not-needed plainly", async () => {
    const usage = {
      contextLimit: 100000,
      currentTokens: 12000,
      modelId: "test",
      remainingTokens: 88000,
      usageRatio: 0.12,
    };
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
      compactSession: vi.fn().mockResolvedValue({
        status: "not-needed",
        sessionId: "session",
        usageBefore: usage,
        usageAfter: usage,
      } satisfies UiCompactSessionResult),
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await flush(() => {
        root.render(<CompactOverlayBody client={client} sessionId="session" />);
      });
      expect(container.textContent).toContain(
        "Token counts are local estimates.",
      );
      await flush(() => container.querySelector("button")?.click());
      expect(
        container.querySelector(".ohb-structured-success")?.textContent,
      ).toBe("Nothing to compact");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it.each(["compacted", "inflated", "failed"] as const)(
    "refreshes usage after a %s result",
    async (status) => {
      const before: UiContextWindowUsage = {
        sessionId: "session",
        modelId: "test",
        currentTokens: 112000,
        contextWindowTokens: 100000,
        contextWindowRatio: 1.12,
        estimatedAt: "2026-10-13T00:00:00Z",
      };
      const after = {
        ...before,
        currentTokens: 12000,
        contextWindowRatio: 0.12,
      };
      const usage = {
        contextLimit: 100000,
        currentTokens: 12000,
        modelId: "test",
        remainingTokens: 88000,
        usageRatio: 0.12,
      };
      const result: UiCompactSessionResult = {
        status,
        sessionId: "session",
        usageBefore: { ...usage, currentTokens: 112000 },
        usageAfter: usage,
      };
      const client = {
        getContextWindowUsage: vi
          .fn()
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(after),
        compactSession: vi.fn().mockResolvedValue(result),
      };
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <CompactOverlayBody client={client} sessionId="session" />,
          );
          await Promise.resolve();
        });
        expect(container.textContent).toContain("112%");
        // At or above the 90% auto-compaction line the meter turns warm.
        expect(
          container.querySelector<HTMLElement>(".ohb-compact-usage i")
            ?.className,
        ).toBe("is-high");
        expect(
          container.querySelector<HTMLElement>(".ohb-compact-usage i")?.style
            .width,
        ).toBe("100%");
        expect(container.querySelector('input[type="checkbox"]')).toBeNull();
        await act(async () => {
          container.querySelector("button")?.click();
          await Promise.resolve();
        });
        expect(container.textContent).toContain("12%");
        expect(container.textContent).not.toContain("112%");
        expect(container.querySelector(".ohb-structured-error") !== null).toBe(
          status !== "compacted",
        );
        expect(
          container.querySelector<HTMLElement>(".ohb-compact-usage i")?.style
            .width,
        ).toBe("12%");
        // History-only savedTokens uses a different basis; never show it beside full-window counts.
        expect(container.textContent).not.toContain("saved");
        expect(
          container.querySelector(
            status === "compacted"
              ? ".ohb-structured-success"
              : ".ohb-structured-error",
          )?.textContent,
        ).toBe(
          status === "compacted"
            ? "Compacted · 112,000 → 12,000 tokens"
            : status === "failed"
              ? "Compaction failed"
              : "Compaction did not reduce context",
        );
      } finally {
        act(() => {
          root.unmount();
        });
      }
    },
  );

  it.each(["compacted", "failed"] as const)(
    "keeps the %s result when the usage refresh fails",
    async (status) => {
      const usage = {
        contextLimit: 100000,
        currentTokens: 12000,
        modelId: "test",
        remainingTokens: 88000,
        usageRatio: 0.12,
      };
      const client = {
        getContextWindowUsage: vi
          .fn()
          .mockResolvedValueOnce({
            sessionId: "session",
            modelId: "test",
            currentTokens: 112000,
            contextWindowTokens: 100000,
            contextWindowRatio: 1.12,
            estimatedAt: "2026-10-13T00:00:00Z",
          } satisfies UiContextWindowUsage)
          .mockRejectedValueOnce(new Error("usage refresh unavailable")),
        compactSession: vi.fn().mockResolvedValue({
          status,
          sessionId: "session",
          usageBefore: { ...usage, currentTokens: 112000 },
          usageAfter: usage,
          ...(status === "failed" ? { error: "provider failed" } : {}),
        } satisfies UiCompactSessionResult),
      };
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <CompactOverlayBody client={client} sessionId="session" />,
          );
          await Promise.resolve();
        });
        await act(async () => {
          container.querySelector("button")?.click();
          await Promise.resolve();
        });
        expect(container.textContent).toContain("12%");
        expect(container.textContent).not.toContain("112%");
        expect(container.textContent).not.toContain("usage refresh");
        expect(container.textContent).toContain(
          status === "compacted"
            ? "Compacted"
            : "Compaction failed: provider failed",
        );
      } finally {
        act(() => {
          root.unmount();
        });
      }
    },
  );
});

describe("StructuredCommandOverlay compact", () => {
  it("ignores backdrop clicks while compacting but keeps Esc and Close as cancel-and-close", async () => {
    let signal: AbortSignal | undefined;
    const onClose = vi.fn();
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
      compactSession: (input?: {
        readonly signal?: AbortSignal;
      }): Promise<UiCompactSessionResult> => {
        signal = input?.signal;
        return new Promise<UiCompactSessionResult>(() => undefined);
      },
    } as unknown as Parameters<typeof StructuredCommandOverlay>[0]["client"];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (): void => {
      root.render(
        <StructuredCommandOverlay
          activeGoal={null}
          client={client}
          onClose={onClose}
          onExecuteSlashCommand={vi.fn()}
          overlay={{ commandLabel: "/compact", kind: "compact" }}
          sessionId="session"
        />,
      );
    };
    try {
      await flush(() => {
        render();
      });
      const backdrop = container.querySelector<HTMLElement>(
        ".ohb-structured-overlay",
      );
      const close = (): HTMLButtonElement | null =>
        container.querySelector<HTMLButtonElement>(
          ".ohb-structured-header button",
        );
      expect(close()?.title).toBe("Close overlay");
      await flush(() =>
        container
          .querySelector<HTMLButtonElement>('button[title="Compact session"]')
          ?.click(),
      );
      await flush(() => backdrop?.click());
      expect(onClose).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      expect(close()?.title).toBe("Stop compaction and close");
      await flush(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      await flush(() => close()?.click());
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    // Closing unmounts the body, whose cleanup aborts the request.
    expect(signal?.aborted).toBe(true);
  });

  it("still closes on backdrop click when idle", async () => {
    const onClose = vi.fn();
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
      compactSession: vi.fn(),
    } as unknown as Parameters<typeof StructuredCommandOverlay>[0]["client"];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await flush(() => {
        root.render(
          <StructuredCommandOverlay
            activeGoal={null}
            client={client}
            onClose={onClose}
            onExecuteSlashCommand={vi.fn()}
            overlay={{ commandLabel: "/compact", kind: "compact" }}
            sessionId="session"
          />,
        );
      });
      await flush(() =>
        container
          .querySelector<HTMLElement>(".ohb-structured-overlay")
          ?.click(),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
