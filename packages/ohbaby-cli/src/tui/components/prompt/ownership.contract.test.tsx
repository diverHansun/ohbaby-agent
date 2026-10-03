import { render } from "ink-testing-library";
import type { CoreAPI, UiCurrentModelConfig } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { Prompt, type PromptProps } from "./index.js";
import { LayoutProvider } from "../../layout/context.js";
import { computeLayoutMetrics } from "../../layout/metrics.js";
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const layout = computeLayoutMetrics({ columns: 60, rows: 20 });
const model = { provider: "p", model: "m" } as UiCurrentModelConfig;
function view(props: Partial<PromptProps>, client: CoreAPI) {
  return (
    <LayoutProvider value={layout}>
      <Prompt
        activeSessionId="a"
        disabled={false}
        catalog={null}
        client={client}
        {...props}
      />
    </LayoutProvider>
  );
}

describe("prompt submission ownership", () => {
  it("cancels prepare after switching context and preserves old history without overwriting the new draft", async () => {
    const pending = deferred<UiCurrentModelConfig>();
    const submit = vi.fn().mockResolvedValue({ sessionId: "a" });
    const client = {
      getCurrentModel: () => pending.promise,
      submitPromptAccepted: submit,
    } as unknown as CoreAPI;
    const props = {
      activeSessionId: null,
      submissionContextGeneration: 1,
      pendingReasoning: { model, reasoning: { enabled: true } },
    };
    const app = render(view(props, client));
    await tick();
    app.stdin.write("original 👩‍💻");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.rerender(
      view({ activeSessionId: "b", submissionContextGeneration: 2 }, client),
    );
    await tick();
    app.stdin.write("new draft");
    await tick();
    pending.resolve(model);
    await tick();
    expect(submit).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("new draft");
    app.unmount();
  });
  it("keeps a new draft when an old explicit rejection arrives, with original text recoverable through history", async () => {
    const pending = deferred<never>();
    const submit = vi.fn(() => pending.promise);
    const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
    const app = render(view({}, client));
    await tick();
    app.stdin.write("first");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.stdin.write("second");
    await tick();
    pending.reject({ code: "QUEUE_FULL", message: "Queue full" });
    await tick();
    expect(app.lastFrame()).toContain("second");
    expect(app.lastFrame()).toContain("↑ recover");
    app.stdin.write("\u001b[A");
    await tick();
    expect(app.lastFrame()).toContain("> first");
    app.stdin.write("\u001b[B");
    await tick();
    expect(app.lastFrame()).toContain("> second");
    app.unmount();
  });
  it("does not describe an ordinary unknown receipt as an unsent recoverable intent", async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Submission outcome unknown; query the original receipt. Do not resend.",
        ),
      );
    const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
    const app = render(view({ submitPrompt: submit }, client));
    await tick();
    app.stdin.write("original");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Do not resend");
    expect(app.lastFrame()).not.toContain("Not sent or receipt unavailable");
    app.unmount();
  });
  it("treats bracketed paste of a lone newline as text, and normal Return as submission", async () => {
    const submit = vi.fn().mockResolvedValue({ sessionId: "a" });
    const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
    const app = render(view({}, client));
    await tick();
    app.stdin.write("a");
    await tick();
    app.stdin.write("\u001b[200~\r\u001b[201~");
    await tick();
    app.stdin.write("b");
    await tick();
    expect(submit).not.toHaveBeenCalled();
    app.stdin.write("\r");
    await tick();
    expect(submit).toHaveBeenCalledWith("a\nb", expect.anything());
    app.unmount();
  });
});

describe("new creation generation", () => {
  it("starts a new blank null context, cancels previous prepare, and keeps earlier unbound input recoverable", async () => {
    const pending = deferred<UiCurrentModelConfig>();
    const submit = vi.fn().mockResolvedValue({ sessionId: "created" });
    const client = {
      getCurrentModel: () => pending.promise,
      submitPromptAccepted: submit,
    } as unknown as CoreAPI;
    const app = render(
      view(
        {
          activeSessionId: null,
          submissionContextGeneration: 1,
          pendingReasoning: { model, reasoning: { enabled: true } },
        },
        client,
      ),
    );
    await tick();
    app.stdin.write("old unsent");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.stdin.write("old draft");
    await tick();
    app.rerender(
      view({ activeSessionId: null, submissionContextGeneration: 2 }, client),
    );
    await tick();
    expect(app.lastFrame()).not.toContain("old draft");
    app.stdin.write("fresh draft");
    await tick();
    pending.resolve(model);
    await tick();
    expect(submit).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("Earlier new-session input not sent");
    expect(app.lastFrame()).toContain("fresh draft");
    app.stdin.write("\u001b[A");
    await tick();
    expect(app.lastFrame()).toContain("> old unsent");
    app.stdin.write("\u001b[B");
    await tick();
    expect(app.lastFrame()).toContain("> fresh draft");
    app.unmount();
  });
});

it("retains earlier failed records after returning to a session and adding another failure", async () => {
  const submit = vi
    .fn()
    .mockRejectedValue({ code: "QUEUE_FULL", message: "Queue full" });
  const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
  const app = render(view({ submissionContextGeneration: 1 }, client));
  await tick();
  app.stdin.write("first failed");
  await tick();
  app.stdin.write("\r");
  await tick();
  app.rerender(
    view({ activeSessionId: "b", submissionContextGeneration: 2 }, client),
  );
  await tick();
  app.rerender(
    view({ activeSessionId: "a", submissionContextGeneration: 3 }, client),
  );
  await tick();
  app.stdin.write("second failed");
  await tick();
  app.stdin.write("\r");
  await tick();
  expect(app.lastFrame()).toContain("2 unsent");
  app.stdin.write("new draft");
  await tick();
  app.stdin.write("\u001b[A");
  await tick();
  expect(app.lastFrame()).toContain("> second failed");
  app.stdin.write("\u001b[A");
  await tick();
  expect(app.lastFrame()).toContain("> first failed");
  app.stdin.write("\u001b[B");
  await tick();
  app.stdin.write("\u001b[B");
  await tick();
  expect(app.lastFrame()).toContain("> new draft");
  app.unmount();
});

it("keeps split regional indicators at the original insertion anchor before an existing flag", async () => {
  const submit = vi.fn().mockResolvedValue({ sessionId: "a" });
  const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
  const app = render(view({}, client));
  await tick();
  app.stdin.write("🇺🇸");
  await tick();
  app.stdin.write("\u001b[H");
  await tick();
  app.stdin.write("🇹");
  await tick();
  app.stdin.write("🇼");
  await tick();
  app.stdin.write("\r");
  await tick();
  expect(submit).toHaveBeenCalledWith("🇹🇼🇺🇸", expect.anything());
  app.unmount();
});
