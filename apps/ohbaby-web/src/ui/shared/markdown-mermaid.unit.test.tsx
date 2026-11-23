// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock } from "./MarkdownBlock.js";
import {
  MERMAID_LIMIT,
  enhanceMermaidBlocks,
  isMermaidLang,
  renderDiagram,
} from "./markdown-mermaid.js";
import { COPY_TOKEN, renderMarkdown } from "./markdown-renderer.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const writeText = vi.fn((_text: string) => Promise.resolve());
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

afterEach(() => {
  writeText.mockClear();
  document.body.innerHTML = "";
});

const FLOW = "flowchart TD\n  A[开始] --> B[Promise<string>]";
const fence = (source: string, lang = "mermaid"): string =>
  `\`\`\`${lang}\n${source}\n\`\`\``;

/** The renderer's HTML for `text`, on the page. */
function holder(text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(text);
  document.body.append(div);
  return div;
}

function mount(node: React.ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

const drawn = (root: ParentNode): number =>
  root.querySelectorAll(".ohb-mermaid-diagram").length;

describe("isMermaidLang", () => {
  it.each(["mermaid", "MMD", 'mermaid title="x"', " Mermaid "])(
    "U-1: recognises %j",
    (lang) => {
      expect(isMermaidLang(lang)).toBe(true);
    },
  );

  it.each(["js", "", undefined, "mermaidx"])("U-2: ignores %j", (lang) => {
    expect(isMermaidLang(lang)).toBe(false);
  });
});

describe("enhanceMermaidBlocks", () => {
  it("U-3: draws a flowchart in front of the hidden code", async () => {
    const root = holder(fence(FLOW));
    await enhanceMermaidBlocks(root, COPY_TOKEN).done;
    const block = root.querySelector<HTMLElement>(".ohb-code-block");
    expect(block?.dataset.mermaidState).toBe("ready");
    const svg = block?.querySelector(".ohb-mermaid-diagram > svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Mermaid diagram");
    expect(block?.querySelector("pre")?.hidden).toBe(true);
    // Copy, then the toggle: Copy still sits right beside its block.
    expect(
      [...(block?.children ?? [])].map((child) => child.className),
    ).toEqual([
      "ohb-code-copy",
      "ohb-mermaid-toggle",
      "ohb-mermaid-diagram",
      "",
    ]);
  });

  it("U-3: ignores other code blocks", async () => {
    const root = holder(fence("const a = 1;", "ts"));
    await enhanceMermaidBlocks(root, COPY_TOKEN).done;
    expect(drawn(root)).toBe(0);
  });

  it("U-4: ignores HTML a message wrote with a look-alike marker", async () => {
    const forged = `<div class="ohb-code-block" data-mermaid="guess"><pre><code>${FLOW}</code></pre></div>`;
    const root = holder(forged);
    expect(root.querySelector("[data-mermaid]")).not.toBeNull();
    await enhanceMermaidBlocks(root, COPY_TOKEN).done;
    expect(drawn(root)).toBe(0);
  });

  it.each([
    ["U-5: a syntax error", "flowchart TD\n  A --> [[[ --> )"],
    ["U-6: an unknown type", "notADiagram\n  A --> B"],
  ])("%s keeps the code", async (_, source) => {
    const root = holder(fence(source));
    await expect(
      enhanceMermaidBlocks(root, COPY_TOKEN).done,
    ).resolves.toBeUndefined();
    expect(drawn(root)).toBe(0);
    expect(root.querySelector("pre")?.hidden).toBe(false);
    expect(
      root.querySelector(".ohb-code-block")?.hasAttribute("data-mermaid-state"),
    ).toBe(false);
  });

  it("U-7: draws at the limit and leaves longer sources as code", async () => {
    const pad = (length: number): string => {
      const head = "flowchart TD\n  A --> B\n%% ";
      return head + "x".repeat(length - head.length);
    };
    expect(pad(MERMAID_LIMIT)).toHaveLength(MERMAID_LIMIT);
    await expect(renderDiagram(pad(MERMAID_LIMIT))).resolves.toContain("<svg");
    await expect(
      renderDiagram(pad(MERMAID_LIMIT + 1)),
    ).resolves.toBeUndefined();
  });

  it("U-8: one bad diagram does not stop a good one", async () => {
    const root = holder(
      `${fence("flowchart TD\n  A --> [[[")}\n\n${fence(FLOW)}`,
    );
    await enhanceMermaidBlocks(root, COPY_TOKEN).done;
    const blocks = root.querySelectorAll<HTMLElement>(".ohb-code-block");
    expect(blocks[0].dataset.mermaidState).toBeUndefined();
    expect(blocks[1].dataset.mermaidState).toBe("ready");
  });

  it("U-14: a cancelled run writes nothing", async () => {
    const root = holder(fence(FLOW));
    const task = enhanceMermaidBlocks(root, COPY_TOKEN);
    task.cancel();
    await task.done;
    expect(drawn(root)).toBe(0);
    expect(root.querySelector("pre")?.hidden).toBe(false);
  });

  it("U-15: the SVG carries no scripts, handlers, images or links", async () => {
    const attacks = [
      'flowchart TD\n  A --> B\n  click A href "javascript:alert(1)"',
      'flowchart TD\n  A --> B\n  click A "https://evil.example/x"',
      'flowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(1)</script>"]',
      "flowchart TD\n  A[\"<a href='javascript:alert(1)'>x</a>\"] --> B",
      '%%{init: {"securityLevel": "loose", "themeCSS": "body{background:url(https://evil.example/x)}"}}%%\nflowchart TD\n  A --> B',
      "flowchart TD\n  A[<image href='https://evil.example/x.png'/>] --> B",
    ];
    for (const source of attacks) {
      const svg = await renderDiagram(source).catch(() => undefined);
      if (!svg) continue;
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const elements = [...doc.querySelectorAll("*")];
      expect(doc.querySelector("script, a, image, img, foreignObject")).toBe(
        null,
      );
      for (const element of elements) {
        for (const name of element.getAttributeNames()) {
          expect(name, source).not.toMatch(/^on/iu);
          expect(element.getAttribute(name), source).not.toMatch(
            /javascript:|evil\.example/iu,
          );
        }
      }
      // Label text may repeat the source; only CSS could load anything.
      for (const style of doc.querySelectorAll("style"))
        expect(style.textContent, source).not.toMatch(/evil\.example/iu);
    }
  });

  it.each([
    ["flowchart", "flowchart LR\n  A[中文标签] --> B[Promise<string>]"],
    [
      "sequence",
      "sequenceDiagram\n  客户端->>服务端: 请求 Promise<string>\n  服务端-->>客户端: 返回",
    ],
    ["class", "classDiagram\n  class 仓库 {\n    +读取() Promise<string>\n  }"],
    ["state", "stateDiagram-v2\n  [*] --> 空闲\n  空闲 --> 运行中"],
    ["er", "erDiagram\n  用户 ||--o{ 订单 : 下单"],
    [
      "gantt",
      "gantt\n  title 计划\n  dateFormat YYYY-MM-DD\n  section 阶段\n  设计 :a1, 2026-11-01, 3d",
    ],
    ["pie", 'pie title 占比\n  "中文" : 60\n  "English" : 40'],
    ["mindmap", "mindmap\n  root((中心))\n    分支一\n    分支二"],
    [
      "journey",
      "journey\n  title 用户旅程\n  section 注册\n    填写表单: 3: 用户",
    ],
    ["gitGraph", "gitGraph\n  commit\n  branch feature\n  commit"],
    ["timeline", "timeline\n  title 时间线\n  2026 : 立项"],
  ])("U-17: draws a %s diagram with its labels", async (_, source) => {
    const svg = await renderDiagram(source);
    expect(svg).toContain("<svg");
    const text = new DOMParser().parseFromString(svg ?? "", "image/svg+xml")
      .documentElement.textContent;
    for (const label of ["中文标签", "Promise<string>", "空闲", "用户", "中心"])
      if (source.includes(label)) expect(text).toContain(label);
  });
});

describe("MarkdownBlock diagrams", () => {
  it("U-9: Copy gives the Mermaid source without a trailing newline", async () => {
    const { container } = mount(<MarkdownBlock text={fence(FLOW)} diagrams />);
    await vi.waitFor(() => {
      expect(drawn(container)).toBe(1);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".ohb-code-copy")?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(FLOW);
  });

  it("U-10: the toggle swaps diagram and code without redrawing", async () => {
    const { container } = mount(<MarkdownBlock text={fence(FLOW)} diagrams />);
    await vi.waitFor(() => {
      expect(drawn(container)).toBe(1);
    });
    const svg = container.querySelector("svg[role='img']");
    const toggle = container.querySelector<HTMLButtonElement>(
      ".ohb-mermaid-toggle",
    );
    const pre = container.querySelector<HTMLElement>(".ohb-code-block > pre");
    const diagram = container.querySelector<HTMLElement>(
      ".ohb-mermaid-diagram",
    );
    expect(toggle?.getAttribute("aria-label")).toBe("Show code");
    toggle?.click();
    expect([pre?.hidden, diagram?.hidden]).toEqual([false, true]);
    expect(toggle?.getAttribute("aria-label")).toBe("Show diagram");
    toggle?.click();
    expect([pre?.hidden, diagram?.hidden]).toEqual([true, false]);
    expect(container.querySelector("svg[role='img']")).toBe(svg);
  });

  it("U-11: StrictMode leaves one diagram and one toggle", async () => {
    const { container } = mount(
      <StrictMode>
        <MarkdownBlock text={fence(FLOW)} diagrams />
      </StrictMode>,
    );
    await vi.waitFor(() => {
      expect(drawn(container)).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drawn(container)).toBe(1);
    expect(container.querySelectorAll(".ohb-mermaid-toggle")).toHaveLength(1);
  });

  it("U-12: re-rendering the same text keeps the diagram and the view", async () => {
    const { container, root } = mount(
      <MarkdownBlock text={fence(FLOW)} diagrams />,
    );
    await vi.waitFor(() => {
      expect(drawn(container)).toBe(1);
    });
    const svg = container.querySelector("svg[role='img']");
    container.querySelector<HTMLButtonElement>(".ohb-mermaid-toggle")?.click();
    act(() => {
      root.render(<MarkdownBlock text={fence(FLOW)} diagrams />);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector("svg[role='img']")).toBe(svg);
    expect(
      container.querySelector<HTMLElement>(".ohb-code-block > pre")?.hidden,
    ).toBe(false);
  });

  it("U-13: quick changes end with only the latest diagram", async () => {
    const { container, root } = mount(
      <MarkdownBlock
        text={fence("flowchart TD\n  A[第一版] --> B")}
        diagrams
      />,
    );
    for (const label of ["第二版", "第三版"])
      act(() => {
        root.render(
          <MarkdownBlock
            text={fence(`flowchart TD\n  A[${label}] --> B`)}
            diagrams
          />,
        );
      });
    await vi.waitFor(() => {
      expect(drawn(container)).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drawn(container)).toBe(1);
    expect(
      container.querySelector(".ohb-mermaid-diagram svg")?.textContent,
    ).toContain("第三版");
  });

  it("U-14: unmounting before the drawing ends writes nothing", async () => {
    const { container, root } = mount(
      <MarkdownBlock text={fence(FLOW)} diagrams />,
    );
    const block = container.querySelector(".ohb-code-block");
    act(() => {
      root.unmount();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(block?.querySelector(".ohb-mermaid-diagram")).toBeNull();
  });

  it("U-16: MarkdownBlock draws nothing by default", async () => {
    const { container } = mount(<MarkdownBlock text={fence(FLOW)} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drawn(container)).toBe(0);
    expect(container.querySelector("pre")?.hidden).toBe(false);
  });
});
