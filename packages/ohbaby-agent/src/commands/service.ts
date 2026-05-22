import type {
  UiCommandCatalog,
  UiCommandInvocation,
  UiCommandSpec,
} from "ohbaby-sdk";
import {
  buildCommandCatalog,
  filterCommandCatalogBySurface,
  validateUniqueAliases,
} from "./catalog.js";
import { CommandsEvent } from "./events.js";
import { createCommandRunContext } from "./run-context.js";
import { createBuiltinHandlers } from "./builtin.js";
import type { CommandSkillSummary } from "./types.js";
import type { CommandService, CommandServiceOptions } from "./types.js";

const SKILL_COMMAND_PREFIX = "skill.";
const SKILL_COMMAND_SURFACES = ["tui", "stdout", "headless"] as const;

function createDefaultCommandRunId(): () => string {
  let next = 1;
  return () => {
    const id = `command_${String(next)}`;
    next += 1;
    return id;
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function skillCommandId(name: string): string {
  return `${SKILL_COMMAND_PREFIX}${name}`;
}

function isSkillCommandId(commandId: string): boolean {
  return commandId.startsWith(SKILL_COMMAND_PREFIX);
}

function skillNameFromCommandId(commandId: string): string {
  return commandId.slice(SKILL_COMMAND_PREFIX.length);
}

function skillToCommand(skill: CommandSkillSummary): UiCommandSpec {
  return {
    acceptsArguments: true,
    argumentMode: "raw",
    category: "skill",
    description: skill.description,
    id: skillCommandId(skill.name),
    path: [skill.name],
    source: "skill",
    surfaces: SKILL_COMMAND_SURFACES,
  } as const;
}

async function buildCatalog(
  options: CommandServiceOptions,
): Promise<UiCommandCatalog> {
  const skillCommands = (await options.skills?.listUserInvocable())?.map(
    skillToCommand,
  );
  const catalog = buildCommandCatalog({
    extraCommands: [...(options.extraCommands ?? []), ...(skillCommands ?? [])],
  });
  validateUniqueAliases(catalog.commands);
  return catalog;
}

function formatSkillPrompt(skillPrompt: string, rawArgs: string): string {
  const trimmedArgs = rawArgs.trim();
  if (trimmedArgs === "") {
    return skillPrompt;
  }
  return `${skillPrompt.trim()}\n\nUser request:\n${trimmedArgs}`;
}

async function executeSkillCommand(
  options: CommandServiceOptions,
  invocation: UiCommandInvocation,
  context: ReturnType<typeof createCommandRunContext>,
): Promise<void> {
  if (!options.skills) {
    context.fail({
      code: "SKILL_COMMAND_UNAVAILABLE",
      message: "Skill commands are not available in this backend",
      recoverable: true,
    });
    return;
  }
  const skillName = skillNameFromCommandId(invocation.commandId);
  const prompt = formatSkillPrompt(
    await options.skills.loadPrompt(skillName),
    invocation.rawArgs,
  );
  if (!options.submitPrompt) {
    context.emitOutput({ kind: "markdown", markdown: prompt });
    return;
  }
  await options.submitPrompt(prompt, { sessionId: invocation.sessionId });
  context.emitAction({
    kind: "skill.submitted",
    data: { skill: skillName },
  });
}

export function createCommandService(
  options: CommandServiceOptions,
): CommandService {
  const handlers = createBuiltinHandlers(options);
  for (const handler of options.extraHandlers ?? []) {
    handlers.set(handler.id, handler);
  }
  const createCommandRunId =
    options.createCommandRunId ?? createDefaultCommandRunId();
  const now = options.now ?? Date.now;

  return {
    async listCommands(query): Promise<UiCommandCatalog> {
      return filterCommandCatalogBySurface(
        await buildCatalog(options),
        query.surface,
      );
    },

    async executeCommand(invocation: UiCommandInvocation): Promise<void> {
      const commandRunId = createCommandRunId();
      const context = createCommandRunContext({
        commandRunId,
        clientInvocationId: invocation.clientInvocationId,
        sessionId: invocation.sessionId,
        surface: invocation.surface,
        options,
      });

      options.bus.publish(CommandsEvent.Started, {
        commandRunId,
        clientInvocationId: invocation.clientInvocationId,
        commandId: invocation.commandId,
        path: [...invocation.path],
        surface: invocation.surface,
        sessionId: invocation.sessionId,
        timestamp: now(),
      });

      const handler = handlers.get(invocation.commandId);
      if (!handler) {
        if (isSkillCommandId(invocation.commandId)) {
          try {
            await executeSkillCommand(options, invocation, context);
          } catch (error) {
            context.fail({
              code: "EXECUTION_ERROR",
              message: getErrorMessage(error),
              recoverable: true,
            });
          }
          return;
        }
        context.fail({
          code: "COMMAND_NOT_FOUND",
          message: `Command not found: ${invocation.commandId}`,
          recoverable: true,
        });
        return;
      }

      try {
        await handler.execute(invocation, context);
      } catch (error) {
        context.fail({
          code: "EXECUTION_ERROR",
          message: getErrorMessage(error),
          recoverable: true,
        });
      }
    },

    abortCommandRun(commandRunId: string, reason = "aborted"): number {
      return (
        options.interactionBroker?.abortByCommandRun?.(commandRunId, reason) ??
        0
      );
    },
  };
}
