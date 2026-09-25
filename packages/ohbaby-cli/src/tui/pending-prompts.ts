import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PendingTuiPrompt } from "./session-recovery.js";

/** Separate receipt files keep concurrent terminals from deleting each other's submissions. */
export function createPendingPromptStorage(
  workspace = process.cwd(),
  root = join(homedir(), ".ohbaby", "tui", "pending"),
): {
  read(): readonly PendingTuiPrompt[];
  write(pending: readonly PendingTuiPrompt[]): void;
} {
  const directory = join(
    root,
    createHash("sha256").update(workspace).digest("hex"),
  );
  let known = new Set<string>();
  const file = (id: string): string =>
    join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
  return {
    read(): readonly PendingTuiPrompt[] {
      try {
        const pending: PendingTuiPrompt[] = [];
        for (const name of readdirSync(directory).filter((name) =>
          name.endsWith(".json"),
        )) {
          try {
            const item: unknown = JSON.parse(
              readFileSync(join(directory, name), "utf8"),
            );
            if (
              typeof item === "object" &&
              item !== null &&
              "clientRequestId" in item &&
              typeof item.clientRequestId === "string" &&
              (!("sessionId" in item) || typeof item.sessionId === "string") &&
              (!("runtimeEpoch" in item) ||
                typeof item.runtimeEpoch === "string")
            )
              pending.push(item as PendingTuiPrompt);
          } catch {
            /* One damaged receipt must not hide other submissions. */
          }
        }
        known = new Set(pending.map((item) => item.clientRequestId));
        return pending;
      } catch {
        return [];
      }
    },
    write(pending: readonly PendingTuiPrompt[]): void {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const next = new Set(pending.map((item) => item.clientRequestId));
      for (const item of pending) {
        if (known.has(item.clientRequestId)) continue;
        const target = file(item.clientRequestId),
          temporary = `${target}.${String(process.pid)}.tmp`;
        writeFileSync(
          temporary,
          JSON.stringify({
            clientRequestId: item.clientRequestId,
            sessionId: item.sessionId,
            runtimeEpoch: item.runtimeEpoch,
          }),
          { mode: 0o600 },
        );
        renameSync(temporary, target);
      }
      for (const id of known)
        if (!next.has(id)) rmSync(file(id), { force: true });
      known = next;
    },
  };
}
