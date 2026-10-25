import { SUMMARY_AGENT_NAME } from "../../core/context/constants.js";
import {
  isContextSummaryPart,
  isModelContextPart,
} from "../../core/message/origin.js";
import { readTokenUsageMetadata } from "../../core/message/token-usage-metadata.js";
import type { MessageWithParts, Part } from "../../core/message/types.js";
import { SessionExportError } from "./errors.js";
import type {
  ExportDependencies,
  ExportDocument,
  ExportMessage,
  ExportPart,
  ExportUsage,
} from "./types.js";

function sumUsage(values: readonly ExportUsage[]): ExportUsage | undefined {
  if (values.length === 0) return undefined;
  const input = values.reduce((sum, usage) => sum + usage.input, 0);
  const output = values.reduce((sum, usage) => sum + usage.output, 0);
  return {
    input,
    output,
    total: input + output,
    ...(values.every((usage) => usage.reasoning !== undefined)
      ? {
          reasoning: values.reduce(
            (sum, usage) => sum + (usage.reasoning ?? 0),
            0,
          ),
        }
      : {}),
  };
}

function readUsage(value: unknown): ExportUsage | undefined {
  const usage = readTokenUsageMetadata({ tokenUsage: value });
  return (
    usage && {
      input: usage.inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
      ...(usage.reasoningTokens === undefined
        ? {}
        : { reasoning: usage.reasoningTokens }),
    }
  );
}

function messageUsage(message: MessageWithParts): {
  usage?: ExportUsage;
  usageComplete: boolean;
} {
  const requests =
    message.info.role === "assistant" ? message.info.modelRequests : undefined;
  const values = requests?.length
    ? requests.map((request) => readUsage(request.usage))
    : [
        message.parts
          .map((part) => readUsage(part.metadata?.tokenUsage))
          .find((value) => value !== undefined),
      ];
  const usage = sumUsage(
    values.filter((value): value is ExportUsage => value !== undefined),
  );
  return {
    ...(usage ? { usage } : {}),
    usageComplete: values.every((value) => value !== undefined),
  };
}

function exportPart(part: Part): ExportPart | undefined {
  if (isModelContextPart(part)) return undefined;
  const compacted =
    part.time?.compacted === undefined ? {} : { compacted: true as const };
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text:
          typeof part.metadata?.displayText === "string"
            ? part.metadata.displayText
            : part.text,
        ...compacted,
      };
    case "reasoning":
      return {
        type: "reasoning",
        text: part.text,
        ...(part.endReason === undefined ? {} : { endReason: part.endReason }),
        ...compacted,
      };
    case "tool": {
      if (part.tool === "select_tools" || part.tool === "todo_read")
        return undefined;
      const state = part.state;
      return {
        type: "tool",
        tool: part.tool,
        callId: part.callId,
        status: state.status,
        input: structuredClone(state.input),
        ...("output" in state && state.output !== undefined
          ? { output: state.output }
          : {}),
        ...("error" in state ? { error: state.error } : {}),
        ...compacted,
      };
    }
    default:
      return undefined;
  }
}

function sourceOrder(part: Part): number {
  const value = part.metadata?.sourceOrder;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : part.orderIndex;
}

function exportMessage(message: MessageWithParts): ExportMessage | undefined {
  const parts = [...message.parts]
    .sort((a, b) => sourceOrder(a) - sourceOrder(b))
    .map(exportPart)
    .filter((part): part is ExportPart => part !== undefined);
  if (parts.length === 0) return undefined;
  const info = message.info;
  const runtimeInput =
    info.runtimeInput?.kind === "user-steer"
      ? undefined
      : info.runtimeInput?.kind;
  const assistant = info.role === "assistant";
  const kind =
    info.role === "system"
      ? info.kind
      : assistant &&
          info.agent === SUMMARY_AGENT_NAME &&
          message.parts.some(isContextSummaryPart)
        ? "compaction-summary"
        : undefined;
  return {
    type: "message",
    id: info.id,
    role: runtimeInput ? "system" : info.role,
    ...(kind === undefined ? {} : { kind }),
    ...(runtimeInput === undefined ? {} : { runtimeInput }),
    time: {
      created: new Date(info.time.created).toISOString(),
      ...(info.time.completed === undefined
        ? {}
        : { completed: new Date(info.time.completed).toISOString() }),
    },
    ...(assistant
      ? {
          ...(info.providerId === undefined && info.modelId === undefined
            ? {}
            : {
                model: {
                  ...(info.providerId === undefined
                    ? {}
                    : { providerId: info.providerId }),
                  ...(info.modelId === undefined
                    ? {}
                    : { modelId: info.modelId }),
                },
              }),
          status:
            info.error?.name === "MessageAbortedError"
              ? ("aborted" as const)
              : info.error
                ? ("error" as const)
                : info.time.completed !== undefined ||
                    kind === "compaction-summary"
                  ? ("completed" as const)
                  : ("running" as const),
          ...(info.finish === undefined ? {} : { finish: info.finish }),
          ...(info.error === undefined
            ? {}
            : {
                error: {
                  name: info.error.name,
                  ...("message" in info.error
                    ? { message: info.error.message }
                    : {}),
                },
              }),
          ...messageUsage(message),
        }
      : {}),
    parts,
  };
}

export async function collectExportDocument(
  deps: ExportDependencies,
  sessionId: string,
  now: Date,
): Promise<ExportDocument> {
  const session = await deps.sessionManager.get(sessionId);
  if (!session)
    throw new SessionExportError("SESSION_NOT_FOUND", "Session not found");
  if (session.isSubagent)
    throw new SessionExportError(
      "SUBAGENT_SESSION",
      "Subagent sessions cannot be exported",
    );
  const source = await deps.messageManager.listBySession(sessionId, {
    contextScopeId: undefined,
  });
  const messages = [...source]
    .sort((a, b) => a.info.time.created - b.info.time.created)
    .map(exportMessage)
    .filter((message): message is ExportMessage => message !== undefined);
  if (messages.length === 0)
    throw new SessionExportError("EMPTY_SESSION", "Nothing to export");
  const assistants = messages.filter(
    (message) => message.usageComplete !== undefined,
  );
  const tokens = sumUsage(
    assistants.flatMap((message) => (message.usage ? [message.usage] : [])),
  );
  return {
    header: {
      type: "session",
      format: "ohbaby.session-export",
      version: 1,
      exportedAt: now.toISOString(),
      app: { name: "ohbaby", version: deps.appVersion },
      session: {
        id: session.id,
        title: session.title,
        projectRoot: session.workingDirectory,
        agent: session.agentName,
        status: session.status,
        createdAt: new Date(session.createdAt).toISOString(),
        updatedAt: new Date(session.updatedAt).toISOString(),
      },
      stats: {
        messageCount: messages.length,
        models: [
          ...new Set(
            messages.flatMap((message) =>
              message.model?.providerId && message.model.modelId
                ? [`${message.model.providerId}/${message.model.modelId}`]
                : [],
            ),
          ),
        ],
        ...(tokens ? { tokens } : {}),
        usageCoverage: {
          known: assistants.filter((message) => message.usageComplete).length,
          unknown: assistants.filter((message) => !message.usageComplete)
            .length,
        },
      },
    },
    messages,
  };
}
