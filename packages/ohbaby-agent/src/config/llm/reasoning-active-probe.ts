import {
  normalizedEndpoint,
  type InterfaceProviderKind,
  type ReasoningCapabilities,
} from "ohbaby-llm";
import { buildModelMetadataUrl } from "./context-window-probe.js";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const INVALID_EFFORT = "ohbaby-invalid-effort";
const PROBE_TIMEOUT_MS = 60_000;

interface ProbeInput {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly model: string;
  readonly provider: string;
  readonly signal?: AbortSignal;
}
export type ReasoningProbeReason =
  | "authentication"
  | "rate-limit"
  | "http-error"
  | "timeout"
  | "cancelled"
  | "network-error"
  | "ignored-reasoning"
  | "unsupported-efforts";
export interface ReasoningProbeResult {
  readonly reasoningCapabilities?: ReasoningCapabilities;
  readonly reasoningReason?: ReasoningProbeReason;
}
type ProbeWire = "openai" | "anthropic-adaptive";
type RequestResult = "accepted" | "unsupported" | ReasoningProbeReason;

/** A rejected impossible strength is the control for gateways that ignore unknown fields. */
export async function probeReasoningCapabilities(
  input: ProbeInput,
): Promise<ReasoningProbeResult> {
  const officialOpenAI =
    normalizedEndpoint(input.baseUrl) === "https://api.openai.com/v1";
  const endpoint = new URL(buildModelMetadataUrl(input));
  const operationPath =
    input.interfaceProvider === "anthropic"
      ? "/messages"
      : input.interfaceProvider === "openai-responses"
        ? "/responses"
        : "/chat/completions";
  endpoint.pathname =
    endpoint.pathname.replace(/\/models\/?$/u, "") + operationPath;
  const controller = new AbortController();
  const state = { timedOut: false };
  const cancel = (): void => {
    controller.abort();
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const timeout = setTimeout(() => {
    state.timedOut = true;
    cancel();
  }, PROBE_TIMEOUT_MS);
  const parameters = { type: "object", properties: {}, required: [] };
  const tools =
    input.interfaceProvider === "anthropic"
      ? [{ name: "noop", input_schema: parameters }]
      : input.interfaceProvider === "openai-responses"
        ? [{ type: "function", name: "noop", parameters }]
        : [{ type: "function", function: { name: "noop", parameters } }];
  // One wire per protocol: Chat uses the standard reasoning_effort field.
  const wire: ProbeWire =
    input.interfaceProvider === "anthropic" ? "anthropic-adaptive" : "openai";
  const request = async (effort: string): Promise<RequestResult> => {
    const strength = effort === "off" ? "none" : effort;
    const reasoning =
      wire === "anthropic-adaptive"
        ? effort === "off"
          ? { thinking: { type: "disabled" } }
          : { thinking: { type: "adaptive" }, output_config: { effort } }
        : input.interfaceProvider === "openai-compatible"
          ? { reasoning_effort: strength }
          : { reasoning: { effort: strength } };
    const outputLimit =
      input.interfaceProvider === "openai-compatible" && officialOpenAI
        ? { max_completion_tokens: 32 }
        : input.interfaceProvider === "openai-responses"
          ? { max_output_tokens: 32 }
          : { max_tokens: 32 };
    const body = {
      model: input.model,
      ...(input.interfaceProvider === "openai-responses"
        ? { input: "Reply OK." }
        : { messages: [{ role: "user", content: "Reply OK." }] }),
      ...outputLimit,
      ...reasoning,
      tools,
    };
    try {
      if (controller.signal.aborted) throw new Error("Aborted");
      const response = await abortable(
        fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.interfaceProvider === "anthropic"
              ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
              : { authorization: `Bearer ${input.apiKey}` }),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "manual",
        }),
        controller.signal,
      );
      await abortable(
        Promise.resolve(response.body?.cancel()),
        controller.signal,
      );
      if (response.status >= 200 && response.status < 300) return "accepted";
      if (response.status === 400 || response.status === 422)
        return "unsupported";
      if (response.status === 401 || response.status === 403)
        return "authentication";
      return response.status === 429 ? "rate-limit" : "http-error";
    } catch {
      return state.timedOut
        ? "timeout"
        : input.signal?.aborted
          ? "cancelled"
          : "network-error";
    }
  };
  try {
    const control = await request(INVALID_EFFORT);
    if (control === "accepted") return { reasoningReason: "ignored-reasoning" };
    if (control !== "unsupported") return { reasoningReason: control };
    const candidates =
      wire === "anthropic-adaptive" ? EFFORTS.slice(1) : EFFORTS;
    const results = await Promise.all(
      [...candidates, "off"].map((effort) => request(effort)),
    );
    const failure = results.find(
      (result) => result !== "accepted" && result !== "unsupported",
    );
    if (failure) return { reasoningReason: failure };
    const efforts = candidates.filter(
      (_effort, index) => results[index] === "accepted",
    );
    if (efforts.length === 0) return { reasoningReason: "unsupported-efforts" };
    return {
      reasoningCapabilities: {
        mode: "effort",
        wire,
        supportsDisabled: results.at(-1) === "accepted",
        efforts,
      },
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", cancel);
  }
}

/** Enforce the overall deadline even for transports that fail to reject on abort. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Aborted");
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = (): void => {
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
