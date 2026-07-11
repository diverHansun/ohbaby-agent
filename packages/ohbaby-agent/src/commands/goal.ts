import type { UiCommandInvocation } from "ohbaby-sdk";
import { formatGoalStatusLines, GoalError } from "../goals/index.js";
import type { GoalSnapshot } from "../goals/index.js";
import type {
  CommandGoalBackend,
  CommandHandler,
  CommandRunContext,
  CommandServiceOptions,
} from "./types.js";

function statusText(snapshot: GoalSnapshot | null): string {
  if (snapshot === null) return "No goal is currently set.";
  return formatGoalStatusLines(snapshot).join("\n");
}

async function runGoalCommand(
  goals: CommandGoalBackend,
  invocation: UiCommandInvocation,
  context: CommandRunContext,
): Promise<void> {
  const argv = invocation.argv;
  const head = argv.at(0);
  const emitText = (text: string): void => {
    context.emitOutput({ kind: "text", text });
  };
  const sessionId = await goals.resolveSessionId(
    invocation.sessionId ?? context.sessionId,
  );
  if (sessionId === undefined) {
    if (head === undefined || head === "status") {
      emitText(statusText(null));
      return;
    }
    context.fail({
      code: "no_session",
      message: "No active session for goal commands.",
      recoverable: true,
    });
    return;
  }

  if (head === undefined || head === "status") {
    emitText(statusText(await goals.status(sessionId)));
    return;
  }
  if (head === "pause") {
    emitText(statusText(await goals.pause(sessionId)));
    return;
  }
  if (head === "resume") {
    emitText(statusText(await goals.resume(sessionId)));
    return;
  }
  if (head === "cancel") {
    await goals.cancel(sessionId);
    emitText("Goal cancelled.");
    return;
  }
  if (head === "replace") {
    const objective = argv.slice(1).join(" ").trim();
    emitText(statusText(await goals.replace(sessionId, objective)));
    return;
  }
  if (head === "budget") {
    throw new GoalError(
      "invalid_transition",
      "The /goal budget subcommand is not available. State any hard limit in natural language so the main agent can record it.",
    );
  }
  // 首 token 非保留子命令 → 整段视为 objective 创建 goal
  const objective = argv.join(" ").trim();
  const snapshot = await goals.create(sessionId, { objective });
  emitText(
    `Goal started (${snapshot.status}). Use /goal status to inspect, /goal pause|cancel to control.\n${statusText(snapshot)}`,
  );
}

export function createGoalCommandHandler(
  options: Pick<CommandServiceOptions, "goals">,
): CommandHandler {
  return {
    id: "goal",
    async execute(invocation, context): Promise<void> {
      const goals = options.goals;
      if (goals === undefined) {
        context.fail({
          code: "goal_backend_unavailable",
          message: "Goal backend is not configured for this surface.",
          recoverable: false,
        });
        return;
      }
      try {
        await runGoalCommand(goals, invocation, context);
      } catch (error) {
        if (error instanceof GoalError) {
          context.fail({
            code: error.code,
            message: error.message,
            recoverable: true,
          });
          return;
        }
        context.fail({
          code: "goal_command_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      }
    },
  };
}
