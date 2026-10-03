import { render } from "ink-testing-library";
import type { CoreAPI, UiPromptSubmission } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { Prompt } from "./index.js";
import { LayoutProvider } from "../../layout/context.js";
import { computeLayoutMetrics } from "../../layout/metrics.js";
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));
function fixture(status: "queued" | "retained", text: string) {
  const prompt = {
    promptId: "p",
    text,
    status,
    sessionId: "a",
  } as UiPromptSubmission;
  const lease = {
    prompt,
    editLeaseId: "lease",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const client = {
    acquirePromptEditLease: vi.fn().mockResolvedValue(lease),
    renewPromptEditLease: vi.fn().mockResolvedValue(lease),
    releasePromptEditLease: vi.fn().mockResolvedValue(undefined),
    resubmitRetainedPrompt: vi
      .fn()
      .mockRejectedValue(new Error("response lost")),
    editQueuedPrompt: vi.fn().mockResolvedValue(undefined),
    submitPromptAccepted: vi.fn().mockResolvedValue({ sessionId: "a" }),
  };
  const view = (sessionId = "a") => (
    <LayoutProvider value={computeLayoutMetrics({ columns: 60, rows: 20 })}>
      <Prompt
        activeSessionId={sessionId}
        catalog={null}
        client={client as unknown as CoreAPI}
        disabled={false}
        queuedPrompts={sessionId === "a" ? [prompt] : []}
      />
    </LayoutProvider>
  );
  const app = render(view());
  return { app, client, view };
}
async function enterEdit(app: ReturnType<typeof render>) {
  app.stdin.write("\u001b[1;3A");
  await tick();
  app.stdin.write("\r");
  await tick();
}
describe("queue editor ownership", () => {
  it("restores the complete pre-edit cursor and history on Esc", async () => {
    const { app, client } = fixture("queued", "queued text");
    await tick();
    app.stdin.write("abc");
    await tick();
    app.stdin.write("\u001b[D");
    await tick();
    await enterEdit(app);
    app.stdin.write(" modified");
    await tick();
    app.stdin.write("\u001b");
    await tick();
    app.stdin.write("!");
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(client.submitPromptAccepted).toHaveBeenCalledWith(
      "ab!c",
      expect.anything(),
    );
    app.unmount();
  });
  it("allows frozen retained text to be read with Home/End and arrows without changing its original operation or renewing", async () => {
    const text = `START${"中文👩‍💻".repeat(50)}END`;
    const { app, client } = fixture("retained", text);
    await tick();
    await enterEdit(app);
    app.stdin.write("\r");
    await tick();
    expect(app.lastFrame()).toContain("Enter retry");
    app.stdin.write("\u001b[H");
    await tick();
    expect(app.lastFrame()).toContain("> START");
    app.stdin.write("\u001b[C");
    await tick();
    app.stdin.write("\u001b[D");
    await tick();
    app.stdin.write("change");
    await tick();
    app.stdin.write("\u001b[F");
    await tick();
    expect(app.lastFrame()).toContain("END");
    app.stdin.write("\r");
    await tick();
    expect(client.resubmitRetainedPrompt.mock.calls[1]).toEqual(
      client.resubmitRetainedPrompt.mock.calls[0],
    );
    expect(client.resubmitRetainedPrompt.mock.calls[0]?.[0]).toMatchObject({
      text,
    });
    expect(client.renewPromptEditLease).not.toHaveBeenCalled();
    app.unmount();
  });
});

it.each(["resolve", "reject"] as const)(
  "settles a delayed queue save in its original source after A→B→A: %s",
  async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const { app, client, view } = fixture("queued", "queued text");
    client.editQueuedPrompt.mockReturnValue(pending);
    await tick();
    app.stdin.write("original draft");
    await tick();
    await enterEdit(app);
    app.stdin.write(" modified");
    await tick();
    app.stdin.write("\r");
    await tick();
    app.rerender(view("b"));
    await tick();
    app.stdin.write("B draft");
    await tick();
    app.rerender(view("a"));
    await tick();
    expect(app.lastFrame()).toContain("Updating queued prompt");
    app.stdin.write("\r");
    await tick();
    expect(client.editQueuedPrompt).toHaveBeenCalledTimes(1);
    if (outcome === "resolve") resolve(undefined);
    else reject(new Error("original save failed"));
    await tick();
    if (outcome === "resolve")
      expect(app.lastFrame()).toContain("> original draft");
    else {
      expect(app.lastFrame()).toContain("original save failed");
      expect(app.lastFrame()).toContain("queued text modified");
    }
    app.rerender(view("b"));
    await tick();
    expect(app.lastFrame()).toContain("> B draft");
    expect(app.lastFrame()).not.toContain("original save failed");
    app.unmount();
  },
);
