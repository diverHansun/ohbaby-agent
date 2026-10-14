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
