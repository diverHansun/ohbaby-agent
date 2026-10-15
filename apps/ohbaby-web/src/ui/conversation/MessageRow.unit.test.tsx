// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MessageRow } from "./MessageRow.js";

it("renders the compaction boundary with the muted inline presentation", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      message={{
        id: "compact",
        createdAt: "2026-10-13T00:00:00Z",
        role: "system",
        parts: [
          {
            type: "text",
            text: "Compacted (estimated): 92,000 -> 12,000 tokens",
            metadata: { kind: "context-compaction" },
          },
        ],
      }}
    />,
  );
  expect(html).toContain("ohb-message-compaction");
  expect(html).toContain("Compacted (estimated)");
});

it.each(["live", "saved"] as const)(
  "keeps %s reasoning text keyboard reachable separately from its disclosure",
  (source) => {
    const text = "First line\n  indented detail\n" + "identifier".repeat(40);
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <MessageRow
        message={{
          id: "reasoning",
          createdAt: "2026-10-16T00:00:00Z",
          role: "assistant",
          parts:
            source === "saved"
              ? [{ type: "reasoning", text, endReason: "normal" }]
              : [],
        }}
        reasoning={
          source === "live" ? { content: text, folded: false } : undefined
        }
      />,
    );
    const details = container.querySelector("details");
    const body = details?.querySelector("pre");
    expect(details?.querySelector("summary")?.textContent).toBe("Thought");
    expect(body?.textContent).toBe(text);
    expect(body?.tabIndex).toBe(0);
    expect(body?.getAttribute("aria-label")).toBe("Reasoning content");
    expect(details?.open).toBe(source === "live");
  },
);
