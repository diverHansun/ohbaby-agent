import { z } from "zod";
import type { ModelMessage } from "./types.js";

const object = <T extends z.ZodRawShape>(shape: T): z.ZodObject<T, "strict"> =>
  z.object(shape).strict();

const status = z.enum(["in_progress", "completed", "incomplete"]);
const reasoningItem = object({
  type: z.literal("reasoning"),
  id: z.string(),
  summary: z.array(
    object({ type: z.literal("summary_text"), text: z.string() }),
  ),
  content: z
    .array(object({ type: z.literal("reasoning_text"), text: z.string() }))
    .optional(),
  encrypted_content: z.string().nullable().optional(),
  status: status.optional(),
});
const responseMessage = object({
  type: z.literal("message"),
  id: z.string(),
  role: z.literal("assistant"),
  status,
  phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
  content: z.array(
    object({
      type: z.literal("output_text"),
      text: z.string(),
      annotations: z.array(z.never()),
      logprobs: z.array(z.never()).optional(),
    }),
  ),
});
const responseCall = object({
  type: z.literal("function_call"),
  id: z.string(),
  call_id: z.string(),
  async: z.literal(false).optional(),
  caller: object({ type: z.literal("direct") })
    .nullable()
    .optional(),
  name: z.string(),
  arguments: z.string(),
  status: status.optional(),
});
export const NativeResponsesItemSchema = z.discriminatedUnion("type", [
  reasoningItem,
  responseMessage,
  responseCall,
]);
export type NativeResponsesItem = z.infer<typeof NativeResponsesItemSchema>;
export const NativeAnthropicBlockSchema = z.discriminatedUnion("type", [
  object({ type: z.literal("text"), text: z.string() }),
  object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string(),
  }),
  object({ type: z.literal("redacted_thinking"), data: z.string() }),
  object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  }),
]);
export type NativeAnthropicBlock = z.infer<typeof NativeAnthropicBlockSchema>;
// ZenMux's documented Responses-to-Chat conversion returns decimal strings;
// preserve their wire representation while retaining a bounded index contract.
export const ChatReasoningIndexSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/),
]);
const chatDetail = z.discriminatedUnion("type", [
  object({
    type: z.literal("reasoning.text"),
    text: z.string().optional(),
    signature: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    format: z.string().optional(),
    index: ChatReasoningIndexSchema.optional(),
  }),
  object({
    type: z.literal("reasoning.summary"),
    summary: z.string(),
    id: z.string().nullable().optional(),
    format: z.string().optional(),
    index: ChatReasoningIndexSchema.optional(),
  }),
  object({
    type: z.literal("reasoning.encrypted"),
    data: z.string(),
    id: z.string().nullable().optional(),
    format: z.string().optional(),
    index: ChatReasoningIndexSchema.optional(),
  }),
]);
export const NativeOutputSchema = z.discriminatedUnion("protocol", [
  object({
    protocol: z.literal("openai-responses"),
    items: z.array(NativeResponsesItemSchema),
  }),
  object({
    protocol: z.literal("anthropic"),
    items: z.array(NativeAnthropicBlockSchema),
  }),
  object({
    protocol: z.literal("openai-compatible"),
    reasoningField: z.enum(["reasoning_content", "reasoning"]).optional(),
    reasoningText: z.string().optional(),
    reasoningDetails: z.array(chatDetail).optional(),
  }),
]);
export type NativeOutput = z.infer<typeof NativeOutputSchema>;
export const ModelOriginSchema = object({
  provider: z.string(),
  model: z.string(),
  protocol: z.enum(["openai-compatible", "openai-responses", "anthropic"]),
  endpoint: z.string(),
});
export type ModelOrigin = z.infer<typeof ModelOriginSchema>;
export const ModelStateSchema = object({
  version: z.literal(1),
  origin: ModelOriginSchema,
  output: NativeOutputSchema,
  estimate: object({
    tokens: z.number().int().nonnegative(),
    source: z.enum(["reasoning", "output", "limit", "text"]),
  }),
});
export type ModelState = z.infer<typeof ModelStateSchema>;

export function sameModelOrigin(
  left: ModelOrigin,
  right: ModelOrigin,
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.protocol === right.protocol &&
    left.endpoint.replace(/\/+$/, "") === right.endpoint.replace(/\/+$/, "")
  );
}

/** Raw protocol data is internal. Only a validated, same-source collection may be replayed. */
export function nativeOutputForMessage(
  message: Extract<ModelMessage, { role: "assistant" }>,
  origin: ModelOrigin,
): NativeOutput | undefined {
  if (message.modelState === undefined) return undefined;
  const state = ModelStateSchema.parse(message.modelState);
  if (state.output.protocol !== state.origin.protocol)
    throw new Error("Native state protocol does not match its origin");
  if (!sameModelOrigin(state.origin, origin)) return undefined;
  validateNativeProjection(message, state.output);
  return state.output;
}

export function nativeProjection(output: NativeOutput): {
  text: string;
  calls: { callId: string; name: string; arguments: Record<string, unknown> }[];
} {
  if (output.protocol === "openai-compatible") return { text: "", calls: [] };
  const text: string[] = [];
  const calls: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  }[] = [];
  if (output.protocol === "anthropic") {
    for (const item of output.items) {
      if (item.type === "text") text.push(item.text);
      if (item.type === "tool_use")
        calls.push({ callId: item.id, name: item.name, arguments: item.input });
    }
  } else {
    for (const item of output.items) {
      if (item.type === "message")
        text.push(...item.content.map((part) => part.text));
      if (item.type === "function_call")
        calls.push({
          callId: item.call_id,
          name: item.name,
          arguments: JSON.parse(item.arguments) as Record<string, unknown>,
        });
    }
  }
  return { text: text.join(""), calls };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function validateNativeProjection(
  message: Extract<ModelMessage, { role: "assistant" }>,
  output: NativeOutput,
): void {
  if (output.protocol === "openai-compatible") return;
  const projection = nativeProjection(output);
  const text =
    typeof message.content === "string"
      ? message.content
      : (message.content
          ?.map((part) => (part.type === "text" ? part.text : ""))
          .join("") ?? "");
  const calls = (message.toolCalls ?? []).map((call) => ({
    callId: call.callId,
    name: call.name,
    arguments: JSON.parse(call.argumentsJson) as Record<string, unknown>,
  }));
  if (
    text !== projection.text ||
    canonicalJson(calls) !== canonicalJson(projection.calls)
  )
    throw new Error(
      "Native state projection does not match assistant text and tools",
    );
}
