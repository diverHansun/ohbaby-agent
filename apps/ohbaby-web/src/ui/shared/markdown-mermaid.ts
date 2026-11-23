import DOMPurify from "dompurify";
import { trackScrollRegion } from "./markdown-scroll-region.js";

/**
 * Mermaid code blocks in finished answers turn into diagrams by progressive
 * enhancement: the block renders as code first, and only a diagram that
 * draws and sanitizes cleanly is put in front of it. The source `<pre>` stays
 * in the DOM, hidden, so Copy and the code view keep working unchanged.
 *
 * This file must not import the Markdown renderer: the renderer imports
 * `isMermaidLang` from here, and Pele only loads inside `renderDiagram`.
 */

/** Longer sources stay as code; Pele draws 20,000 characters in under 90ms. */
export const MERMAID_LIMIT = 20_000;

/** The first word of a code fence's info string is `mermaid` or `mmd`. */
export function isMermaidLang(lang: string | undefined): boolean {
  const word = lang?.trim().split(/\s/u, 1)[0]?.toLowerCase();
  return word === "mermaid" || word === "mmd";
}

let sequence = 0;

/**
 * The diagram for `source` as sanitized SVG, or undefined when it is too long
 * or not a diagram type Pele knows. Rejects on a syntax error or when Pele
 * fails to load.
 */
export async function renderDiagram(
  source: string,
): Promise<string | undefined> {
  if (source.length > MERMAID_LIMIT) return undefined;
  const pele = await import("pele/lazy");
  if (!pele.detectType(source)) return undefined;
  const result = await pele.renderAsync(source, {
    idPrefix: `ohb-mermaid-${String(sequence++)}-`,
    // Pele sizes boxes from measured label widths: measure the font CSS uses.
    fontFamily: getComputedStyle(document.documentElement)
      .getPropertyValue("--font-ui")
      .trim(),
    fontSize: 14,
    responsive: false,
    links: false,
    images: false,
  });
  // Pele's output is untrusted too: a second line of defence.
  return DOMPurify.sanitize(result.svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}

/** Lucide `workflow` and `code-xml`, the icon set the rest of the UI uses. */
const ICON_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const DIAGRAM_ICON = `<svg ${ICON_ATTRS}><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>`;
const CODE_ICON = `<svg ${ICON_ATTRS}><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>`;

function setView(
  toggle: HTMLButtonElement,
  diagram: HTMLElement,
  pre: HTMLElement,
  showCode: boolean,
): void {
  diagram.hidden = showCode;
  pre.hidden = !showCode;
  toggle.setAttribute("aria-label", showCode ? "Show diagram" : "Show code");
  toggle.innerHTML = showCode ? DIAGRAM_ICON : CODE_ICON;
}

/** Puts the diagram in front of the hidden code and wires the toggle. */
function mount(block: HTMLElement, pre: HTMLElement, svg: string): () => void {
  const diagram = document.createElement("div");
  diagram.className = "ohb-mermaid-diagram";
  diagram.innerHTML = svg;
  // Sanitizing drops the root's role; the label names it for screen readers.
  const root = diagram.querySelector(":scope > svg");
  root?.setAttribute("role", "img");
  root?.setAttribute("aria-label", "Mermaid diagram");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ohb-mermaid-toggle";
  toggle.addEventListener("click", () => {
    // Hidden code means the diagram is showing: switch to the code.
    setView(toggle, diagram, pre, pre.hidden);
  });
  setView(toggle, diagram, pre, false);

  // A new sibling, so Copy still finds its `<pre>` next to it.
  block.querySelector(":scope > .ohb-code-copy")?.after(toggle);
  pre.before(diagram);
  block.dataset.mermaidState = "ready";
  return trackScrollRegion(diagram, "Scrollable Mermaid diagram");
}

/**
 * Draws the genuine Mermaid blocks under `root` one by one, in document
 * order. Only blocks carrying this page's `token` count, so HTML a model
 * wrote with a look-alike marker is ignored. `done` settles once every block
 * was tried and never rejects; `cancel` drops late results and stops
 * following the diagrams' widths.
 */
export function enhanceMermaidBlocks(
  root: HTMLElement,
  token: string,
): { cancel: () => void; done: Promise<void> } {
  let cancelled = false;
  // A call, so type narrowing does not assume nothing changed across `await`.
  const isCancelled = (): boolean => cancelled;
  const disposers: (() => void)[] = [];
  const blocks = [
    ...root.querySelectorAll<HTMLElement>(".ohb-code-block[data-mermaid]"),
  ].filter(
    (block) => block.dataset.mermaid === token && !block.dataset.mermaidState,
  );

  const done = (async (): Promise<void> => {
    for (const block of blocks) {
      if (isCancelled()) return;
      const pre = block.querySelector<HTMLElement>(":scope > pre");
      if (!pre) continue;
      let svg: string | undefined;
      try {
        svg = await renderDiagram(pre.textContent.replace(/\n$/u, ""));
      } catch {
        // A syntax error or a failed load: the code stays as it is.
        continue;
      }
      // A newer run may have drawn this block, or React replaced it.
      if (isCancelled()) return;
      if (!svg || block.dataset.mermaidState || !root.contains(block)) continue;
      disposers.push(mount(block, pre, svg));
    }
  })();

  return {
    cancel: (): void => {
      cancelled = true;
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
    done,
  };
}
