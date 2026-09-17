import type { InterfaceProviderKind, ReasoningCapabilities } from "./types.js";
import { buildModelMetadataUrl } from "./context-window-probe.js";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const INVALID_EFFORT = "ohbaby-invalid-effort";
const PROBE_TIMEOUT_MS = 30_000;

interface ProbeInput {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly model: string;
  readonly provider: string;
  readonly signal?: AbortSignal;
}

/** A rejected impossible strength is the control for gateways that ignore unknown fields. */
export async function probeReasoningCapabilities(
  input: ProbeInput,
): Promise<ReasoningCapabilities | undefined> {
  const wire =
    input.interfaceProvider === "anthropic"
      ? "anthropic-adaptive"
      : input.interfaceProvider === "openai-responses" ||
          input.provider === "openai"
        ? "openai"
        : "reasoning";
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
  const cancel = (): void => {
    controller.abort();
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const timeout = setTimeout(cancel, PROBE_TIMEOUT_MS);
  const request = async (effort: string): Promise<number | undefined> => {
    if (controller.signal.aborted) return undefined;
    const reasoning =
      effort === "off"
        ? wire === "reasoning"
          ? { reasoning: { enabled: false } }
          : wire === "openai"
            ? input.interfaceProvider === "openai-compatible"
              ? { reasoning_effort: "none" }
              : { reasoning: { effort: "none" } }
            : { thinking: { type: "disabled" } }
        : wire === "reasoning"
          ? { reasoning: { enabled: true, effort } }
          : wire === "openai"
            ? input.interfaceProvider === "openai-compatible"
              ? { reasoning_effort: effort }
              : { reasoning: { effort } }
            : { thinking: { type: "adaptive" }, output_config: { effort } };
    const outputLimit =
      input.interfaceProvider === "openai-compatible" &&
      input.provider === "openai"
        ? { max_completion_tokens: 32 }
        : input.interfaceProvider === "openai-responses"
          ? { max_output_tokens: 32 }
          : { max_tokens: 32 };
    const body =
      input.interfaceProvider === "openai-responses"
        ? {
            model: input.model,
            input: "Reply OK.",
            ...outputLimit,
            ...reasoning,
          }
        : {
            model: input.model,
            messages: [{ role: "user", content: "Reply OK." }],
            ...outputLimit,
            ...reasoning,
          };
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.interfaceProvider === "anthropic"
            ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${input.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      await response.body?.cancel();
      return response.status;
    } catch {
      return undefined;
    }
  };
  try {
    const invalidStatus = await request(INVALID_EFFORT);
    if (
      invalidStatus === undefined ||
      invalidStatus < 400 ||
      invalidStatus >= 500 ||
      invalidStatus === 401 ||
      invalidStatus === 403 ||
      invalidStatus === 429
    )
      return undefined;
    const efforts: string[] = [];
    for (let index = 0; index < EFFORTS.length; index += 2) {
      const batch = EFFORTS.slice(index, index + 2);
      const statuses = await Promise.all(batch.map(request));
      batch.forEach((effort, offset) => {
        const status = statuses[offset];
        if (status !== undefined && status >= 200 && status < 300)
          efforts.push(effort);
      });
      if (controller.signal.aborted) return undefined;
    }
    if (efforts.length === 0) return undefined;
    const disabledStatus = await request("off");
    return {
      mode: "effort",
      wire,
      supportsDisabled:
        disabledStatus !== undefined &&
        disabledStatus >= 200 &&
        disabledStatus < 300,
      efforts,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", cancel);
  }
}
