import { APIUserAbortError } from "openai";
import type {
  Response,
  ResponseContentPartAddedEvent,
  ResponseOutputItem,
  ResponseOutputText,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  NativeResponsesItemSchema,
  type NativeResponsesItem,
} from "./native-state.js";
import type { InterfaceProviderStreamEvent } from "./types.js";
import {
  normalizeOpenAIResponsesUsage,
  type TokenUsageDiagnosticReporter,
} from "./token-usage.js";

type SupportedItem = Extract<
  ResponseOutputItem,
  { type: "message" | "function_call" | "reasoning" }
>;
type ItemStatus = "in_progress" | "completed" | "incomplete";
interface BaseState {
  id: string;
  outputIndex: number;
  status: ItemStatus;
  snapshot?: SupportedItem;
}
interface TextState {
  text: string;
  textDone: boolean;
  done: boolean;
}
interface MessageState extends BaseState {
  type: "message";
  part?: TextState;
  phase?: "commentary" | "final_answer" | null;
}
interface FunctionState extends BaseState {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string;
  argumentsDone: boolean;
  toolIndex: number;
}
interface ReasoningState extends BaseState {
  type: "reasoning";
  summary: Map<number, TextState>;
  content: Map<number, TextState>;
}
type ItemState = MessageState | FunctionState | ReasoningState;
interface ItemReference {
  item_id: string;
  output_index: number;
  type: string;
}

function check(
  condition: unknown,
  type: string,
  reason: string,
): asserts condition {
  if (!condition) throw new Error(`Responses ${type}: ${reason}`);
}

function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSynchronous(value: unknown): boolean {
  return value === undefined || value === false;
}

function isNullish(value: unknown): boolean {
  return value === undefined || value === null;
}

function isPhase(value: unknown): boolean {
  return isNullish(value) || value === "commentary" || value === "final_answer";
}
function isSummaryPart(value: unknown): boolean {
  return (
    isObject(value) &&
    (value as Record<string, unknown>).type === "summary_text"
  );
}
function isReasoningPart(value: unknown): boolean {
  return (
    isObject(value) &&
    (value as Record<string, unknown>).type === "reasoning_text"
  );
}
function reasoningTokenCount(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const usage = value as Record<string, unknown>;
  if (!isObject(usage.output_tokens_details)) return undefined;
  const count = (usage.output_tokens_details as Record<string, unknown>)
    .reasoning_tokens;
  return typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    typeof usage.output_tokens === "number" &&
    count <= usage.output_tokens
    ? count
    : undefined;
}

function isAssistant(role: unknown): boolean {
  return role === "assistant";
}

function supportedItem(item: ResponseOutputItem, type: string): SupportedItem {
  // SDK declarations do not validate wire data; keep runtime checks at every boundary.
  check(isObject(item), type, "output item must be an object");
  const itemType = item.type;
  switch (item.type) {
    case "message":
      check(isPhase(item.phase), type, "message phase is unsupported");
      check(isAssistant(item.role), type, "message role must be assistant");
      check(
        Array.isArray(item.content),
        type,
        "message content must be an array",
      );
      return item;
    case "function_call":
      check(
        typeof item.call_id === "string" && item.call_id.trim().length > 0,
        type,
        "function call_id must be nonempty",
      );
      check(
        typeof item.name === "string" && item.name.trim().length > 0,
        type,
        "function name must be nonempty",
      );
      check(
        isSynchronous(item.async),
        type,
        "async function calls are unsupported",
      );
      check(
        !Object.hasOwn(item, "namespace"),
        type,
        "function namespace is unsupported",
      );
      check(
        item.caller === null ||
          item.caller === undefined ||
          item.caller.type === "direct",
        type,
        "only direct function caller is supported",
      );
      return item;
    case "reasoning":
      check(
        Array.isArray(item.summary),
        type,
        "reasoning summary must be an array",
      );
      for (const part of item.summary)
        check(
          isSummaryPart(part) && typeof part.text === "string",
          type,
          "invalid reasoning summary",
        );
      check(
        item.content === undefined || Array.isArray(item.content),
        type,
        "reasoning content must be an array",
      );
      for (const part of item.content ?? [])
        check(
          isReasoningPart(part) && typeof part.text === "string",
          type,
          "invalid reasoning content",
        );
      check(
        isNullish(item.encrypted_content) ||
          typeof item.encrypted_content === "string",
        type,
        "invalid encrypted_content",
      );
      return item;
    case "file_search_call":
    case "function_call_output":
    case "web_search_call":
    case "computer_call":
    case "computer_call_output":
    case "program":
    case "program_output":
    case "tool_search_call":
    case "tool_search_output":
    case "additional_tools":
    case "compaction":
    case "image_generation_call":
    case "code_interpreter_call":
    case "local_shell_call":
    case "local_shell_call_output":
    case "shell_call":
    case "shell_call_output":
    case "apply_patch_call":
    case "apply_patch_call_output":
    case "mcp_call":
    case "mcp_list_tools":
    case "mcp_approval_request":
    case "mcp_approval_response":
    case "custom_tool_call":
    case "custom_tool_call_output":
      throw new Error(
        `Responses ${type}: unsupported output item ${item.type}`,
      );
    default:
      return unknownMember(item, `${type} output item ${itemType}`);
  }
}

function unknownMember(_value: never, type: string): never {
  throw new Error(`Responses ${type}: unknown protocol member`);
}

function emptyLogprobs(value: unknown, type: string): void {
  check(
    value === undefined || (Array.isArray(value) && value.length === 0),
    type,
    "nonempty or invalid logprobs are unsupported",
  );
}

function outputText(
  part: ResponseContentPartAddedEvent["part"],
  type: string,
): ResponseOutputText {
  check(isObject(part), type, "content part must be an object");
  check(
    part.type === "output_text",
    type,
    `unsupported content type ${part.type}`,
  );
  check(
    typeof part.text === "string",
    type,
    "output_text text must be a string",
  );
  check(
    Array.isArray(part.annotations) && part.annotations.length === 0,
    type,
    "annotations are unsupported",
  );
  emptyLogprobs(part.logprobs, type);
  return part;
}

class ResponsesStreamState {
  private responseId?: string;
  private readonly items = new Map<string, ItemState>();
  private readonly outputIndices = new Set<number>();
  private readonly callIds = new Set<string>();
  private messageIndex?: number;
  private lifecycleStatus?: string;
  private nativeRequired = false;

  validateResponse(
    response: Response,
    type: string,
    expectedStatus: string,
  ): void {
    check(isObject(response), type, "response must be an object");
    check(
      typeof response.id === "string" && response.id.trim().length > 0,
      type,
      "response id must be nonempty",
    );
    check(
      this.responseId === undefined || this.responseId === response.id,
      type,
      "response id changed",
    );
    this.responseId = response.id;
    check(
      !(
        expectedStatus === "queued" &&
        (this.lifecycleStatus === "in_progress" || this.items.size > 0)
      ),
      type,
      "lifecycle regression to queued",
    );
    this.lifecycleStatus = expectedStatus;
    check(
      response.status === expectedStatus,
      type,
      "response status does not match event",
    );
    if (expectedStatus !== "incomplete") {
      check(
        isNullish(response.incomplete_details),
        type,
        "incomplete_details conflicts with non-incomplete response status",
      );
    }
    check(
      response.previous_response_id === null ||
        response.previous_response_id === undefined,
      type,
      "previous_response_id is unsupported",
    );
    check(
      !("store" in response) || response.store !== true,
      type,
      "store:true is unsupported",
    );
    check(
      isNullish(response.error),
      type,
      "response carries provider failure metadata",
    );
    if (expectedStatus === "in_progress" || expectedStatus === "queued") {
      check(
        Array.isArray(response.output) && response.output.length === 0,
        type,
        "lifecycle snapshots must not contain output items",
      );
    }
  }

  private activeItem(event: ItemReference): ItemState {
    const item = this.items.get(event.item_id);
    check(item !== undefined, event.type, "item has no preceding added event");
    check(
      item.outputIndex === event.output_index,
      event.type,
      "output_index does not match item binding",
    );
    check(
      item.status === "in_progress",
      event.type,
      "event occurs after item done",
    );
    return item;
  }

  private activePart(
    event: ItemReference & { content_index: number },
  ): TextState {
    const item = this.activeItem(event);
    check(
      item.type === "message" && item.part !== undefined,
      event.type,
      "text has no preceding content_part.added",
    );
    check(
      event.content_index === 0,
      event.type,
      "only content_index 0 is supported",
    );
    check(!item.part.done, event.type, "event occurs after content_part.done");
    return item.part;
  }

  add(
    event: Extract<ResponseStreamEvent, { type: "response.output_item.added" }>,
  ): InterfaceProviderStreamEvent | undefined {
    const item = supportedItem(event.item, event.type);
    check(
      typeof item.id === "string" && item.id.trim().length > 0,
      event.type,
      "item id must be nonempty",
    );
    check(
      Number.isInteger(event.output_index) && event.output_index >= 0,
      event.type,
      "output_index must be a nonnegative integer",
    );
    check(
      !this.items.has(item.id) && !this.outputIndices.has(event.output_index),
      event.type,
      "duplicate item id or output_index",
    );
    check(
      item.status === "in_progress" ||
        (item.type === "reasoning" && item.status === undefined),
      event.type,
      "added item must be in_progress",
    );
    const base: BaseState = {
      id: item.id,
      outputIndex: event.output_index,
      status: "in_progress",
    };
    this.outputIndices.add(event.output_index);
    if (item.type === "reasoning") {
      this.nativeRequired = true;
      this.items.set(item.id, {
        ...base,
        type: "reasoning",
        summary: new Map(),
        content: new Map(),
      });
      return undefined;
    }
    if (item.type === "message") {
      if (this.messageIndex !== undefined || !isNullish(item.phase))
        this.nativeRequired = true;
      check(
        Array.isArray(item.content) && item.content.length === 0,
        event.type,
        "added message content must be empty",
      );
      this.messageIndex ??= event.output_index;
      this.items.set(item.id, { ...base, type: "message", phase: item.phase });
      return undefined;
    }
    check(
      !this.callIds.has(item.call_id),
      event.type,
      "call_id binding cannot be reused",
    );
    check(
      item.arguments === "",
      event.type,
      "added function arguments must be empty",
    );
    // Chat indices follow discovery order, independently of sparse output indices.
    const toolIndex = this.callIds.size;
    this.callIds.add(item.call_id);
    this.items.set(item.id, {
      ...base,
      type: "function_call",
      callId: item.call_id,
      name: item.name,
      arguments: "",
      argumentsDone: false,
      toolIndex,
    });
    return {
      toolCallDeltas: [{ index: toolIndex, id: item.call_id, name: item.name }],
    };
  }

  addPart(
    event: Extract<
      ResponseStreamEvent,
      { type: "response.content_part.added" }
    >,
  ): void {
    const item = this.activeItem(event);
    check(
      item.type === "message",
      event.type,
      "content part requires a message item",
    );
    check(
      item.part === undefined && event.content_index === 0,
      event.type,
      "exactly one content part at index 0 is supported",
    );
    const part = outputText(event.part, event.type);
    check(part.text === "", event.type, "added content text must be empty");
    item.part = { text: "", textDone: false, done: false };
  }

  textDelta(
    event: Extract<ResponseStreamEvent, { type: "response.output_text.delta" }>,
  ): InterfaceProviderStreamEvent {
    emptyLogprobs(event.logprobs, event.type);
    const part = this.activePart(event);
    check(!part.textDone, event.type, "delta occurs after output_text.done");
    check(
      typeof event.delta === "string",
      event.type,
      "delta must be a string",
    );
    part.text += event.delta;
    return { textDelta: event.delta };
  }

  textDone(
    event: Extract<ResponseStreamEvent, { type: "response.output_text.done" }>,
  ): void {
    emptyLogprobs(event.logprobs, event.type);
    const part = this.activePart(event);
    check(
      !part.textDone && event.text === part.text,
      event.type,
      "duplicate or inconsistent text done",
    );
    part.textDone = true;
  }

  partDone(
    event: Extract<ResponseStreamEvent, { type: "response.content_part.done" }>,
  ): void {
    const part = this.activePart(event);
    const incoming = outputText(event.part, event.type);
    check(
      part.textDone && incoming.text === part.text,
      event.type,
      "content part done does not match accumulated text",
    );
    part.done = true;
  }

  arguments(
    event: Extract<
      ResponseStreamEvent,
      {
        type:
          | "response.function_call_arguments.delta"
          | "response.function_call_arguments.done";
      }
    >,
  ): InterfaceProviderStreamEvent | undefined {
    const item = this.activeItem(event);
    check(
      item.type === "function_call",
      event.type,
      "arguments require a function_call item",
    );
    check(!item.argumentsDone, event.type, "event occurs after arguments done");
    if (event.type === "response.function_call_arguments.done") {
      check(
        event.arguments === item.arguments,
        event.type,
        "arguments done does not match accumulated arguments",
      );
      item.argumentsDone = true;
      return undefined;
    }
    check(
      typeof event.delta === "string",
      event.type,
      "arguments delta must be a string",
    );
    item.arguments += event.delta;
    return {
      toolCallDeltas: [{ index: item.toolIndex, argumentsDelta: event.delta }],
    };
  }

  reasoning(
    event: Extract<
      ResponseStreamEvent,
      {
        type:
          | "response.reasoning_summary_part.added"
          | "response.reasoning_summary_part.done"
          | "response.reasoning_summary_text.delta"
          | "response.reasoning_summary_text.done"
          | "response.reasoning_text.delta"
          | "response.reasoning_text.done";
      }
    >,
  ): void {
    const item = this.activeItem(event);
    check(
      item.type === "reasoning",
      event.type,
      "reasoning event requires a reasoning item",
    );
    const summary = "summary_index" in event;
    const index = summary ? event.summary_index : event.content_index;
    check(
      Number.isInteger(index) && index >= 0,
      event.type,
      "reasoning part index must be a nonnegative integer",
    );
    const parts = summary ? item.summary : item.content;
    if (event.type === "response.reasoning_summary_part.added") {
      check(
        index === parts.size && !parts.has(index),
        event.type,
        "duplicate or unordered reasoning part",
      );
      check(
        isSummaryPart(event.part) && event.part.text === "",
        event.type,
        "added reasoning summary must be empty",
      );
      parts.set(index, { text: "", textDone: false, done: false });
      return;
    }
    if (!summary && !parts.has(index)) {
      check(index === parts.size, event.type, "unordered reasoning content");
      parts.set(index, { text: "", textDone: false, done: false });
    }
    const part = parts.get(index);
    check(
      part !== undefined,
      event.type,
      "reasoning summary missing added part",
    );
    check(!part.done, event.type, "reasoning event follows part done");
    if (event.type === "response.reasoning_summary_part.done") {
      check(
        isSummaryPart(event.part) &&
          event.part.text === part.text &&
          part.textDone,
        event.type,
        "reasoning summary part conflicts with accumulated text",
      );
      part.done = true;
    } else if ("delta" in event) {
      check(
        !part.textDone && typeof event.delta === "string",
        event.type,
        "invalid reasoning delta or delta after done",
      );
      part.text += event.delta;
    } else {
      check(
        !part.textDone && event.text === part.text,
        event.type,
        "reasoning text done conflicts with accumulated text",
      );
      part.textDone = true;
      if (!summary) part.done = true;
    }
  }

  private validateFinalItem(
    rawItem: ResponseOutputItem,
    item: ItemState,
    type: string,
    status?: string,
  ): SupportedItem {
    const incoming = supportedItem(rawItem, type);
    check(
      incoming.id === item.id && incoming.type === item.type,
      type,
      "final item id/type or order differs from stream",
    );
    check(
      incoming.status === "completed" ||
        incoming.status === "incomplete" ||
        (incoming.type === "reasoning" && incoming.status === undefined),
      type,
      "done item must be completed or incomplete",
    );
    if (status !== undefined)
      check(
        (incoming.status ?? "completed") === item.status &&
          (status === "incomplete" ||
            (incoming.status ?? "completed") === "completed"),
        type,
        "item status conflicts with terminal status",
      );
    if (incoming.type === "reasoning" && item.type === "reasoning") {
      for (const [parts, content] of [
        [item.summary, incoming.summary],
        [item.content, incoming.content ?? []],
      ] as const) {
        for (const [index, part] of parts)
          check(
            part.done && content[index]?.text === part.text,
            type,
            "reasoning final content conflicts with stream",
          );
        if (parts.size > 0)
          check(
            content.length === parts.size,
            type,
            "reasoning final part count conflicts with stream",
          );
      }
      if (item.snapshot?.type === "reasoning") {
        check(
          JSON.stringify(incoming.summary) ===
            JSON.stringify(item.snapshot.summary) &&
            JSON.stringify(incoming.content) ===
              JSON.stringify(item.snapshot.content),
          type,
          "reasoning snapshot content conflict",
        );
        // Opaque ciphertext is not a content identity. The SDK requires the
        // completed output_item.done value for replay; terminal may re-envelope it.
        // Visible content and item identity still have to agree above.
      }
    } else if (incoming.type === "message" && item.type === "message") {
      check(
        isNullish(item.phase) || incoming.phase === item.phase,
        type,
        "message phase conflicts with stream",
      );
      if (item.snapshot?.type === "message")
        check(
          incoming.phase === item.snapshot.phase,
          type,
          "message phase snapshot conflict",
        );
      if (!isNullish(incoming.phase)) this.nativeRequired = true;
      check(item.part?.done, type, "message missing completed content part");
      check(
        incoming.content.length === 1,
        type,
        "final message requires exactly one content part",
      );
      const part = outputText(incoming.content[0], type);
      check(
        part.text === item.part.text,
        type,
        "final text does not match accumulated text",
      );
    } else if (
      incoming.type === "function_call" &&
      item.type === "function_call"
    ) {
      check(
        item.argumentsDone && incoming.arguments === item.arguments,
        type,
        "final arguments do not match accumulated arguments",
      );
      check(
        incoming.call_id === item.callId && incoming.name === item.name,
        type,
        "call_id/name binding changed",
      );
    }
    return incoming;
  }

  done(
    event: Extract<ResponseStreamEvent, { type: "response.output_item.done" }>,
  ): void {
    const incoming = supportedItem(event.item, event.type);
    check(typeof incoming.id === "string", event.type, "done item requires id");
    const previous = this.items.get(incoming.id);
    if (previous?.type === "reasoning" && previous.status !== "in_progress") {
      check(
        previous.outputIndex === event.output_index,
        event.type,
        "output_index does not match item binding",
      );
      check(
        JSON.stringify(NativeResponsesItemSchema.parse(incoming)) ===
          JSON.stringify(NativeResponsesItemSchema.parse(previous.snapshot)),
        event.type,
        "conflicting duplicate reasoning snapshot",
      );
      return;
    }
    const item = this.activeItem({ ...event, item_id: incoming.id });
    const validated = this.validateFinalItem(incoming, item, event.type);
    item.snapshot = structuredClone(validated);
    check(
      validated.status === "completed" ||
        validated.status === "incomplete" ||
        (validated.type === "reasoning" && validated.status === undefined),
      event.type,
      "invalid done status",
    );
    item.status = validated.status ?? "completed";
  }

  terminal(
    event: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" }
    >,
    report?: TokenUsageDiagnosticReporter,
  ): InterfaceProviderStreamEvent {
    const status =
      event.type === "response.completed" ? "completed" : "incomplete";
    this.validateResponse(event.response, event.type, status);
    const ordered = [...this.items.values()].sort(
      (a, b) => a.outputIndex - b.outputIndex,
    );
    check(
      Array.isArray(event.response.output) &&
        event.response.output.length === ordered.length,
      event.type,
      "terminal output is not the complete streamed item set",
    );
    if (
      ordered.some(
        (item, index) =>
          item.type === "message" &&
          ordered
            .slice(0, index)
            .some((previous) => previous.type === "function_call"),
      )
    )
      this.nativeRequired = true;
    const nativeItems: NativeResponsesItem[] = [];
    for (const [index, item] of ordered.entries()) {
      check(
        item.status !== "in_progress",
        event.type,
        "terminal before output_item.done",
      );
      const validated = this.validateFinalItem(
        event.response.output[index],
        item,
        event.type,
        status,
      );
      const replayItem =
        validated.type === "reasoning" &&
        item.snapshot?.type === "reasoning" &&
        !isNullish(item.snapshot.encrypted_content)
          ? { ...validated, encrypted_content: item.snapshot.encrypted_content }
          : validated;
      // Some gateways only supply encrypted content in the terminal response;
      // use that value only when the completed item had none.
      nativeItems.push(NativeResponsesItemSchema.parse(replayItem));
    }
    const reason = event.response.incomplete_details?.reason;
    if (status === "incomplete") {
      check(
        reason === "max_output_tokens" || reason === "content_filter",
        event.type,
        "missing or unsupported incomplete reason",
      );
    }
    const tokenUsage = normalizeOpenAIResponsesUsage(
      event.response.usage,
      report,
    );
    return {
      finishReason:
        status === "completed"
          ? this.callIds.size > 0
            ? "tool_calls"
            : "stop"
          : reason === "max_output_tokens"
            ? "length"
            : "content_filter",
      rawFinishReason: status === "completed" ? "completed" : reason,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(status === "completed" && this.nativeRequired
        ? {
            nativeOutput: {
              protocol: "openai-responses" as const,
              items: nativeItems,
            },
          }
        : {}),
      ...(reasoningTokenCount(event.response.usage) === undefined
        ? {}
        : { reasoningTokens: reasoningTokenCount(event.response.usage) }),
    };
  }
}

export async function* mapResponsesStream(
  stream: AsyncIterable<ResponseStreamEvent>,
  report?: TokenUsageDiagnosticReporter,
  signal?: AbortSignal,
): AsyncGenerator<InterfaceProviderStreamEvent> {
  const state = new ResponsesStreamState();
  // Releasing the terminal only at EOF prevents a later event from authorizing tools.
  let terminal: InterfaceProviderStreamEvent | undefined;
  for await (const event of stream) {
    if (signal?.aborted) throw new APIUserAbortError();
    check(isObject(event), "stream", "event must be an object");
    const eventType = event.type;
    check(terminal === undefined, event.type, "event follows terminal");
    let mapped: InterfaceProviderStreamEvent | undefined;
    switch (event.type) {
      case "response.created":
        state.validateResponse(
          event.response,
          event.type,
          event.response.status === "queued" ? "queued" : "in_progress",
        );
        break;
      case "response.in_progress":
        state.validateResponse(event.response, event.type, "in_progress");
        break;
      case "response.queued":
        state.validateResponse(event.response, event.type, "queued");
        break;
      case "response.output_item.added":
        mapped = state.add(event);
        break;
      case "response.output_item.done":
        state.done(event);
        break;
      case "response.content_part.added":
        state.addPart(event);
        break;
      case "response.content_part.done":
        state.partDone(event);
        break;
      case "response.output_text.delta":
        mapped = state.textDelta(event);
        break;
      case "response.output_text.done":
        state.textDone(event);
        break;
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        mapped = state.arguments(event);
        break;
      case "response.completed":
      case "response.incomplete":
        terminal = state.terminal(event, report);
        break;
      case "error":
      case "response.failed":
        throw new Error(`Responses ${event.type}: provider failure`);
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_part.done":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done":
        state.reasoning(event);
        break;
      case "response.refusal.delta":
      case "response.refusal.done":
      case "response.output_text.annotation.added":
      case "response.audio.delta":
      case "response.audio.done":
      case "response.audio.transcript.delta":
      case "response.audio.transcript.done":
      case "response.code_interpreter_call_code.delta":
      case "response.code_interpreter_call_code.done":
      case "response.code_interpreter_call.in_progress":
      case "response.code_interpreter_call.interpreting":
      case "response.code_interpreter_call.completed":
      case "response.file_search_call.in_progress":
      case "response.file_search_call.searching":
      case "response.file_search_call.completed":
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching":
      case "response.web_search_call.completed":
      case "response.image_generation_call.in_progress":
      case "response.image_generation_call.generating":
      case "response.image_generation_call.partial_image":
      case "response.image_generation_call.completed":
      case "response.custom_tool_call_input.delta":
      case "response.custom_tool_call_input.done":
      case "response.mcp_call_arguments.delta":
      case "response.mcp_call_arguments.done":
      case "response.mcp_call.in_progress":
      case "response.mcp_call.completed":
      case "response.mcp_call.failed":
      case "response.mcp_list_tools.in_progress":
      case "response.mcp_list_tools.completed":
      case "response.mcp_list_tools.failed":
      case "response.shell_call_command.added":
      case "response.shell_call_command.delta":
      case "response.shell_call_command.done":
      case "response.shell_call_output_content.delta":
      case "response.shell_call_output_content.done":
        throw new Error(`Responses ${event.type}: unsupported event`);
      default:
        unknownMember(event, eventType);
    }
    if (mapped !== undefined) yield mapped;
  }
  if (signal?.aborted) throw new APIUserAbortError();
  check(terminal !== undefined, "stream", "missing terminal event");
  yield terminal;
}
