// Preloaded into the actual CLI process. Persist only allowlisted fixture markers;
// never record headers, credentials, request prompts or arbitrary tool output.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const markers = JSON.parse(process.env.OHBABY_REAL_TOOL_MARKERS ?? "[]");
const evidencePath = process.env.OHBABY_REAL_WIRE_PATH;
const originalFetch = globalThis.fetch;
let sequence = 0;
const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.hostname === "zenmux.ai" &&
    url.pathname.endsWith("/chat/completions")
  ) {
    if (++sequence > 24) throw new Error("CONTROLLED_PROVIDER_REQUEST_LIMIT");
    const raw =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : "");
    const body = JSON.parse(typeof raw === "string" ? raw : String(raw));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolResults = messages
      .filter((message) => message.role === "tool")
      .map((message) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        return {
          callIdHash: hash(message.tool_call_id),
          role: "tool",
          characters: content.length,
          markers: markers.filter((marker) => content.includes(marker)),
        };
      });
    if (evidencePath)
      appendFileSync(
        evidencePath,
        JSON.stringify({
          sequence,
          model: body.model === "openai/gpt-5.6-luna" ? body.model : "other",
          toolResults,
        }) + "\n",
        { mode: 0o600 },
      );
  }
  return originalFetch(input, init);
};
