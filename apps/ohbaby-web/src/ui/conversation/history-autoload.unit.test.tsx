// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage, UiPromptSubmission } from "ohbaby-sdk";
import {
  ConversationStream,
  type ConversationReadingPosition,
} from "./ConversationStream.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no layout: rows stack in DOM order, 100px each, the history slot
 * 20px, and a row with no children (CSS :empty) or `hidden` takes 0px.
 */
const CLIENT_HEIGHT = 300;
function heightOf(node: HTMLElement): number {
  if (node.classList.contains("ohb-history-slot")) return 20;
  return node.hidden || node.childElementCount === 0 ? 0 : 100;
}
function laidOut(stream: HTMLElement): HTMLElement[] {
  return [
    ...stream.querySelectorAll<HTMLElement>(
      ".ohb-history-slot, [data-message-id]",
    ),
  ];
}
function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
let scrollTops = new WeakMap<HTMLElement, number>();
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  scrollTops = new WeakMap();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement): DOMRect {
      if (this.classList.contains("ohb-stream")) return rect(0, CLIENT_HEIGHT);
      const stream = this.closest<HTMLElement>(".ohb-stream");
      if (!stream) return rect(0, 0);
      let y = 0;
      for (const node of laidOut(stream)) {
        if (node === this) return rect(y - stream.scrollTop, heightOf(node));
        y += heightOf(node);
      }
      return rect(0, 0);
    },
  );
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("ohb-stream") ? CLIENT_HEIGHT : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return laidOut(this).reduce((sum, node) => sum + heightOf(node), 0);
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return scrollTops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        scrollTops.set(this, Math.min(max, Math.max(0, value)));
      },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of ["clientHeight", "scrollHeight", "scrollTop"])
    Reflect.deleteProperty(HTMLElement.prototype, key);
  document.body.innerHTML = "";
});

const at = "2026-11-20T00:00:00Z";
function msg(id: string, patch: Partial<UiMessage> = {}): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: at,
    parts: [{ type: "text", text: id }],
    ...patch,
  };
}
const rows = (prefix: string, count: number): UiMessage[] =>
  Array.from({ length: count }, (_, index) => msg(`${prefix}${String(index)}`));
function deferred(): {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
} {
  let resolve!: (value: boolean) => void;
  return {
    promise: new Promise<boolean>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
type Props = React.ComponentProps<typeof ConversationStream>;

function harness(initial: Partial<Props>): {
  stream: () => HTMLElement;
  render: (patch?: Partial<Props>) => void;
  load: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  replies: ReturnType<typeof deferred>[];
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const replies: ReturnType<typeof deferred>[] = [];
  const load = vi.fn(() => {
    const reply = deferred();
    replies.push(reply);
    return reply.promise;
  });
  let props: Props = {
    historyState: "ready",
    historyHasMore: true,
    historyStale: false,
    onLoadHistory: load,
    promptRows: [],
    messages: rows("m", 10),
    sessionId: "session",
    prompts: [],
    activeRun: undefined,
    isRunning: false,
    reasoningByMessageId: {},
    commandNotices: null,
    ...initial,
  };
  const render = (patch: Partial<Props> = {}): void => {
    props = { ...props, ...patch };
    act(() => {
      root.render(<ConversationStream {...props} />);
    });
  };
  render();
  return {
    stream: (): HTMLElement => {
      const stream = container.querySelector<HTMLElement>(".ohb-stream");
      if (!stream) throw new Error("Missing stream");
      return stream;
    },
    render,
    load,
    replies,
  };
}
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function scrollTo(stream: HTMLElement, top: number): void {
  stream.scrollTop = top;
  act(() => {
    stream.dispatchEvent(new Event("scroll"));
  });
}
function wheelUp(stream: HTMLElement): void {
  act(() => {
    stream.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
  });
}
function rowTop(stream: HTMLElement, id: string): number {
  const row = stream.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  if (!row) throw new Error(`Missing row ${id}`);
  return row.getBoundingClientRect().top;
}
const reading = (
  top: number,
  patch: Partial<ConversationReadingPosition> = {},
): ConversationReadingPosition => ({ top, sticky: false, ...patch });

describe("earlier history autoload (improve-1 Stage 2)", () => {
  it("keeps one quiet slot with only a spinner while loading (T7)", () => {
    const h = harness({ readingPosition: reading(2000) });
    const slot = h.stream().querySelector<HTMLElement>(".ohb-history-slot");
    const visibleText = (): string =>
      [...(slot?.childNodes ?? [])]
        .filter(
          (node) =>
            !(node as HTMLElement).classList.contains("ohb-visually-hidden"),
        )
        .map((node) => node.textContent)
        .join("");
    for (const patch of [
      { historyState: "ready" },
      { historyState: "loading" },
      { historyState: "error" },
      { historyState: "ready", historyHasMore: false, historyStale: true },
    ] as const) {
      h.render(patch);
      const current = h.stream().querySelector(".ohb-history-slot");
      expect(current).toBe(slot);
      expect(current?.querySelector("button")).toBeNull();
      expect(visibleText()).toBe("");
      expect(current?.querySelector('[role="status"]')?.textContent).toBe(
        patch.historyState === "loading" ? "Loading earlier messages" : "",
      );
      expect(current?.querySelector(".ohb-spinner") !== null).toBe(
        patch.historyState === "loading",
      );
    }
    expect(h.stream().textContent).not.toMatch(/Earlier history changed/u);
    h.render({ historyStale: false, historyHasMore: false });
    expect(h.stream().querySelector(".ohb-history-slot")).toBeNull();
  });

  it("loads within one screen of the top, once at a time, and not on a sticky mount (T8)", async () => {
    const sticky = harness({});
    await settle(50);
    expect(sticky.load).not.toHaveBeenCalled();
    document.body.innerHTML = "";

    const h = harness({ readingPosition: reading(600) });
    await settle();
    expect(h.load).not.toHaveBeenCalled();
    scrollTo(h.stream(), 400);
    expect(h.load).not.toHaveBeenCalled();
    scrollTo(h.stream(), 300);
    expect(h.load).toHaveBeenCalledTimes(1);
    scrollTo(h.stream(), 200);
    scrollTo(h.stream(), 0);
    wheelUp(h.stream());
    await settle(50);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it.each(["promise first", "render first"] as const)(
    "chains a page only after progress, with %s (T9)",
    async (order) => {
      const h = harness({ readingPosition: reading(0) });
      await settle();
      expect(h.load).toHaveBeenCalledTimes(1);
      const page = { messages: [...rows("old", 1), ...rows("m", 10)] };
      if (order === "promise first") {
        h.replies[0]?.resolve(true);
        await settle();
        h.render(page);
      } else {
        h.render(page);
        h.replies[0]?.resolve(true);
      }
      await settle(50);
      expect(h.load).toHaveBeenCalledTimes(2);
      // No progress: stop, even after time passes and props rerender.
      h.replies[1]?.resolve(false);
      await settle(5000);
      h.render({});
      await settle(50);
      expect(h.load).toHaveBeenCalledTimes(2);
      h.render({ historyHasMore: false });
      scrollTo(h.stream(), 0);
      await settle(50);
      expect(h.load).toHaveBeenCalledTimes(2);
      expect(h.stream().querySelector(".ohb-history-slot")).toBeNull();
    },
  );

  it("tops up a short sticky stream until it fills a screen (T9)", async () => {
    const h = harness({ messages: rows("m", 1) });
    await settle();
    expect(h.load).toHaveBeenCalledTimes(1);
    h.render({ messages: [...rows("a", 1), ...rows("m", 1)] });
    h.replies[0]?.resolve(true);
    await settle(50);
    expect(h.load).toHaveBeenCalledTimes(2);
    h.render({ messages: [...rows("b", 2), ...rows("a", 1), ...rows("m", 1)] });
    h.replies[1]?.resolve(true);
    await settle(50);
    // Now taller than a screen: stays at the bottom and stops.
    expect(h.load).toHaveBeenCalledTimes(2);
    const stream = h.stream();
    expect(stream.scrollTop).toBe(stream.scrollHeight - CLIENT_HEIGHT);
  });

  it("retries a failed page quietly, only on a user scroll after 2 s (T10)", async () => {
    const h = harness({ readingPosition: reading(0) });
    await settle();
    expect(h.load).toHaveBeenCalledTimes(1);
    h.replies[0]?.resolve(false);
    await settle();
    h.render({ historyState: "error" });
    expect(h.stream().querySelector(".ohb-history-slot")?.textContent).toBe("");
    // Inside the cooldown a user gesture waits.
    await settle(1000);
    wheelUp(h.stream());
    act(() => {
      h.stream().dispatchEvent(new Event("scroll"));
    });
    expect(h.load).toHaveBeenCalledTimes(1);
    // Past it, neither a scroll the user did not make nor new messages retry.
    await settle(1500);
    act(() => {
      h.stream().dispatchEvent(new Event("scroll"));
    });
    h.render({ messages: [...rows("m", 10), msg("live")] });
    await settle(50);
    expect(h.load).toHaveBeenCalledTimes(1);
    // Already at scrollTop 0: no scroll event, but the upward wheel retries.
    wheelUp(h.stream());
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("reloads stale history near the top without any notice (T11)", async () => {
    const h = harness({
      readingPosition: reading(0),
      historyHasMore: false,
      historyStale: true,
    });
    await settle();
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.stream().textContent).not.toMatch(/history changed|Refresh/u);
  });

  it("keeps the row from the latest scroll in place after a page lands (T12)", async () => {
    const h = harness({ readingPosition: reading(250) });
    await settle();
    expect(h.load).toHaveBeenCalledTimes(1);
    // The user keeps scrolling while the page is in flight.
    scrollTo(h.stream(), 270);
    const before = rowTop(h.stream(), "m2");
    h.render({ messages: [...rows("old", 3), ...rows("m", 10)] });
    expect(rowTop(h.stream(), "m2")).toBe(before);
    h.replies[0]?.resolve(true);
    await settle(50);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("pins a visible row when the reading row was cleared or is not visible (T12)", async () => {
    const position = reading(0);
    const empty = msg("empty", { parts: [] });
    const h = harness({
      readingPosition: position,
      historyHasMore: false,
      messages: [empty, ...rows("m", 10)],
    });
    // Expanding or folding cleared the row; the stale id names an empty row.
    position.messageId = "empty";
    position.offset = 0;
    h.render({ historyHasMore: true });
    await settle();
    expect(h.load).toHaveBeenCalledTimes(1);
    // The empty row collapses through :empty and is never the anchor.
    expect(position.messageId).toBe("m0");
    const before = rowTop(h.stream(), "m0");
    h.render({ messages: [...rows("old", 2), empty, ...rows("m", 10)] });
    expect(rowTop(h.stream(), "m0")).toBe(before);
  });

  it("stays at the bottom when a page lands while following (T12)", async () => {
    const h = harness({ messages: rows("m", 2) });
    await settle();
    expect(h.load).toHaveBeenCalledTimes(1);
    h.render({ messages: [...rows("old", 5), ...rows("m", 2)] });
    h.replies[0]?.resolve(true);
    await settle(50);
    const stream = h.stream();
    expect(stream.scrollTop).toBe(stream.scrollHeight - CLIENT_HEIGHT);
  });
});

describe("rows with nothing to show (T13)", () => {
  it("renders an empty wrapper unless a turn line hangs on it", () => {
    const failed: UiPromptSubmission = {
      promptId: "p",
      clientRequestId: "c",
      scopeKey: "scope",
      sessionId: "session",
      userMessageId: "user",
      text: "question",
      status: "failed",
      error: {
        code: "x",
        message: "Provider failed",
        source: "provider",
        retryable: false,
      },
      createdAt: at,
      updatedAt: at,
      endedAt: at,
    };
    const h = harness({
      historyHasMore: false,
      messages: [
        msg("user", { role: "user", parts: [] }),
        msg("hidden-tool", { parts: [] }),
      ],
      prompts: [failed],
    });
    const row = (id: string): HTMLElement | null =>
      h.stream().querySelector(`[data-message-id="${id}"]`);
    expect(row("hidden-tool")?.childElementCount).toBe(0);
    expect(row("user")?.querySelector("article")).toBeNull();
    expect(row("user")?.textContent).toContain("Provider failed");
  });
});

describe("Edit before a compaction (T14)", () => {
  const prompt = (id: string): UiPromptSubmission => ({
    promptId: `p-${id}`,
    clientRequestId: `c-${id}`,
    scopeKey: "scope",
    sessionId: "session",
    userMessageId: id,
    text: id,
    status: "succeeded",
    runId: `run-${id}`,
    createdAt: at,
    updatedAt: at,
    endedAt: at,
  });
  const user = (id: string): UiMessage => msg(id, { role: "user" });
  const compaction = msg("compact", {
    role: "system",
    parts: [
      {
        type: "text",
        text: "Compacted",
        metadata: { kind: "context-compaction" },
      },
    ],
  });
  const editIds = (messages: UiMessage[]): (string | undefined)[] => {
    const h = harness({
      historyHasMore: false,
      messages,
      prompts: [prompt("u1"), prompt("u2")],
      edit: { stateHints: [], send: () => Promise.resolve(null) },
    });
    return [
      ...h.stream().querySelectorAll<HTMLElement>('button[aria-label="Edit"]'),
    ].map(
      (button) =>
        button.closest<HTMLElement>("[data-message-id]")?.dataset.messageId,
    );
  };
  it("hides Edit before the last compaction only", () => {
    expect(
      editIds([user("u1"), msg("a1"), compaction, user("u2"), msg("a2")]),
    ).toEqual(["u2"]);
    document.body.innerHTML = "";
    expect(editIds([user("u1"), msg("a1"), user("u2"), msg("a2")])).toEqual([
      "u1",
      "u2",
    ]);
  });
});
