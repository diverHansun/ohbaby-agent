import type { Part } from "../message/index.js";

export function isActivePart(part: Part): boolean {
  return part.time?.compacted === undefined;
}
