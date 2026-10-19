import type { MessageWithParts, ToolPart } from "../../core/message/index.js";
import { escapeReminderValue } from "../../core/message/origin.js";
import { isActivePart } from "../../core/context/filters.js";
import { serializeHistoryMessages } from "../../core/context/serializer.js";
import { slashSkillName } from "../../skill/usage.js";
import type { SkillInfo } from "../../skill/types.js";
import type {
  ReminderBody,
  ReminderContext,
  ReminderProvider,
} from "./index.js";

interface SkillUsageSources {
  getSkill(
    name: string,
  ): Promise<
    Pick<SkillInfo, "userInvocable" | "disableModelInvocation"> | undefined
  >;
  canInvokeSkill(context: ReminderContext): Promise<boolean>;
}

function successfulSkillName(part: ToolPart): string | undefined {
  if (part.tool !== "skill" || part.state.status !== "completed")
    return undefined;
  const metadata = part.state.metadata;
  return metadata?.uiToolSource === "skill" &&
    typeof metadata.name === "string" &&
    metadata.name.trim() !== ""
    ? metadata.name
    : undefined;
}

function latestCompactionId(
  history: readonly MessageWithParts[],
): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    for (const part of history[index].parts) {
      if (
        isActivePart(part) &&
        part.type === "text" &&
        !part.ignored &&
        part.text.trim() !== "" &&
        part.metadata?.kind === "context-summary" &&
        typeof part.metadata.compactionId === "string" &&
        part.metadata.compactionId.trim() !== ""
      )
        return part.metadata.compactionId;
    }
  }
  return undefined;
}

/** Historical successful use is separate from body visibility in this request. */
function recentlyUsed(history: readonly MessageWithParts[]): string[] {
  const names = new Set<string>();
  for (const message of history) {
    for (const part of message.parts) {
      const name =
        message.info.role === "assistant" && part.type === "tool"
          ? successfulSkillName(part)
          : message.info.role === "user" &&
              part.type === "text" &&
              part.text.trim() !== ""
            ? slashSkillName(part)
            : undefined;
      if (name !== undefined) {
        names.delete(name);
        names.add(name);
      }
    }
  }
  return [...names].reverse();
}

function visibleBodies(history: readonly MessageWithParts[]): Set<string> {
  const names = new Set<string>();
  for (const message of history) {
    // Reuse the actual projection: failed assistant tools and uncommitted native
    // owners produce no tool results even if another part remains visible.
    const projected = serializeHistoryMessages([message]);
    const toolCalls = new Set(
      projected.flatMap((result) =>
        result.role === "tool" ? [result.callId] : [],
      ),
    );
    for (const part of message.parts) {
      if (!isActivePart(part)) continue;
      const name =
        message.info.role === "assistant" &&
        part.type === "tool" &&
        toolCalls.has(part.callId) &&
        part.state.status === "completed" &&
        part.state.output.trim() !== ""
          ? successfulSkillName(part)
          : message.info.role === "user" &&
              projected.length > 0 &&
              part.type === "text" &&
              !part.ignored &&
              part.text.trim() !== ""
            ? slashSkillName(part)
            : undefined;
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

export function createSkillUsageReminderProvider(
  sources: SkillUsageSources,
): ReminderProvider {
  return {
    type: "skill-usage",
    kind: "event",
    audience: "both",
    async collect(context): Promise<ReminderBody | undefined> {
      const compactionId = latestCompactionId(context.history);
      if (compactionId === undefined) return undefined;
      const visible = visibleBodies([
        ...context.history,
        ...context.protectedInputs,
      ]);
      const missing = recentlyUsed(context.fullHistory).filter(
        (name) => !visible.has(name),
      );
      if (missing.length === 0) return undefined;
      const canInvoke = await sources.canInvokeSkill(context);
      const lines = await Promise.all(
        missing.slice(0, 20).map(async (name) => {
          const info = await sources.getSkill(name);
          const entries: string[] = [];
          if (info !== undefined && !info.disableModelInvocation && canInvoke)
            entries.push(
              `skill(name=${escapeReminderValue(JSON.stringify(name))})`,
            );
          // User commands target the primary scope. A child cannot reread its body
          // through a user's primary slash command. Do not invent exact /name paths.
          if (info?.userInvocable && !context.isSubagent)
            entries.push("user can reload it with /skills");
          return `- ${escapeReminderValue(name)}: ${entries.length > 0 ? entries.join("; ") : "no currently available reread entry"}`;
        }),
      );
      return {
        key: compactionId,
        text: [
          "Previously used skills whose bodies are absent from the current context. Reread only if you still need to execute that skill:",
          ...lines,
          ...(missing.length > 20
            ? [`${String(missing.length - 20)} omitted.`]
            : []),
        ].join("\n"),
      };
    },
  };
}
