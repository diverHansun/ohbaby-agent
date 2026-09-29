import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPendingPromptStorage } from "./pending-prompts.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("TUI pending receipt storage", () => {
  it("recovers original identities without prompt content and isolates workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "tui-receipts-"));
    directories.push(root);
    const store = createPendingPromptStorage("workspace-a", root);
    store.write([
      {
        clientRequestId: "original-id",
        runtimeEpoch: "original-epoch",
        ...{ text: "must not be persisted" },
      },
    ]);
    expect(createPendingPromptStorage("workspace-a", root).read()).toEqual([
      { clientRequestId: "original-id", runtimeEpoch: "original-epoch" },
    ]);
    expect(createPendingPromptStorage("workspace-b", root).read()).toEqual([]);
    const directory = join(root, readdirSync(root)[0]);
    expect(
      readFileSync(join(directory, readdirSync(directory)[0]), "utf8"),
    ).not.toContain("must not be persisted");
  });
  it("does not erase a concurrent terminal's pending receipt when its own is acknowledged", () => {
    const root = mkdtempSync(join(tmpdir(), "tui-receipts-"));
    directories.push(root);
    const a = createPendingPromptStorage("workspace", root),
      b = createPendingPromptStorage("workspace", root);
    a.read();
    b.read();
    a.write([{ clientRequestId: "a" }]);
    b.write([{ clientRequestId: "b" }]);
    a.write([]);
    expect(createPendingPromptStorage("workspace", root).read()).toEqual([
      { clientRequestId: "b" },
    ]);
  });
});
