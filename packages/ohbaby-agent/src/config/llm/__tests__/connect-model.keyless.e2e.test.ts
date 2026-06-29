import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLLMClient,
  streamChatCompletion,
} from "../../../core/llm-client/index.js";
import { applyActiveModelConfig } from "../apply-active-model-config.js";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";

interface CapturedRequest {
  readonly authorization: string | undefined;
  readonly body?: Record<string, unknown>;
  readonly method: string | undefined;
  readonly url: string | undefined;
}

const cleanupPaths: string[] = [];
const MODEL = "local-model";
const MARKER = "OHBABY_KEYLESS_E2E_OK";

afterEach(async () => {
  LLMConfigManager.resetInstance();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function tempProjectRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-keyless-e2e-"));
  cleanupPaths.push(directory);
  return directory;
}

async function startKeylessOpenAiServer(): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void handleKeylessOpenAiRequest(request, response, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    requests,
  };
}

async function handleKeylessOpenAiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  if (request.method === "GET" && request.url === "/v1/models") {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({
        data: [
          {
            context_length: 65_536,
            id: MODEL,
          },
        ],
      }),
    );
    return;
  }

  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      } else {
        throw new TypeError("Unsupported request chunk");
      }
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(rawBody) as Record<string, unknown>,
      method: request.method,
      url: request.url,
    });

    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    });
    writeSse(response, {
      choices: [
        {
          delta: { content: MARKER },
          finish_reason: null,
          index: 0,
        },
      ],
      created: 0,
      id: "chatcmpl_keyless",
      model: MODEL,
      object: "chat.completion.chunk",
    });
    writeSse(response, {
      choices: [
        {
          delta: {},
          finish_reason: "stop",
          index: 0,
        },
      ],
      created: 0,
      id: "chatcmpl_keyless",
      model: MODEL,
      object: "chat.completion.chunk",
    });
    writeSse(response, {
      choices: [],
      created: 0,
      id: "chatcmpl_keyless",
      model: MODEL,
      object: "chat.completion.chunk",
      usage: {
        completion_tokens: 4,
        prompt_tokens: 4,
        total_tokens: 8,
      },
    });
    response.end("data: [DONE]\n\n");
    return;
  }

  response.writeHead(404);
  response.end("not found");
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

describe("connectModel keyless local endpoint e2e", () => {
  it("saves, reloads, and streams without apiKeyEnv or apiKey", async () => {
    const server = await startKeylessOpenAiServer();
    const projectRoot = await tempProjectRoot();
    const modelJsonPath = join(
      projectRoot,
      "home",
      ".ohbaby-agent",
      "model.json",
    );
    const envPath = join(projectRoot, "home", ".ohbaby-agent", ".env");

    try {
      const result = await applyActiveModelConfig({
        baseUrl: server.baseUrl,
        interfaceProvider: "openai-compatible",
        model: MODEL,
        modelJsonPath,
        projectRoot,
        provider: "lmstudio",
        envPath,
      });

      expect(result).toMatchObject({
        baseUrl: server.baseUrl,
        contextWindowSource: "detected",
        contextWindowTokens: 65_536,
        interfaceProvider: "openai-compatible",
        model: MODEL,
        provider: "lmstudio",
        saved: true,
      });
      expect(result).not.toHaveProperty("apiKeyEnv");

      const modelJson = JSON.parse(await readFile(modelJsonPath, "utf8")) as {
        readonly apiConfig: {
          readonly apiKeyEnv?: string;
          readonly baseUrl: string;
          readonly interfaceProvider?: string;
        };
      };
      expect(modelJson.apiConfig).toEqual({
        baseUrl: server.baseUrl,
        interfaceProvider: "openai-compatible",
      });
      await expect(stat(envPath)).rejects.toMatchObject({ code: "ENOENT" });

      LLMConfigManager.resetInstance();
      const client = await createLLMClient({
        env: {},
        envPath,
        modelJsonPath,
        projectDirectory: projectRoot,
      });
      expect(client.config).toMatchObject({
        baseUrl: server.baseUrl,
        interfaceProvider: "openai-compatible",
        model: MODEL,
        provider: "lmstudio",
      });
      expect(client.config).not.toHaveProperty("apiKey");
      expect(client.config).not.toHaveProperty("apiKeyEnv");

      let fullText = "";
      for await (const response of streamChatCompletion(
        client,
        [{ role: "user", content: `Reply with exactly: ${MARKER}` }],
        { retry: { maxRetriesPerStep: 0 } },
      )) {
        if (typeof response.completeMessage.content === "string") {
          fullText = response.completeMessage.content;
        }
      }

      expect(fullText).toBe(MARKER);
      expect(
        server.requests.every(
          (request) => request.authorization === "Bearer not-needed",
        ),
      ).toBe(true);
      expect(server.requests.map((request) => request.url)).toEqual([
        "/v1/models",
        "/v1/chat/completions",
      ]);
    } finally {
      await server.close();
    }
  });
});
