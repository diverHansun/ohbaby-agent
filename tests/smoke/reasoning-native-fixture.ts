import {
  NATIVE_PROBE_RESULT,
  NATIVE_PROBE_TOOL,
  type NativeRealProfile,
} from "./reasoning-native-harness.js";

/** Fake only the external HTTP boundary; SDK parsing and all runtime components stay real. */
export function nativeFixtureTransport(
  profile: NativeRealProfile,
): typeof fetch {
  let requests = 0;
  return (_input, init) => {
    if (typeof init?.body !== "string")
      throw new Error("FIXTURE_EXPECTED_JSON_BODY");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const first = requests % 2 === 0;
    const enabled = requests < 2;
    requests += 1;
    const number = String(requests);
    const input = first ? 1000 : 9000;
    const read = first ? 600 : 0;
    let events: Record<string, unknown>[];
    if (profile.protocol === "openai-responses") {
      const output = [
        ...(enabled
          ? [
              {
                type: "reasoning",
                id: `reason-${number}`,
                summary: [],
                encrypted_content: `fixture-encrypted-${number}`,
                status: "completed",
              },
            ]
          : []),
        first
          ? {
              type: "function_call",
              id: `item-${number}`,
              call_id: `call-${number}`,
              name: NATIVE_PROBE_TOOL,
              arguments: "{}",
              status: "completed",
            }
          : {
              type: "message",
              id: `message-${number}`,
              role: "assistant",
              status: "completed",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: NATIVE_PROBE_RESULT,
                  annotations: [],
                  logprobs: [],
                },
              ],
            },
      ];
      const itemEvents = output.flatMap(
        (raw, output_index): Record<string, unknown>[] => {
          const item = raw as Record<string, unknown>;
          const ref = { item_id: item.id, output_index };
          if (item.type === "reasoning")
            return [
              {
                type: "response.output_item.added",
                ...ref,
                item: {
                  ...item,
                  status: "in_progress",
                  encrypted_content: null,
                },
              },
              { type: "response.output_item.done", ...ref, item },
            ];
          if (item.type === "function_call")
            return [
              {
                type: "response.output_item.added",
                ...ref,
                item: { ...item, status: "in_progress", arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                ...ref,
                delta: "{}",
              },
              {
                type: "response.function_call_arguments.done",
                ...ref,
                arguments: "{}",
              },
              { type: "response.output_item.done", ...ref, item },
            ];
          const part = {
            type: "output_text",
            text: NATIVE_PROBE_RESULT,
            annotations: [],
            logprobs: [],
          };
          const partRef = { ...ref, content_index: 0 };
          return [
            {
              type: "response.output_item.added",
              ...ref,
              item: { ...item, status: "in_progress", content: [] },
            },
            {
              type: "response.content_part.added",
              ...partRef,
              part: { ...part, text: "" },
            },
            {
              type: "response.output_text.delta",
              ...partRef,
              delta: NATIVE_PROBE_RESULT,
              logprobs: [],
            },
            {
              type: "response.output_text.done",
              ...partRef,
              text: NATIVE_PROBE_RESULT,
              logprobs: [],
            },
            { type: "response.content_part.done", ...partRef, part },
            { type: "response.output_item.done", ...ref, item },
          ];
        },
      );
      events = [
        ...itemEvents,
        {
          type: "response.completed",
          response: {
            id: `response-${number}`,
            status: "completed",
            output,
            previous_response_id: null,
            store: false,
            usage: {
              input_tokens: input,
              output_tokens: 20,
              total_tokens: input + 20,
              input_tokens_details: { cached_tokens: read },
              output_tokens_details: { reasoning_tokens: enabled ? 8 : 0 },
            },
          },
        },
      ];
    } else if (profile.protocol === "anthropic") {
      const content = [
        ...(enabled
          ? [
              {
                type: "thinking",
                thinking: "Synthetic reasoning",
                signature: `fixture-signature-${number}`,
              },
            ]
          : []),
        first
          ? {
              type: "tool_use",
              id: `call-${number}`,
              name: NATIVE_PROBE_TOOL,
              input: {},
            }
          : { type: "text", text: NATIVE_PROBE_RESULT },
      ];
      events = [
        {
          type: "message_start",
          message: {
            id: `message-${number}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: input - read,
              output_tokens: 0,
              cache_read_input_tokens: read,
              cache_creation_input_tokens: 0,
            },
          },
        },
        ...content.flatMap((block, index) => [
          { type: "content_block_start", index, content_block: block },
          { type: "content_block_stop", index },
        ]),
        {
          type: "message_delta",
          delta: {
            stop_reason: first ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: {
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: enabled ? 8 : 0 },
          },
        },
        { type: "message_stop" },
      ];
    } else {
      events = [
        {
          id: `chat-${number}`,
          created: 0,
          object: "chat.completion.chunk",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                ...(enabled
                  ? {
                      reasoning_content: "Synthetic reasoning",
                      reasoning_details: [
                        {
                          type: "reasoning.encrypted",
                          index: 0,
                          data: `fixture-encrypted-${number}`,
                        },
                      ],
                    }
                  : {}),
                ...(first
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          type: "function",
                          id: `call-${number}`,
                          function: {
                            name: NATIVE_PROBE_TOOL,
                            arguments: "{}",
                          },
                        },
                      ],
                    }
                  : { content: NATIVE_PROBE_RESULT }),
              },
              finish_reason: first ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: input,
            completion_tokens: 20,
            total_tokens: input + 20,
            prompt_tokens_details: { cached_tokens: read },
            completion_tokens_details: { reasoning_tokens: enabled ? 8 : 0 },
          },
        },
      ];
    }
    const wire =
      events
        .map(
          (event) =>
            `${typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
        )
        .join("") +
      (profile.protocol === "openai-compatible" ? "data: [DONE]\n\n" : "");
    return Promise.resolve(
      new Response(wire, { headers: { "content-type": "text/event-stream" } }),
    );
  };
}
