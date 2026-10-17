import { TextDecoder } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import type { ExportDocument, ExportMessage, ExportPart } from "../types.js";
import { renderHtml } from "./render.js";

const doms: JSDOM[] = [];
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

function fixture(
  parts: readonly ExportPart[] = [],
  messages?: readonly ExportMessage[],
): ExportDocument {
  return {
    header: {
      type: "session",
      format: "ohbaby.session-export",
      version: 1,
      exportedAt: "2026-10-17T12:00:00.000Z",
      app: { name: "ohbaby", version: "0.1.14" },
      session: {
        id: "session_1_demo",
        title: "中文 🐳 $& $$ $`",
        projectRoot: "/tmp/project",
        agent: "build",
        status: "archived",
        createdAt: "2026-10-16T12:00:00Z",
        updatedAt: "2026-10-17T12:00:00Z",
      },
      stats: {
        messageCount: 1,
        models: ["provider/model"],
        tokens: { input: 100, output: 25, reasoning: 8, total: 125 },
        usageCoverage: { known: 1, unknown: 2 },
      },
    },
    messages: messages ?? [
      {
        type: "message",
        id: "m1",
        role: "assistant",
        time: { created: "2026-10-17T12:00:00Z" },
        parts,
      },
    ],
  };
}
function viewer(document: ExportDocument): Document {
  const errors: Error[] = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error: Error) => errors.push(error));
  const dom = new JSDOM(renderHtml(document), {
    runScripts: "dangerously",
    virtualConsole: console,
    beforeParse(window): void {
      Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
    },
  });
  doms.push(dom);
  expect(errors).toEqual([]);
  return dom.window.document;
}
function element(page: Document, selector: string): Element {
  const selected = page.querySelector(selector);
  if (!selected) throw new Error(`Missing viewer element: ${selector}`);
  return selected;
}
function tool(output: string): Extract<ExportPart, { type: "tool" }> {
  return {
    type: "tool",
    tool: "mcp_image",
    callId: "call1",
    status: "completed",
    input: { query: "literal <tag>" },
    output,
  };
}

describe("standalone session export HTML", () => {
  it("keeps Markdown soft breaks and code indentation without preserving layout whitespace", () => {
    const page = viewer(
      fixture([
        {
          type: "text",
          text: "第一行\n第二行\n\n`two  spaces`\n\n- first\n- second\n\n```ts\n  indented();\n```",
        },
      ]),
    );
    const markdown = element(page, ".markdown");
    expect(page.defaultView?.getComputedStyle(markdown).whiteSpace).toBe(
      "normal",
    );
    expect(markdown.querySelector("p br")).not.toBeNull();
    expect(markdown.querySelectorAll("li")).toHaveLength(2);
    const inlineCode = element(page, "p code");
    expect(inlineCode.textContent).toBe("two  spaces");
    expect(page.defaultView?.getComputedStyle(inlineCode).whiteSpace).toBe(
      "pre-wrap",
    );
    expect(markdown.querySelector("pre code")?.textContent).toBe(
      "  indented();\n",
    );
  });

  it("places a sharing reminder in a semantic footer after the conversation", () => {
    const page = viewer(
      fixture([{ type: "text", text: "Conversation content" }]),
    );
    const footer = element(page, "body > footer");
    expect(footer.textContent.replace(/\s+/g, " ").trim()).toBe(
      "This export may include command output and file contents. Review it before sharing.",
    );
    expect(element(page, "main").nextElementSibling).toBe(footer);
  });

  it("round-trips UTF-8, closing script tags and dollar replacement sequences in its inert payload", () => {
    const document = fixture([
      { type: "text", text: "中文 🚀 $& $$ $` <!-- </script>" },
      {
        type: "reasoning",
        text: "</script><script>window.injected=1</script>",
      },
      tool("</script> $&"),
    ]);
    const page = viewer(document);
    const payload = element(page, "#session-data");
    expect(payload.getAttribute("type")).toBe("application/json");
    expect(
      JSON.parse(Buffer.from(payload.textContent, "base64").toString("utf8")),
    ).toEqual(document);
    expect(page.querySelector("h1")?.textContent).toBe("中文 🐳 $& $$ $`");
    expect(page.querySelector(".markdown")?.textContent).toContain(
      "中文 🚀 $& $$ $` <!-- </script>",
    );
    expect(page.defaultView).not.toHaveProperty("injected");
  });

  it("renders Markdown while treating raw HTML and all other fields as literal text", () => {
    const raw =
      '<script>window.injected=1</script>\n<img src=x onerror="window.injected=2">\n<details>raw</details>\n\n**bold**\n\n  next';
    const document = fixture([
      { type: "text", text: raw },
      { type: "reasoning", text: "<img src=x>\n  preserved" },
      {
        ...tool("<svg onload=alert(1)>"),
        tool: '<img src=x onerror="alert(1)">',
        error: '<iframe src="https://tracker/">',
      },
    ]);
    const page = viewer(document);
    const content = element(page, "main");
    expect(content.querySelector("script,img,iframe,svg")).toBeNull();
    expect(content.querySelector("strong")?.textContent).toBe("bold");
    expect(content.textContent).toContain("<script>window.injected=1</script>");
    expect(content.textContent).toContain(
      '<img src=x onerror="window.injected=2">',
    );
    expect(content.textContent).toContain("<details>raw</details>");
    expect(content.textContent).toContain("<img src=x>\n  preserved");
    expect(page.defaultView).not.toHaveProperty("injected");
  });

  it.each([
    "javascript:alert%281%29",
    "JaVaScRiPt:alert%281%29",
    "jav&#x61;script:alert%281%29",
    "javascript&colon;alert%281%29",
    "java&#9;script:alert%281%29",
    "java&#10;script:alert%281%29",
    "&#32;&#9;JaVaScRiPt:alert%281%29&#32;",
    "data:text/html,alert%281%29",
    "vbscript:msgbox%281%29",
    "file:///etc/passwd",
  ])("rejects dangerous or entity-obfuscated Markdown URL %s", (url) => {
    const page = viewer(fixture([{ type: "text", text: `[unsafe](${url})` }]));
    expect(page.querySelector("main a")).toBeNull();
    expect(page.querySelector("main")?.textContent).toContain("unsafe");
  });

  it("keeps allowed links and escapes attribute tricks without activating HTML entities", () => {
    const page = viewer(
      fixture([
        {
          type: "text",
          text: "[secure](https://example.com/?a=1&b=2) [mail](mailto:a@example.com) [relative](../notes.md) [root](/notes) [fragment](#note) [encoded](https://example.com/?q=&quot;onmouseover=&quot;alert%281%29)",
        },
      ]),
    );
    const links = [...page.querySelectorAll("main a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/?a=1&b=2",
      "mailto:a@example.com",
      "../notes.md",
      "/notes",
      "#note",
      'https://example.com/?q="onmouseover="alert%281%29',
    ]);
    expect(
      links.every((link) => link.getAttribute("rel") === "noopener noreferrer"),
    ).toBe(true);
    expect(page.querySelector("[onmouseover]")).toBeNull();
  });

  it.each([
    ["../my notes.md", "../my%20notes.md"],
    ["../my&#32;notes.md", "../my%20notes.md"],
    [
      "mailto:a@example.com?subject=Hello world",
      "mailto:a@example.com?subject=Hello%20world",
    ],
    [
      "https://example.com/my notes?q=Hello world",
      "https://example.com/my%20notes?q=Hello%20world",
    ],
  ])("preserves interior URL spaces in %s", (url, expected) => {
    const page = viewer(
      fixture([{ type: "text", text: `[allowed](<${url}>)` }]),
    );
    expect(element(page, "main a").getAttribute("href")).toBe(expected);
  });

  it("never turns Markdown body images into automatically loaded resources", () => {
    const page = viewer(
      fixture([
        {
          type: "text",
          text: "![remote](https://tracker/x.png) ![inline](data:image/png;base64,aGVsbG8=) ![html](<data:text/html;base64,aGVsbG8=>)",
        },
      ]),
    );
    expect(page.querySelectorAll("main img")).toHaveLength(0);
    expect(page.querySelector("main")?.textContent).toContain(
      "remote inline html",
    );
  });

  it.each(["png", "jpeg", "gif", "webp"])(
    "displays strict %s data images only in tool output and preserves surrounding whitespace",
    (mime) => {
      const uri = `data:image/${mime};base64,aGVsbG8=`;
      const page = viewer(
        fixture([tool(`before <tag>\n  ![image](${uri})\n  after & more`)]),
      );
      expect(page.querySelector("main img")?.getAttribute("src")).toBe(uri);
      expect(page.querySelector(".tool-output")?.textContent).toBe(
        "before <tag>\n  \n  after & more",
      );
    },
  );

  it.each([
    "data:image/svg+xml;base64,aGVsbG8=",
    "data:text/html;base64,aGVsbG8=",
    "data:image/png;base64,aGVs!G8=",
    "data:image/png;base64,a",
    "data:image/png;base64,aGVsbG8===",
    "data:image/png;base64,aGVsbG8=extra",
    "https://tracker/x.png",
  ])("leaves invalid tool image %s literal", (uri) => {
    const output = `![image](${uri})`;
    const page = viewer(fixture([tool(output)]));
    expect(page.querySelectorAll("main img")).toHaveLength(0);
    expect(page.querySelector(".tool-output")?.textContent).toBe(output);
  });

  it("embeds a real PNG and escapes its alt attribute", () => {
    const uri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZPZsAAAAASUVORK5CYII=";
    const page = viewer(fixture([tool(`![" onload="alert(1)](${uri})`)]));
    const image = element(page, "main img");
    expect(image.getAttribute("src")).toBe(uri);
    expect(image.getAttribute("alt")).toBe('" onload="alert(1)');
    expect(image.hasAttribute("onload")).toBe(false);
  });

  it("preserves initial blank lines in reasoning and tool output", () => {
    const page = viewer(
      fixture([
        { type: "reasoning", text: "\n\n  reasoning\n" },
        tool("\n  output\n"),
      ]),
    );
    expect(element(page, ".reasoning pre").textContent).toBe(
      "\n\n  reasoning\n",
    );
    expect(element(page, ".tool-output").textContent).toBe("\n  output\n");
  });

  it("removes development source-map references from the offline artifact", () => {
    expect(renderHtml(fixture()).includes("sourceMappingURL=")).toBe(false);
  });

  it("restores disclosure state after printing all hidden content", () => {
    const page = viewer(
      fixture([{ type: "reasoning", text: "thinking" }, tool("output")]),
    );
    const reasoning = element(page, ".reasoning") as HTMLDetailsElement;
    const toolDetails = element(page, ".tool") as HTMLDetailsElement;
    const sessionDetails = element(
      page,
      ".session-details",
    ) as HTMLDetailsElement;
    expect(sessionDetails.open).toBe(false);
    expect(sessionDetails.textContent).toContain("/tmp/project");
    reasoning.open = true;
    const window = page.defaultView;
    if (!window) throw new Error("Viewer has no window");
    window.dispatchEvent(new window.Event("beforeprint"));
    expect(toolDetails.open).toBe(true);
    expect(sessionDetails.open).toBe(true);
    window.dispatchEvent(new window.Event("afterprint"));
    expect(reasoning.open).toBe(true);
    expect(toolDetails.open).toBe(false);
    expect(sessionDetails.open).toBe(false);
  });

  it("includes offline CSP and has no inline events or remote resource attributes", () => {
    const page = viewer(
      fixture([
        { type: "text", text: '<img src="https://tracker" onerror=alert(1)>' },
      ]),
    );
    const policy = page
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    for (const directive of [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "base-uri 'none'",
      "form-action 'none'",
    ])
      expect(policy).toContain(directive);
    for (const element of page.querySelectorAll("*"))
      for (const attribute of element.attributes)
        expect(attribute.name).not.toMatch(/^on/i);
    expect(
      page.querySelector("script[src],link[href],iframe,object,embed"),
    ).toBeNull();
  });

  it("shows header stats, incomplete usage coverage, status, errors and compacted content", () => {
    const document = fixture(
      [],
      [
        {
          type: "message",
          id: "m2",
          role: "assistant",
          status: "aborted",
          finish: "interrupted",
          time: { created: "2026-10-17T12:00:00Z" },
          error: { name: "AbortError", message: "Stopped <now>" },
          model: { providerId: "provider", modelId: "model" },
          parts: [
            { type: "text", text: "historical", compacted: true },
            { type: "reasoning", text: "thinking", endReason: "interrupted" },
            { ...tool("working"), status: "running" },
          ],
        },
      ],
    );
    const page = viewer(document);
    const text = page.body.textContent;
    for (const value of [
      "archived",
      "provider/model",
      "100",
      "25",
      "125",
      "Reasoning tokens",
      "8",
      "1 known",
      "2 unknown",
      "aborted",
      "interrupted",
      "AbortError",
      "Stopped <now>",
      "Compacted",
      "historical",
      "running",
    ])
      expect(text).toContain(value);
    const unknown = fixture();
    const withoutUsage = {
      ...unknown,
      header: {
        ...unknown.header,
        stats: {
          messageCount: 1,
          models: [],
          usageCoverage: { known: 0, unknown: 1 },
        },
      },
    };
    expect(viewer(withoutUsage).querySelector("header")?.textContent).toContain(
      "Unknown",
    );
  });

  it("marks running and failed states distinctly while keeping routine completion quiet", () => {
    const page = viewer(
      fixture(
        [],
        [
          {
            type: "message",
            id: "done",
            role: "assistant",
            status: "completed",
            finish: "stop",
            time: {
              created: "2026-10-17T12:00:00.000Z",
              completed: "2026-10-17T12:00:04.000Z",
            },
            parts: [{ ...tool("ok"), input: { command: "ls  -la" } }],
          },
          {
            type: "message",
            id: "live",
            role: "assistant",
            status: "running",
            time: { created: "2026-10-17T12:01:00.000Z" },
            parts: [{ ...tool("partial"), status: "running" }],
          },
          {
            type: "message",
            id: "broken",
            role: "assistant",
            status: "error",
            time: { created: "2026-10-17T12:02:00.000Z" },
            error: { name: "APIError", message: "rate <limited>" },
            parts: [{ ...tool(""), status: "error", error: "boom" }],
          },
        ],
      ),
    );
    const [done, live, broken] = [...page.querySelectorAll("article")];
    expect(done.querySelector(".state")).toBeNull();
    expect(done.querySelector(".tool-hint")?.textContent).toBe("ls -la");
    expect(done.querySelector("pre code")?.textContent).toContain("ls  -la");
    expect(done.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-17T12:00:00.000Z",
    );
    expect(done.textContent).toContain("4.0 s");
    expect(live.classList.contains("is-running")).toBe(true);
    expect(
      [...live.querySelectorAll(".state-active")].map((s) => s.textContent),
    ).toEqual(["running", "running"]);
    expect(broken.classList.contains("has-alert")).toBe(true);
    expect(broken.querySelector(".message-error")?.textContent).toBe(
      "APIErrorrate <limited>",
    );
    expect(broken.querySelectorAll(".state-alert")).toHaveLength(2);
    expect(broken.querySelector("pre.error")?.textContent).toBe("boom");
  });

  it.each([
    [4000, "4.0 s"],
    [9960, "10 s"],
    [59600, "1 m 00 s"],
    [119600, "2 m 00 s"],
    [125000, "2 m 05 s"],
    [3599600, "1 h 00 m"],
    [3629000, "1 h 00 m"],
    [5430000, "1 h 31 m"],
  ])("formats a %i ms duration canonically as %s", (ms, expected) => {
    const created = "2026-10-17T12:00:00.000Z";
    const page = viewer(
      fixture(
        [],
        [
          {
            type: "message",
            id: "timed",
            role: "assistant",
            time: {
              created,
              completed: new Date(Date.parse(created) + ms).toISOString(),
            },
            parts: [{ type: "text", text: "done" }],
          },
        ],
      ),
    );
    expect(element(page, ".meta-duration").textContent).toBe(expected);
  });

  it("reports an unreadable payload instead of failing silently", () => {
    const html = renderHtml(fixture()).replace(
      /(<script id="session-data" type="application\/json">)[\s\S]*?(<\/script>)/,
      "$1 not-base64!! $2",
    );
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window): void {
        Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      },
    });
    doms.push(dom);
    expect(dom.window.document.querySelector("main")?.textContent).toContain(
      "could not be read",
    );
  });

  it("defaults reasoning, tools and compaction summaries to closed and reveals long output after 20 lines", () => {
    const output = Array.from(
      { length: 23 },
      (_, i) => `line ${String(i + 1)}`,
    ).join("\n");
    const message: ExportMessage = {
      type: "message",
      id: "summary",
      role: "system",
      kind: "compaction-summary",
      time: { created: "2026-10-17T12:00:00Z" },
      parts: [{ type: "text", text: "complete summary" }],
    };
    const document = fixture([
      { type: "reasoning", text: "private reasoning" },
      tool(output),
    ]);
    const page = viewer({
      ...document,
      messages: [...document.messages, message],
    });
    const disclosures =
      page.querySelectorAll<HTMLDetailsElement>("main details");
    expect(disclosures).toHaveLength(4);
    expect([...disclosures].every((detail) => !detail.open)).toBe(true);
    const longOutput = element(page, ".tool-output-more") as HTMLDetailsElement;
    expect(longOutput.querySelector("summary")?.textContent).toContain(
      "3 more lines",
    );
    expect(page.querySelector(".tool-output-preview")?.textContent).toBe(
      Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`).join("\n"),
    );
    expect(longOutput.querySelector("pre")?.textContent).toBe(
      "line 21\nline 22\nline 23",
    );
    longOutput.open = true;
    expect(longOutput.open).toBe(true);
    expect(page.querySelector(".compaction-summary")?.textContent).toContain(
      "complete summary",
    );
  });
});
