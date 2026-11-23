import DOMPurify from "dompurify";
import type KatexModule from "katex";
import { trackScrollRegion } from "./markdown-scroll-region.js";

/**
 * Turns the formula placeholders the renderer wrote into KaTeX output. KaTeX
 * loads on the first formula; once loaded, enhancing is synchronous, so a
 * layout effect can run it before the reader sees the placeholder. Anything
 * that fails keeps its source text.
 */

type Katex = typeof KatexModule;

/** Longer sources stay as text: the worst case near this size takes ~185ms. */
export const MATH_LIMIT = 5_000;
const CACHE_SIZE = 256;

let katex: Katex | undefined;
let loading: Promise<Katex | undefined> | undefined;

/** Loads KaTeX and its styles once; a failure is final for this page. */
function loadKatex(): Promise<Katex | undefined> {
  loading ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(
    ([module]) => (katex = module.default),
    () => undefined,
  );
  return loading;
}

/**
 * Sanitized HTML by display mode and source; `null` remembers a failure. The
 * streaming tail is rebuilt on every update, so the same formulas come back
 * again and again.
 */
const cache = new Map<string, string | null>();

function renderTex(lib: Katex, tex: string, display: boolean): string | null {
  const key = `${display ? "1" : "0"}${tex}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let html: string | null = null;
  if (tex.length <= MATH_LIMIT) {
    try {
      html = DOMPurify.sanitize(
        lib.renderToString(tex, {
          displayMode: display,
          throwOnError: true,
          // Chinese inside a formula is fine.
          strict: "ignore",
          // No links, images or HTML extensions from model text.
          trust: false,
          errorColor: "currentColor",
          maxSize: 10,
          maxExpand: 1000,
        }),
      );
    } catch {
      // A syntax error or an unsupported command: the source stays.
    }
  }
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, html);
  return html;
}

const isMath = (element: Element, token: string): element is HTMLElement =>
  element instanceof HTMLElement && element.dataset.math === token;

/** Fills one placeholder, or marks it `error` and leaves the source. */
function mount(lib: Katex, element: HTMLElement): void {
  const display = element.dataset.display === "1";
  const html = renderTex(lib, element.dataset.tex ?? "", display);
  if (html === null) {
    element.dataset.mathState = "error";
    return;
  }
  let box: HTMLElement | null = null;
  if (display) {
    box = document.createElement("div");
    box.className = "ohb-math-display";
    box.innerHTML = html;
  }
  const pre = element.querySelector<HTMLElement>(":scope > pre");
  if (element.classList.contains("ohb-code-block") && pre && box) {
    // A math code block keeps its source for Copy, hidden.
    pre.before(box);
    pre.hidden = true;
  } else if (box) element.replaceChildren(box);
  else element.innerHTML = html;
  element.dataset.mathState = "ready";
}

/**
 * Enhances the placeholders under `root` that carry this page's `token` and
 * have not been tried yet. With `trackOverflow`, wide display formulas become
 * focusable regions while they overflow. Never throws; `cancel` drops a late
 * load and stops tracking. `done` settles once this run has finished.
 */
export function enhanceMath(
  root: HTMLElement,
  token: string,
  { trackOverflow = false }: { readonly trackOverflow?: boolean } = {},
): { cancel: () => void; done: Promise<void> } {
  let cancelled = false;
  const disposers: (() => void)[] = [];
  const run = (lib: Katex): void => {
    for (const element of root.querySelectorAll("[data-math]")) {
      if (!isMath(element, token)) continue;
      if (!element.dataset.mathState) mount(lib, element);
      if (!trackOverflow || element.dataset.mathState !== "ready") continue;
      const box = element.querySelector<HTMLElement>(".ohb-math-display");
      if (box) disposers.push(trackScrollRegion(box, "Scrollable formula"));
    }
  };

  let done = Promise.resolve();
  const pending = [...root.querySelectorAll("[data-math]")].some((element) =>
    isMath(element, token),
  );
  // No formula, no download.
  if (pending) {
    if (katex) run(katex);
    else
      done = loadKatex().then((lib) => {
        if (lib && !cancelled) run(lib);
      });
  }
  return {
    cancel: (): void => {
      cancelled = true;
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
    done,
  };
}

/** The rendered formula an endpoint of the selection sits in. */
function formulaAround(node: Node, token: string): HTMLElement | undefined {
  const element = node instanceof Element ? node : node.parentElement;
  let formula = element?.closest("[data-math-state='ready']");
  while (formula && !isMath(formula, token))
    formula = formula.parentElement?.closest("[data-math-state='ready']");
  return formula ?? undefined;
}

/**
 * A copy whose selection inside `root` holds rendered formulas gets each one
 * as `$...$` or `$$...$$` source, in plain text and HTML. An endpoint inside a
 * formula widens the copy to the whole formula; the visible selection stays.
 * Other copies keep the browser's default. Borrowed from deepseek-harness.
 */
export function copyMathAsTex(
  event: ClipboardEvent,
  root: HTMLElement,
  token: string,
): void {
  const selection = document.getSelection();
  if (event.defaultPrevented || !event.clipboardData) return;
  if (selection?.rangeCount !== 1 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0).cloneRange();
  if (!root.contains(range.commonAncestorContainer)) return;
  const start = formulaAround(range.startContainer, token);
  if (start) range.setStartBefore(start);
  const end = formulaAround(range.endContainer, token);
  if (end) range.setEndAfter(end);
  const fragment = range.cloneContents();
  const formulas = [
    ...fragment.querySelectorAll("[data-math-state='ready']"),
  ].filter((element) => isMath(element, token));
  if (formulas.length === 0) return;
  for (const formula of formulas) {
    const tex = formula.dataset.tex ?? "";
    if (formula.dataset.display !== "1") {
      formula.replaceWith(`$${tex}$`);
      continue;
    }
    // A display formula keeps a line of its own, even next to another one.
    const line = document.createElement("p");
    line.textContent = `$$${tex}$$`;
    formula.replaceWith(line);
  }
  // innerText follows the page's own block layout, which needs the Markdown
  // styles: an off-screen child of `root` keeps them while staying unseen.
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:0;left:-100000px;pointer-events:none";
  container.append(fragment);
  root.append(container);
  try {
    // jsdom has no innerText.
    const text = container.innerText as string | undefined;
    event.clipboardData.setData("text/plain", text ?? container.textContent);
    event.clipboardData.setData("text/html", container.innerHTML);
  } finally {
    container.remove();
  }
  event.preventDefault();
}
