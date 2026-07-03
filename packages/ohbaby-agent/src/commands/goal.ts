import type { UiCommandInvocation } from "ohbaby-sdk";
import { formatGoalStatusLines, GoalError } from "../goals/index.js";
import type { GoalSnapshot } from "../goals/index.js";
import type {
  CommandGoalBackend,
  CommandHandler,
  CommandRunContext,
  CommandServiceOptions,
  GoalCommandBudgetLimits,
} from "./types.js";

function statusText(snapshot: GoalSnapshot | null): string {
  if (snapshot === null) return "No goal is currently set.";
  return formatGoalStatusLines(snapshot).join("\n");
}

function parseBudgetFlags(argv: readonly string[]): GoalCommandBudgetLimits {
  const limits: {
    turnBudget?: number;
    tokenBudget?: number;
    wallClockBudgetMs?: number;
  } = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv.at(index);
    const raw = argv.at(index + 1);
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new GoalError(
        "invalid_transition",
        `Invalid budget value for ${flag ?? "<missing>"}: expected a positive integer.`,
      );
    }
    switch (flag) {
      case "--turns":
        limits.turnBudget = value;
        break;
      case "--tokens":
        limits.tokenBudget = value;
        break;
      case "--minutes":
        limits.wallClockBudgetMs = value * 60_000;
        break;
      default:
        throw new GoalError(
          "invalid_transition",
          `Unknown budget flag: ${flag ?? "<missing>"}. Use --turns, --tokens, --minutes.`,
        );
    }
  }
  if (Object.keys(limits).length === 0) {
    throw new GoalError(
      "invalid_transition",
      "Usage: /goal budget [--turns N] [--tokens N] [--minutes N]",
    );
  }
  return limits;
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
    const limits = parseBudgetFlags(argv.slice(1));
    emitText(statusText(await goals.setBudget(sessionId, limits)));
    return;
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
