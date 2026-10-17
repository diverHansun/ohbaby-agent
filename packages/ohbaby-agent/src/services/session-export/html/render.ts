import { Buffer } from "node:buffer";
import type { ExportDocument } from "../types.js";
import {
  CSS_TEMPLATE,
  HTML_TEMPLATE,
  MARKED_SCRIPT,
  VIEWER_SCRIPT,
} from "./assets.generated.js";

/** Render an offline artifact without reading assets at runtime. */
export function renderHtml(document: ExportDocument): string {
  const assets: Record<string, string> = {
    STYLE: CSS_TEMPLATE,
    DATA: Buffer.from(JSON.stringify(document), "utf8").toString("base64"),
    MARKED: MARKED_SCRIPT,
    VIEWER: VIEWER_SCRIPT,
  };
  // Replace in a single pass: embedded text must never become another placeholder
  // or receive the special $&, $$, $` semantics of string replacements.
  return HTML_TEMPLATE.replace(
    /(?:\/\* )?\{\{(STYLE|DATA|MARKED|VIEWER)\}\}(?: \*\/)?/g,
    (_match, key: string) => assets[key],
  );
}
