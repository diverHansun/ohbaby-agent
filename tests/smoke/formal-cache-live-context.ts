import type { NativeRealProfile } from "./reasoning-native-harness.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { UiPermissionRequest, UiSnapshot } from "ohbaby-sdk";

/** Profiles for the context migration gate. These are intentionally distinct from old cache probes. */
export const LIVE_CONTEXT_PROFILES: readonly NativeRealProfile[] = [
  {
    id: "zenmux-deepseek-v41-chat",
    model: "deepseek/deepseek-v4.1-flash",
    protocol: "openai-compatible",
    baseUrl: "https://zenmux.ai/api/v1",
    enabledEffort: "high",
    capabilities: {
      mode: "effort",
      wire: "reasoning",
      supportsDisabled: true,
      efforts: ["high", "max"],
      temperature: "unsupported",
    },
    sources: ["https://zenmux.ai/deepseek/deepseek-v4.1-flash"],
  },
  {
    id: "zenmux-gpt56-luna-responses-context",
    model: "openai/gpt-5.6-luna",
    protocol: "openai-responses",
    baseUrl: "https://zenmux.ai/api/v1",
    enabledEffort: "medium",
    capabilities: {
      mode: "effort",
      wire: "openai",
      supportsDisabled: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      temperature: "unsupported",
    },
    sources: ["https://zenmux.ai/openai/gpt-5.6-luna"],
  },
  {
    id: "zenmux-claude-sonnet5-anthropic-context",
    model: "anthropic/claude-sonnet-5",
    protocol: "anthropic",
    baseUrl: "https://zenmux.ai/api/anthropic",
    enabledEffort: "medium",
    capabilities: {
      mode: "effort",
      wire: "anthropic-adaptive",
      supportsDisabled: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      temperature: "unsupported",
    },
    sources: ["https://zenmux.ai/anthropic/claude-sonnet-5"],
  },
];

export type LiveContextPhase =
  | "metadata"
  | "first-read"
  | "continuation"
  | "pre-compaction"
  | "compaction"
  | "post-compaction"
  | "reopen"
  | "post-reopen"
  | "evidence";

/** Never copy upstream messages, prompts or credentials into a failure artifact. */
export function safeLiveContextFailure(
  error: unknown,
  phase: LiveContextPhase,
): { phase: LiveContextPhase; code: string } {
  const code =
    error instanceof Error && error.name === "AssertionError"
      ? "ASSERTION_FAILED"
      : error instanceof Error && error.name === "AbortError"
        ? "TIMEOUT"
        : "LIVE_RUN_FAILED";
  return { phase, code };
}

export interface ControlledReadDecision {
  allowed: boolean;
  toolName: string;
  inputKeys: string[];
  inputSha256: string;
}

/** Permission requests do not include arguments; classify the pending snapshot tool call. */
export function classifyControlledRead(
  call: { name: string; input: Record<string, unknown> } | undefined,
  workdir: string,
  allowedFile: string,
): ControlledReadDecision {
  const input = call?.input ?? {};
  const path = input.file_path;
  const allowed =
    call?.name === "read" &&
    Object.keys(input).length === 1 &&
    typeof path === "string" &&
    resolve(workdir, path) === allowedFile;
  const knownNames = new Set([
    "read",
    "bash",
    "write",
    "edit",
    "glob",
    "grep",
    "skill",
  ]);
  const knownKeys = new Set(["file_path", "command", "offset", "limit"]);
  return {
    allowed,
    toolName: call && knownNames.has(call.name) ? call.name : "unknown",
    inputKeys: Object.keys(input)
      .filter((key) => knownKeys.has(key))
      .sort(),
    inputSha256: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
  };
}

export function decideControlledPermission(
  request: UiPermissionRequest,
  snapshot: UiSnapshot,
  workdir: string,
  allowedFile: string,
): { choiceId: string; decision: ControlledReadDecision } {
  const run = snapshot.runs.find((item) => item.id === request.runId);
  const session = snapshot.sessions.find((item) => item.id === run?.sessionId);
  const pending =
    session?.messages.flatMap((message) =>
      message.parts
        .filter(
          (part) =>
            part.type === "tool-call" &&
            (part.call.status === "pending" || part.call.status === "running"),
        )
        .map((part) => (part.type === "tool-call" ? part.call : undefined)),
    ) ?? [];
  const call = pending.length === 1 ? pending[0] : undefined;
  const decision = classifyControlledRead(call, workdir, allowedFile);
  const choice = decision.allowed
    ? request.choices.find(
        (item) => item.intent === "allow" && item.id === "allow_once",
      )
    : (request.choices.find((item) => item.intent === "deny") ??
      request.choices.find((item) => item.intent === "abort"));
  if (!choice) throw new Error("NO_SAFE_PERMISSION_CHOICE");
  return { choiceId: choice.id, decision };
}

/** Redundant local facts make compaction cut past a native assistant turn. */
export function createCompactionNotes(count: number): string {
  return (
    "\nContext notes (repeated observations of the same facts; summarize them together):\n" +
    Array.from(
      { length: count },
      (_, index) =>
        `Observation ${String(index + 1)}: Project Cedar, release 17, owner Lin. The task is to preserve these facts; all actions are read-only and no files may be changed.`,
    ).join("\n")
  );
}
