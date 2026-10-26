import {
  normalizeModelDocument,
  projectModelDocument,
} from "../model-document.js";
import type { ModelJsonConfig } from "ohbaby-llm";
import type { ModelDocument } from "../model-document.js";

/** Existing connection tests inspect the effective LLM projection; migration tests inspect raw disk. */
export function parseProjectedDocument(
  text: string,
): ModelJsonConfig & ModelDocument {
  const document = normalizeModelDocument(JSON.parse(text));
  const projected = projectModelDocument(document);
  if (!projected) throw new Error("Expected a configured model");
  return { ...projected, ...document };
}
