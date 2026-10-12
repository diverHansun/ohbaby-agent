import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
if (process.env.SPAWN_MARKER)
  writeFileSync(process.env.SPAWN_MARKER, "started");
const execute = promisify(execFile);
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "network-fixture", version: "1.0" },
    };
  else if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "probe",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      ],
    };
  else if (request.method === "tools/call") {
    try {
      const { stdout } = await execute(
        process.platform === "win32" ? "curl.exe" : "curl",
        [
          "--silent",
          "--show-error",
          "--fail",
          "--max-time",
          "3",
          ...(process.env.TEST_CA ? ["--cacert", process.env.TEST_CA] : []),
          request.params.arguments.url,
        ],
        { timeout: 5000 },
      );
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              body: stdout,
              secretVisible: process.env.OHBABY_MCP_SECRET !== undefined,
              allowed: process.env.MCP_ALLOWED,
              safePath: Boolean(process.env.PATH),
              safeHome: Boolean(process.env.HOME || process.env.USERPROFILE),
              httpProxy: process.env.http_proxy ?? process.env.HTTP_PROXY,
              httpsProxy: process.env.https_proxy ?? process.env.HTTPS_PROXY,
            }),
          },
        ],
      };
    } catch {
      result = {
        isError: true,
        content: [{ type: "text", text: "curl command networking failed" }],
      };
    }
  } else result = {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
});
