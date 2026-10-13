// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { UiCompactSessionResult, UiContextWindowUsage } from "ohbaby-sdk";
import { CompactOverlayBody } from "./CompactOverlay.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompactOverlayBody", () => {
  it.each(["compacted", "inflated", "failed"] as const)(
    "refreshes usage after a %s result",
    async (status) => {
      const before: UiContextWindowUsage = {
        sessionId: "session",
        modelId: "test",
        currentTokens: 92000,
        contextWindowTokens: 100000,
        contextWindowRatio: 0.92,
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
        usageBefore: { ...usage, currentTokens: 92000 },
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
        expect(container.textContent).toContain("92%");
        expect(container.querySelector('input[type="checkbox"]')).toBeNull();
        await act(async () => {
          container.querySelector("button")?.click();
          await Promise.resolve();
        });
        expect(container.textContent).toContain("12%");
        expect(container.textContent).not.toContain("92%");
        expect(container.querySelector(".ohb-structured-error") !== null).toBe(
          status !== "compacted",
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
            currentTokens: 92000,
            contextWindowTokens: 100000,
            contextWindowRatio: 0.92,
            estimatedAt: "2026-10-13T00:00:00Z",
          } satisfies UiContextWindowUsage)
          .mockRejectedValueOnce(new Error("usage refresh unavailable")),
        compactSession: vi.fn().mockResolvedValue({
          status,
          sessionId: "session",
          usageBefore: { ...usage, currentTokens: 92000 },
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
        expect(container.textContent).not.toContain("92%");
        expect(container.textContent).not.toContain("usage refresh");
        expect(container.textContent).toContain(
          status === "compacted"
            ? "compact compacted"
            : "compact failed: provider failed",
        );
      } finally {
        act(() => {
          root.unmount();
        });
      }
    },
  );
});
