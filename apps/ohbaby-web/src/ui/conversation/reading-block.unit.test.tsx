// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "ohbaby-sdk";
import {
  ConversationStream,
  type ConversationReadingPosition,
} from "./ConversationStream.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no layout. Rows stack in DOM order; a row is as tall as its
 * top-level Markdown blocks, 50px each unless `heights` says otherwise.
 */
const CLIENT_HEIGHT = 300;
const heights = new Map<string, number>();
const blocksOf = (row: HTMLElement): HTMLElement[] => [
  ...row.querySelectorAll<HTMLElement>(".ohb-markdown > *"),
];
const blockHeight = (row: HTMLElement, index: number): number =>
  heights.get(`${row.dataset.messageId ?? ""}:${String(index)}`) ?? 50;
function rowHeight(row: HTMLElement): number {
  if (row.hidden) return 0;
  const blocks = blocksOf(row);
  return blocks.reduce((sum, _, index) => sum + blockHeight(row, index), 0);
}
const rowsOf = (stream: HTMLElement): HTMLElement[] => [
  ...stream.querySelectorAll<HTMLElement>("[data-message-id]"),
];
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
  heights.clear();
  scrollTops = new WeakMap();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement): DOMRect {
      if (this.classList.contains("ohb-stream")) return rect(0, CLIENT_HEIGHT);
      const stream = this.closest<HTMLElement>(".ohb-stream");
      if (!stream) return rect(0, 0);
      let y = -stream.scrollTop;
      for (const row of rowsOf(stream)) {
        if (row === this) return rect(y, rowHeight(row));
        const blocks = blocksOf(row);
        let blockTop = y;
        for (const [index, block] of blocks.entries()) {
          const height = blockHeight(row, index);
          if (block === this) return rect(blockTop, height);
          blockTop += height;
        }
        y += rowHeight(row);
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
        return rowsOf(this).reduce((sum, row) => sum + rowHeight(row), 0);
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
  vi.restoreAllMocks();
  for (const key of ["clientHeight", "scrollHeight", "scrollTop"])
    Reflect.deleteProperty(HTMLElement.prototype, key);
  document.body.innerHTML = "";
});

const paragraphs = (count: number): string =>
  Array.from({ length: count }, (_, i) => `段落 ${String(i)}`).join("\n\n");
const answer = (text: string, status: UiMessage["status"]): UiMessage => ({
  id: "a",
  role: "assistant",
  createdAt: "2026-11-23T00:00:00Z",
  status,
  parts: [{ type: "text", text }],
});
const intro: UiMessage = {
  id: "intro",
  role: "assistant",
  createdAt: "2026-11-23T00:00:00Z",
  status: "completed",
  parts: [{ type: "text", text: paragraphs(4) }],
};

type Props = React.ComponentProps<typeof ConversationStream>;
function harness(initial: Partial<Props>): {
  stream: HTMLElement;
  render: (patch?: Partial<Props>) => void;
  block: (index: number) => HTMLElement;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let props: Props = {
    historyState: "ready",
    historyHasMore: false,
    historyStale: false,
    onLoadHistory: () => Promise.resolve(false),
    promptRows: [],
    messages: [],
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
  const stream = container.querySelector<HTMLElement>(".ohb-stream");
  if (!stream) throw new Error("Missing stream");
  const block = (index: number): HTMLElement => {
    const row = stream.querySelector<HTMLElement>('[data-message-id="a"]');
    const found = row ? blocksOf(row)[index] : undefined;
    if (!found) throw new Error(`Missing block ${String(index)}`);
    return found;
  };
  return { stream, render, block };
}

function readAt(stream: HTMLElement, top: number): void {
  stream.scrollTop = top;
  act(() => {
    stream.dispatchEvent(new Event("scroll"));
  });
}

describe("block-level reading position (streaming Stage 4)", () => {
  it("keeps settled Markdown nodes while the active daemon message has no status", () => {
    const initial = answer(paragraphs(8), undefined);
    const message = { ...initial, runId: "run" };
    const h = harness({
      messages: [message],
      activeRun: {
        id: "run",
        sessionId: "session",
        startedAt: initial.createdAt,
        updatedAt: initial.createdAt,
        status: { kind: "running", runId: "run" },
      },
      isRunning: true,
    });
    const settledBlock = h.block(0);
    h.render({
      messages: [{ ...answer(paragraphs(10), undefined), runId: "run" }],
    });
    expect(h.block(0)).toBe(settledBlock);
    expect(h.block(9).textContent).toBe("段落 9");
  });

  it("B-9: keeps the block being read still when a block above grows or shrinks", () => {
    const readingPosition: ConversationReadingPosition = {
      top: 0,
      sticky: false,
    };
    const h = harness({
      messages: [intro, answer(paragraphs(20), "streaming")],
      readingPosition,
    });
    // intro is 200px; block 6 of the answer starts at 500px.
    readAt(h.stream, 520);
    expect(readingPosition).toMatchObject({
      messageId: "a",
      blockIndex: 6,
      blockOffset: -20,
    });
    const before = h.block(6).getBoundingClientRect().top;

    for (const height of [250, 10]) {
      heights.set("a:1", height);
      h.render({
        messages: [intro, answer(`${paragraphs(20)}\n\n更多`, "streaming")],
      });
      expect(h.block(6).getBoundingClientRect().top).toBe(before);
      h.render({ messages: [intro, answer(paragraphs(20), "completed")] });
      expect(h.block(6).getBoundingClientRect().top).toBe(before);
    }
  });

  it("B-10: falls back to the row when the block is gone", () => {
    const readingPosition: ConversationReadingPosition = {
      top: 0,
      sticky: false,
      messageId: "a",
      offset: -100,
      blockIndex: 40,
      blockOffset: -10,
    };
    const h = harness({
      messages: [intro, answer(paragraphs(20), "completed")],
      readingPosition,
    });
    h.render({ messages: [intro, answer(paragraphs(18), "completed")] });
    const row = h.stream.querySelector<HTMLElement>('[data-message-id="a"]');
    expect(row?.getBoundingClientRect().top).toBe(-100);
  });

  it("records no block while the row's top is still in view", () => {
    const readingPosition: ConversationReadingPosition = {
      top: 0,
      sticky: false,
    };
    const h = harness({
      messages: [intro, answer(paragraphs(20), "completed")],
      readingPosition,
    });
    readAt(h.stream, 150);
    expect(readingPosition.messageId).toBe("intro");
    expect(readingPosition.blockIndex).toBe(3);
    readAt(h.stream, 0);
    expect(readingPosition.messageId).toBe("intro");
    expect(readingPosition.blockIndex).toBeUndefined();
  });

  it("clears the block when a delegation anchor sets the row", () => {
    const readingPosition: ConversationReadingPosition = {
      top: 0,
      sticky: false,
    };
    const h = harness({
      messages: [intro, answer(paragraphs(20), "completed")],
      readingPosition,
    });
    readAt(h.stream, 520);
    expect(readingPosition.blockIndex).toBe(6);
    h.render({ anchorMessageId: "intro", anchorToken: "1" });
    expect(readingPosition.messageId).toBe("intro");
    expect(readingPosition.blockIndex).toBeUndefined();
    expect(readingPosition.blockOffset).toBeUndefined();
  });
});
