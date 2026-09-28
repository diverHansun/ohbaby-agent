// @vitest-environment jsdom
import { transferableAbortController } from "node:util";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../api/daemon/new-session.test-support.js";
import { createOhbabyWebRuntime } from "../runtime.js";
import { OhbabyWebApp } from "./App.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
    }
    // Keep asynchronous SSE and input updates inside React's act boundary.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw lastError;
}

describe("submission feedback through the real daemon client", () => {
  it.each([
    ["new", "success"],
    ["existing", "success"],
    ["new", "response lost"],
    ["existing", "response lost"],
  ] as const)(
    "%s conversation preserves recovery without alarming during submission (%s)",
    async (sessionKind, outcome) => {
      // Hono uses Node's Request, whose signal must also come from Node.
      vi.stubGlobal(
        "AbortController",
        transferableAbortController().constructor,
      );
      const values = new Map<string, string>();
      const storage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const f = await fixture();
      // The shared daemon fixture disables browser persistence for API tests.
      // This UI integration exercises its actual browser storage contract.
      vi.stubGlobal("localStorage", storage);
      const release = deferred();
      let submissions = 0;
      let receiptAvailable = outcome === "success";
      const runtime = createOhbabyWebRuntime(
        {
          baseUrl: "http://127.0.0.1:4096",
          clientId: "submission-feedback",
          directory: f.workdir,
          startupIntent: { startupSessionMode: { type: "fresh" } },
          token: "fixture-token",
        },
        {
          fetch: async (input, init = {}) => {
            const url = new URL(
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
            );
            const isSubmission =
              url.pathname === "/v1/prompts" && init.method === "POST";
            if (isSubmission) {
              submissions += 1;
              await release.promise;
            }
            if (url.pathname === "/v1/prompts/receipt" && !receiptAvailable) {
              throw new TypeError("Failed to fetch");
            }
            const response = await f.server.app.request(
              `${url.pathname}${url.search}`,
              {
                body: init.body,
                headers: init.headers,
                method: init.method,
                signal: init.signal,
              },
            );
            if (isSubmission && outcome === "response lost") {
              // The daemon accepted the POST, but the browser lost its reply.
              throw new TypeError("Failed to fetch");
            }
            return response;
          },
        },
      );
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await runtime.ready;
        if (sessionKind === "existing") {
          await runtime.createSession();
          const sessionId = await runtime.client?.getSelectedSessionId();
          if (!sessionId) throw new Error("Expected an existing session");
          await f.backend.submitPromptAndWait("earlier conversation", {
            sessionId,
          });
          await vi.waitFor(() => {
            expect(runtime.store.getSnapshot().sessionSync.status).toBe(
              "ready",
            );
          });
        }
        await act(async () => {
          root.render(<OhbabyWebApp runtime={runtime} />);
          await Promise.resolve();
        });
        const textarea = container.querySelector("textarea");
        if (!textarea) throw new Error("Expected a composer");
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        );
        await act(async () => {
          // eslint-disable-next-line @typescript-eslint/unbound-method -- Use the native setter so React observes a controlled input edit.
          const setValue = descriptor?.set;
          if (!setValue) throw new Error("Expected textarea value setter");
          Reflect.apply(setValue, textarea, ["new submission"]);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          await Promise.resolve();
        });
        await act(async () => {
          textarea.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
          );
          await Promise.resolve();
        });

        expect(submissions).toBe(1);
        const request = runtime.store.getSnapshot().unknownPromptRequests[0];
        expect(request).toMatchObject({ status: "unknown", submitting: true });
        const storageKey = `ohbaby.web.unknown-prompts.v1:${encodeURIComponent(f.workdir)}:${encodeURIComponent(request.clientRequestId)}`;
        expect(storage.getItem(storageKey)).not.toBeNull();
        expect(container.textContent).toContain("new submission");
        expect(
          container
            .querySelector(".ohb-send-button")
            ?.getAttribute("aria-busy"),
        ).toBe("true");
        expect(container.querySelector(".ohb-thinking")).toBeNull();
        expect
          .soft(container.textContent)
          .not.toContain("Submission result is unknown");
        expect
          .soft(container.querySelector(".ohb-message-pending-label"))
          .toBeNull();

        await act(async () => {
          release.resolve();
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(
            runtime.store
              .getSnapshot()
              .unknownPromptRequests.some((pending) => pending.submitting),
          ).toBe(false);
          expect(
            container
              .querySelector(".ohb-send-button")
              ?.getAttribute("aria-busy"),
          ).not.toBe("true");
        });
        if (outcome === "success") {
          expect(runtime.store.getSnapshot().unknownPromptRequests).toEqual([]);
          expect(storage.getItem(storageKey)).toBeNull();
          expect(container.textContent).not.toContain(
            "Submission result is unknown",
          );
        } else {
          expect(
            runtime.store.getSnapshot().unknownPromptRequests,
          ).toMatchObject([
            { clientRequestId: request.clientRequestId, submitting: false },
          ]);
          expect(storage.getItem(storageKey)).not.toBeNull();
          expect(container.textContent).toContain(
            "Submission result is unknown",
          );
          const check = [...container.querySelectorAll("button")].find(
            (button) => button.textContent === "Check submission",
          );
          expect(check).toBeDefined();
          receiptAvailable = true;
          await act(async () => {
            check?.click();
            await Promise.resolve();
          });
          await waitFor(() => {
            expect(runtime.store.getSnapshot().unknownPromptRequests).toEqual(
              [],
            );
          });
          expect(storage.getItem(storageKey)).toBeNull();
          expect(container.textContent).not.toContain(
            "Submission result is unknown",
          );
        }
        expect(submissions).toBe(1);
      } finally {
        release.resolve();
        await act(async () => {
          root.unmount();
          await runtime.dispose();
          await f.dispose();
        });
        container.remove();
      }
    },
  );
});
