import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderTerminalUi } from "../../../../packages/ohbaby-cli/src/tui/index.js";
import { createTuiReviewBackend } from "./tui-improve1-backend.js";

// Run with `pnpm exec tsx --tsconfig tsconfig.base.json tests/integration/cli/fixtures/tui-improve1-process.ts`.
// This is a local synthetic backend; no model or real permission is involved.
const workspace = await mkdtemp(path.join(os.tmpdir(), "ohbaby-tui-process-"));
const backend = createTuiReviewBackend();
const app = renderTerminalUi({
  client: backend.client,
  subscribeEvents: backend.subscribeEvents,
  pendingPromptWorkspace: workspace,
});
// The application owns stdin. Scenario changes are timed backend events.
const permissionTimer = setTimeout(() => backend.approve(), 2000);
const stopTimer = setTimeout(() => app.unmount(), 12000);
try {
  await app.waitUntilExit();
} finally {
  clearTimeout(permissionTimer);
  clearTimeout(stopTimer);
  await rm(workspace, { recursive: true, force: true });
}
