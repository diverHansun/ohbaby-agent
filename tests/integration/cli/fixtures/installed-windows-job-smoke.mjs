import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

assert.equal(process.platform, "win32");
// Select a real native shell, independently of a developer's Git Bash override.
const shell = [
  join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "PowerShell",
    "7",
    "pwsh.exe",
  ),
  join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ),
].find(existsSync);
assert.ok(shell, "A native PowerShell executable is required");
process.env.SHELL = shell;
const { createInProcessUiBackendClient } = await import("ohbaby-agent");
await writeFile("packaged-job.txt", "PACKAGED_JOB_READ_OK\n");
let turn = "bash";
const sent = new Set();
const delivered = new Map();
const llmClient = {
  config: {
    provider: "fake",
    model: "fake-model",
    apiKeyEnv: "FAKE_API_KEY",
    baseUrl: "https://example.invalid/v1",
    interfaceProvider: "openai-compatible",
    maxTokens: 128,
    temperature: 0,
  },
  provider: {
    id: "fake",
    kind: "openai-compatible",
    client: {},
    isAbortError: () => false,
    async streamResponse(request) {
      for (const message of request.messages)
        if (
          message.role === "tool" &&
          ["pack-job-bash", "pack-job-read"].includes(message.callId)
        )
          delivered.set(message.callId, String(message.content));
      const event =
        request.tools?.length && !sent.has(turn)
          ? {
              finishReason: "tool_calls",
              toolCallDeltas: [
                {
                  id: `pack-job-${turn}`,
                  index: 0,
                  name: turn,
                  argumentsDelta: JSON.stringify(
                    turn === "bash"
                      ? {
                          command:
                            "Write-Output 'PACKAGED_JOB_BASH_OK'; exit 0",
                          description:
                            "Check installed Windows process cleanup",
                        }
                      : { file_path: "packaged-job.txt" },
                  ),
                },
              ],
            }
          : { textDelta: "Packaging check done", finishReason: "stop" };
      if (event.toolCallDeltas) sent.add(turn);
      return (async function* () {
        yield event;
      })();
    },
  },
};
const backend = createInProcessUiBackendClient({
  workdir: process.cwd(),
  projectDirectory: process.cwd(),
  llmClient,
});
const sessionId = "installed-windows-job";
try {
  await backend.setPermission({ level: "full-access" });
  const first = await backend.submitPromptAndWait(
    "Run the short shell command",
    { sessionId, signal: AbortSignal.timeout(15000) },
  );
  assert.equal(first.prompt.status, "succeeded");
  assert.match(delivered.get("pack-job-bash") ?? "", /PACKAGED_JOB_BASH_OK/u);
  turn = "read";
  const second = await backend.submitPromptAndWait(
    "Read the fixture after the previous run closed",
    { sessionId, signal: AbortSignal.timeout(15000) },
  );
  assert.equal(second.prompt.status, "succeeded");
  assert.match(delivered.get("pack-job-read") ?? "", /PACKAGED_JOB_READ_OK/u);
  const jobs = await backend.listShellJobs({ rootSessionId: sessionId });
  assert.equal(jobs.unconfirmedCount, 0, JSON.stringify(jobs));
} finally {
  // Disposal is part of the assertion: unresolved process cleanup must fail.
  await backend.dispose();
}
console.log(JSON.stringify({ bash: true, nextTurnRead: true, disposed: true }));
