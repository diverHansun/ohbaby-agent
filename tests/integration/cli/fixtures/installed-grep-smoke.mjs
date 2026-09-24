import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const { createInProcessUiBackendClient } = await import("ohbaby-agent");
const expectUnavailable = process.argv.includes("--expect-unavailable");
await writeFile("packaged-search.txt", "PACKAGED_RG_OK\n");
let toolSeen = false;
let delivered = false;
const toolResults = [];
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
      // Results can reach a final request with tools disabled. Observe delivery
      // independently of which response this fake provider emits next.
      const results = request.messages.filter(
        (message) => message.role === "tool" && message.callId === "pack-grep",
      );
      toolResults.push(...results);
      delivered ||= results.some((message) =>
        String(message.content).includes(
          expectUnavailable ? "Search unavailable" : "PACKAGED_RG_OK",
        ),
      );
      const events = [];
      if (!request.tools?.length)
        events.push({ textDelta: "Packaging check", finishReason: "stop" });
      else if (!toolSeen) {
        toolSeen = true;
        events.push({
          finishReason: "tool_calls",
          toolCallDeltas: [
            {
              id: "pack-grep",
              index: 0,
              name: "grep",
              argumentsDelta: JSON.stringify({
                path: "packaged-search.txt",
                pattern: "PACKAGED_RG_OK",
              }),
            },
          ],
        });
      } else {
        events.push({ textDelta: "Packaging done", finishReason: "stop" });
      }
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  },
};
const backend = createInProcessUiBackendClient({
  workdir: process.cwd(),
  projectDirectory: process.cwd(),
  llmClient,
});
try {
  const result = await backend.submitPromptAndWait("Verify installed grep", {
    signal: AbortSignal.timeout(15000),
  });
  if (result.prompt.status !== "succeeded" || !toolSeen || !delivered)
    throw new Error(
      `Installed bundled search failed: ${JSON.stringify({
        prompt: result.prompt,
        toolSeen,
        delivered,
        toolResults,
      })}`,
    );
  const binary = expectUnavailable
    ? undefined
    : createRequire(import.meta.resolve("ohbaby-agent"))("@vscode/ripgrep")
        .rgPath;
  console.log(
    JSON.stringify({
      searched: !expectUnavailable,
      unavailable: expectUnavailable,
      delivered: true,
      binary,
    }),
  );
} finally {
  await backend.dispose();
}
