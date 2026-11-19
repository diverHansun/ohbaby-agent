import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export async function readConfirmation(
  input: Readable,
): Promise<string | undefined> {
  const lines = createInterface({ input, terminal: false });
  try {
    for await (const line of lines) {
      return line.trim().toLowerCase();
    }
  } finally {
    lines.close();
  }
  return undefined;
}
