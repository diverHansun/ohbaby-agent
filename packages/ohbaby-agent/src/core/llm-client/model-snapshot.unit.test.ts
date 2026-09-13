import { expect, it } from "vitest";
import { streamResponse } from "./streaming.js";
import type {
  LLMClientInstance,
  ModelMessage,
  StreamingResponse,
} from "./types.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/types.js";

it("keeps partial call index and raw arguments in a text-only snapshot without role or reasoning", async () => {
  const client: LLMClientInstance = {
    config: {
      provider: "test",
      model: "test",
      baseUrl: "http://localhost:1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 32,
    },
    provider: {
      id: "test",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      async streamResponse() {
        await Promise.resolve();
        return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
          await Promise.resolve();
          yield {
            reasoningTextDelta: "thought",
            toolCallDeltas: [{ index: 3, name: "read", argumentsDelta: "{ " }],
          };
          yield {
            toolCallDeltas: [{ index: 3, id: "c", argumentsDelta: "}" }],
            finishReason: "tool_calls" as const,
          };
        })();
      },
    },
  };
  const frames = [];
  for await (const frame of streamResponse(client, [
    { role: "user", content: "read" },
  ]))
    frames.push(frame);
  expect(frames[0]?.messageSnapshot).toEqual({
    content: null,
    toolCalls: [{ index: 3, callId: "", name: "read", argumentsJson: "{ " }],
  });
  expect(frames[0]?.reasoningText).toBe("thought");
  expect(frames[1]?.messageSnapshot).toEqual({
    content: null,
    toolCalls: [{ index: 3, callId: "c", name: "read", argumentsJson: "{ }" }],
  });
});

it("replays a successful direct tool roundtrip with the original argument text and no stream index", async () => {
  const requests: InterfaceProviderRequest[] = [];
  const client: LLMClientInstance = {
    config: {
      provider: "test",
      model: "test",
      baseUrl: "http://localhost:1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 32,
    },
    provider: {
      id: "test",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      async streamResponse(request) {
        await Promise.resolve();
        requests.push(structuredClone(request));
        return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
          await Promise.resolve();
          if (requests.length === 1)
            yield {
              toolCallDeltas: [
                {
                  index: 7,
                  id: "c",
                  name: "read",
                  argumentsDelta: '{ "q": 1 }',
                },
              ],
              finishReason: "tool_calls" as const,
            };
          else yield { textDelta: "done", finishReason: "stop" as const };
        })();
      },
    },
  };
  const messages: ModelMessage[] = [{ role: "user", content: "read" }];
  let completed: StreamingResponse | undefined;
  for await (const frame of streamResponse(client, messages))
    if (frame.isComplete) completed = frame;
  if (
    completed?.streamStopReason !== "provider_finished" ||
    completed.finishReason !== "tool_calls" ||
    !completed.parsedToolCalls?.length
  )
    throw new Error("Expected successful parsed tool completion");
  const snapshot = completed.messageSnapshot;
  const toolCalls = completed.parsedToolCalls.map((parsed) => {
    const raw = snapshot.toolCalls?.find(
      (call) => call.callId === parsed.callId && call.name === parsed.name,
    );
    if (!raw) throw new Error("Missing complete call");
    return {
      callId: parsed.callId,
      name: parsed.name,
      argumentsJson: raw.argumentsJson,
    };
  });
  messages.push(
    {
      role: "assistant",
      content: completed.messageSnapshot.content,
      toolCalls,
    },
    { role: "tool", callId: "c", content: "result" },
  );
  for await (const frame of streamResponse(client, messages)) completed = frame;
  expect(requests[1]?.messages).toEqual([
    { role: "user", content: "read" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ callId: "c", name: "read", argumentsJson: '{ "q": 1 }' }],
    },
    { role: "tool", callId: "c", content: "result" },
  ]);
  expect(completed.messageSnapshot).toEqual({ content: "done" });
});
