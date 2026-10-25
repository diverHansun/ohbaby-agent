// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { UiContextWindowUsage } from "ohbaby-sdk";
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

const highUsage: UiContextWindowUsage = {
  sessionId: "session",
  modelId: "test",
  currentTokens: 112000,
  contextWindowTokens: 100000,
  contextWindowRatio: 1.12,
  estimatedAt: "2026-10-13T00:00:00Z",
};

describe("CompactOverlayBody", () => {
  it("shows current usage as a local estimate with a warm meter near the limit", async () => {
    const client = {
      getContextWindowUsage: vi.fn().mockResolvedValue(highUsage),
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await flush(() => {
        root.render(
          <CompactOverlayBody
            client={client}
            compacting={false}
            onCompact={vi.fn()}
            sessionId="session"
          />,
        );
      });
      expect(container.textContent).toContain(
        "Token counts are local estimates.",
      );
      expect(container.textContent).toContain("112%");
      // At or above the 90% auto-compaction line the meter turns warm.
      const meter = container.querySelector<HTMLElement>(
        ".ohb-compact-usage i",
      );
      expect(meter?.className).toBe("is-high");
      expect(meter?.style.width).toBe("100%");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("hands the session to onCompact and disables itself while compacting", async () => {
    const onCompact = vi.fn();
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (compacting: boolean): void => {
      root.render(
        <CompactOverlayBody
          client={client}
          compacting={compacting}
          onCompact={onCompact}
          sessionId="session"
        />,
      );
    };
    try {
      await flush(() => {
        render(false);
      });
      await flush(() =>
        container
          .querySelector<HTMLButtonElement>('button[title="Compact session"]')
          ?.click(),
      );
      expect(onCompact).toHaveBeenCalledWith("session");
      await flush(() => {
        render(true);
      });
      const button = container.querySelector<HTMLButtonElement>(
        'button[title="Compact session"]',
      );
      expect(button?.disabled).toBe(true);
      expect(button?.textContent).toBe("Compacting…");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe("StructuredCommandOverlay compact", () => {
  it("closes itself once compaction starts", async () => {
    const onClose = vi.fn();
    const onCompact = vi.fn();
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
    } as unknown as Parameters<typeof StructuredCommandOverlay>[0]["client"];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await flush(() => {
        root.render(
          <StructuredCommandOverlay
            activeGoal={null}
            client={client}
            compacting={false}
            onClose={onClose}
            onCompact={onCompact}
            onExecuteSlashCommand={vi.fn()}
            overlay={{ commandLabel: "/compact", kind: "compact" }}
            sessionId="session"
          />,
        );
      });
      await flush(() =>
        container
          .querySelector<HTMLButtonElement>('button[title="Compact session"]')
          ?.click(),
      );
      expect(onCompact).toHaveBeenCalledWith("session");
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("focuses Compact session on open, or Close when there is no session", async () => {
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
    } as unknown as Parameters<typeof StructuredCommandOverlay>[0]["client"];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (sessionId: string | undefined): void => {
      root.render(
        <StructuredCommandOverlay
          activeGoal={null}
          client={client}
          compacting={false}
          key={sessionId ?? "none"}
          onClose={vi.fn()}
          onCompact={vi.fn()}
          onExecuteSlashCommand={vi.fn()}
          overlay={{ commandLabel: "/compact", kind: "compact" }}
          sessionId={sessionId}
        />,
      );
    };
    try {
      await flush(() => {
        render("session");
      });
      expect(document.activeElement?.getAttribute("title")).toBe(
        "Compact session",
      );
      await flush(() => {
        render(undefined);
      });
      expect(document.activeElement?.getAttribute("title")).toBe("Close");
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("closes on backdrop click", async () => {
    const onClose = vi.fn();
    const client = {
      getContextWindowUsage: (): Promise<null> => Promise.resolve(null),
    } as unknown as Parameters<typeof StructuredCommandOverlay>[0]["client"];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await flush(() => {
        root.render(
          <StructuredCommandOverlay
            activeGoal={null}
            client={client}
            compacting={false}
            onClose={onClose}
            onCompact={vi.fn()}
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
