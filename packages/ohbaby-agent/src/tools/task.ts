import fs from "node:fs";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { withToolAdmission } from "../core/tool-scheduler/tool-admission.js";
import { shellJobStatusLine, boundedText } from "../shell-jobs/notice.js";
import {
  SHELL_JOB_STATUSES,
  type ShellJobStatus,
} from "../shell-jobs/query.js";
import type {
  ShellJobRegistry,
  ShellJobSnapshot,
} from "../shell-jobs/registry.js";
import {
  getRequiredNonEmptyStringParam,
  ToolParameterError,
} from "./utils/params.js";

const ACTION_FIELDS = {
  list: ["include_finished", "status", "limit", "cursor"],
  output: ["job_id", "block", "wait_ms"],
  stop: ["job_id"],
} as const;
type TaskInput =
  | {
      action: "list";
      includeFinished?: boolean;
      status?: ShellJobStatus;
      limit: number;
      cursor?: string;
    }
  | { action: "output"; jobId: string; block: boolean; waitMs: number }
  | { action: "stop"; jobId: string };

function booleanParam(
  params: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = params[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new ToolParameterError(`Expected "${name}" to be a boolean.`);
  return value;
}
function integerParam(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = params[name];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new ToolParameterError(
      `Expected "${name}" to be an integer from 1 to ${String(maximum)}.`,
    );
  return value;
}
function taskInput(params: Record<string, unknown>): TaskInput {
  const action = params.action;
  if (action !== "list" && action !== "output" && action !== "stop")
    throw new ToolParameterError(
      'Expected "action" to be list, output or stop.',
    );
  const fields: readonly string[] = ACTION_FIELDS[action];
  for (const field of Object.keys(params))
    if (field !== "action" && !fields.includes(field))
      throw new ToolParameterError(
        `Parameter "${field}" is not supported for task action "${action}".`,
      );
  if (action === "list") {
    const status = params.status;
    if (
      status !== undefined &&
      !SHELL_JOB_STATUSES.some((known) => known === status)
    )
      throw new ToolParameterError(
        `Expected "status" to be one of: ${SHELL_JOB_STATUSES.join(", ")}.`,
      );
    if (status !== undefined && params.include_finished !== undefined)
      throw new ToolParameterError(
        'Use either "status" or "include_finished", not both.',
      );
    return {
      action,
      includeFinished:
        status === undefined
          ? booleanParam(params, "include_finished", true)
          : undefined,
      status: status as ShellJobStatus | undefined,
      limit: integerParam(params, "limit", 20, 100),
      cursor:
        params.cursor === undefined
          ? undefined
          : getRequiredNonEmptyStringParam(params, "cursor"),
    };
  }
  const jobId = getRequiredNonEmptyStringParam(params, "job_id");
  if (action === "stop") return { action, jobId };
  const block = booleanParam(params, "block", false);
  if (params.wait_ms !== undefined && !block)
    throw new ToolParameterError('"wait_ms" requires "block": true.');
  return {
    action,
    jobId,
    block,
    waitMs: integerParam(params, "wait_ms", 30_000, 600_000),
  };
}

function snapshotResult(
  snapshot: ShellJobSnapshot,
  action: "output" | "stop",
): ToolExecutionResult {
  const meta = snapshot.metadata;
  const file = meta.outputFile as
    | { status?: string; path?: string }
    | undefined;
  let outputPath: string | null = null;
  if (file?.status !== "unavailable" && file?.path) {
    try {
      if (fs.statSync(file.path).isFile()) outputPath = file.path;
    } catch {
      /* The saved log may no longer exist. */
    }
  }
  const line = shellJobStatusLine({
    status: snapshot.status,
    outputBytes: typeof meta.outputBytes === "number" ? meta.outputBytes : null,
    outputComplete:
      typeof meta.outputComplete === "boolean" ? meta.outputComplete : null,
    outputCheckpointAt:
      typeof meta.outputCheckpointAt === "number"
        ? meta.outputCheckpointAt
        : null,
    outputPath,
    stopReason: typeof meta.stopReason === "string" ? meta.stopReason : null,
    elapsedMs:
      typeof meta.startedAt === "number"
        ? Math.max(
            0,
            (typeof meta.endedAt === "number" ? meta.endedAt : Date.now()) -
              meta.startedAt,
          )
        : null,
    cleanup: typeof meta.cleanup === "string" ? meta.cleanup : null,
  });
  const operation =
    action === "stop"
      ? meta.stopResult === "tracking_released"
        ? "Tracking was released; no stop signal was sent. "
        : meta.stopResult === "already_finished"
          ? "The task has already finished. "
          : meta.stopResult === "cleanup_pending"
            ? "Cleanup is still unresolved; no new stop request was accepted. "
            : "Stop requested; cleanup is reported below. "
      : meta.waitReason === "timeout"
        ? "Read wait expired; the task's execution deadline is unchanged. "
        : meta.waitReason === "steer"
          ? "Read wait interrupted by new user input. "
          : "";
  const description =
    typeof meta.description === "string"
      ? meta.description
      : typeof meta.command === "string"
        ? meta.command
        : "Shell job";
  return {
    metadata: { ...meta, taskAction: action },
    output: `${operation}${snapshot.jobId} (${boundedText(description, 256)}): ${line}\n${snapshot.output}`,
  };
}

export function createTaskTool(registry: ShellJobRegistry): Tool {
  return withToolAdmission(
    {
      name: "task",
      source: "builtin",
      category: "subagent-control",
      timeoutOwner: "tool",
      description:
        "Manage your shell jobs: list, output or stop. Start commands with bash. output returns status and bounded tail; block=true waits up to wait_ms (default 30000, maximum 600000), without changing the job's execution timeout. list supports status or include_finished, and cursor pagination. Completion is reported automatically; do not poll or sleep for it. This tool does not manage agents.",
      parametersJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["list", "output", "stop"] },
          job_id: { type: "string" },
          block: { type: "boolean" },
          wait_ms: { type: "integer", minimum: 1, maximum: 600_000 },
          include_finished: { type: "boolean" },
          status: { type: "string", enum: [...SHELL_JOB_STATUSES] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string" },
        },
      },
      async execute(params, context): Promise<ToolExecutionResult> {
        const input = taskInput(params);
        context.signal.throwIfAborted();
        switch (input.action) {
          case "list": {
            const page = await registry.list(
              context.sessionId,
              { ...input, signal: context.signal },
              context.contextScopeId,
            );
            return {
              metadata: { taskAction: "list", ...page },
              output: [
                `${String(page.jobs.length)} of ${String(page.filteredCount)} matching shell jobs; pending starts: ${String(page.pendingStartCount)}.${page.hasMore ? " More available; use nextCursor with the same filters." : ""}`,
                ...page.jobs.map(
                  (job) =>
                    `${job.jobId}: ${job.status}, cleanup=${job.cleanup ?? "pending"} — ${boundedText(job.description ?? job.command, 128)}`,
                ),
              ].join("\n"),
            };
          }
          case "output":
            return snapshotResult(
              await registry.output(
                input.jobId,
                context.sessionId,
                {
                  block: input.block,
                  waitMs: input.waitMs,
                  signal: context.signal,
                  subscribeSteer: context.subscribeSteer,
                },
                context.contextScopeId,
              ),
              "output",
            );
          case "stop":
            return snapshotResult(
              await registry.kill(
                input.jobId,
                context.sessionId,
                context.contextScopeId,
              ),
              "stop",
            );
        }
      },
    },
    {
      shellJobController: registry,
      capacity: "control",
      category: (params) =>
        params.action === "list" || params.action === "output"
          ? "readonly"
          : "subagent-control",
      legacyDenyToolName: (params) =>
        ({ list: "task_list", output: "task_output", stop: "task_kill" })[
          taskInput(params).action
        ],
      plan: (params) => {
        taskInput(params);
        return [];
      },
    },
  );
}
