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
import { sanitizeCommandSkillSummary } from "./normalize.js";
import { createCommandRunContext } from "./run-context.js";
import { createBuiltinHandlers } from "./builtin.js";
import type { CommandSkillSummary } from "./types.js";
import type { CommandService, CommandServiceOptions } from "./types.js";

const SKILL_COMMAND_PREFIX = "skill.";
const SKILL_COMMAND_SURFACES = ["tui", "stdout", "headless"] as const;
const RESERVED_EXTERNAL_COMMAND_ROOTS = new Set(["cancel", "mode", "model"]);
const RESERVED_EXTERNAL_COMMAND_PATHS = new Set([
  "permission/default",
  "permission/full-access",
]);

function commandPathKey(path: readonly string[]): string {
  return path.join("/").toLowerCase();
}

function commandPathKeys(command: UiCommandSpec): readonly string[] {
  return [command.path, ...(command.aliases ?? [])].map(commandPathKey);
}

function collectCommandPathKeys(
  commands: readonly UiCommandSpec[],
): Set<string> {
  return new Set(commands.flatMap(commandPathKeys));
}

function isExternalCommandEligible(
  command: UiCommandSpec,
  occupiedPathKeys: ReadonlySet<string>,
): boolean {
  return [command.path, ...(command.aliases ?? [])].every((path) => {
    const pathKey = commandPathKey(path);
    const root = path[0]?.toLowerCase();
    return (
      !RESERVED_EXTERNAL_COMMAND_ROOTS.has(root) &&
      !RESERVED_EXTERNAL_COMMAND_PATHS.has(pathKey) &&
      !occupiedPathKeys.has(pathKey)
    );
  });
}

function selectAcceptedExtraCommands(
  extraCommands: readonly UiCommandSpec[],
): readonly UiCommandSpec[] {
  const builtinCatalog = buildCommandCatalog();
  const builtinIds = new Set(
    builtinCatalog.commands.map((command) => command.id),
  );
  const builtinPathKeys = collectCommandPathKeys(builtinCatalog.commands);
  const accepted = extraCommands.filter(
    (command) =>
      !builtinIds.has(command.id) &&
      isExternalCommandEligible(command, builtinPathKeys),
  );
  validateUniqueAliases([...builtinCatalog.commands, ...accepted]);
  const acceptedIds = new Set<string>();
  for (const command of accepted) {
    if (acceptedIds.has(command.id)) {
      throw new Error(`Duplicate command id: ${command.id}`);
    }
    acceptedIds.add(command.id);
  }
  return accepted;
}

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

interface CommandProjection {
  readonly catalog: UiCommandCatalog;
  readonly slashInvocableSkills: readonly CommandSkillSummary[];
}

async function buildCommandProjection(
  options: CommandServiceOptions,
  acceptedExtraCommands: readonly UiCommandSpec[],
): Promise<CommandProjection> {
  const builtinCatalog = buildCommandCatalog();
  const occupiedPathKeys = collectCommandPathKeys([
    ...builtinCatalog.commands,
    ...acceptedExtraCommands,
  ]);
  const occupiedCommandIds = new Set(
    [...builtinCatalog.commands, ...acceptedExtraCommands].map(
      (command) => command.id,
    ),
  );
  const rawSkills = await (options.skills?.listUserInvocable() ?? []);
  const sanitizedSkills = rawSkills
    .map(sanitizeCommandSkillSummary)
    .filter((skill): skill is CommandSkillSummary => skill !== null);
  const slashInvocableSkills: CommandSkillSummary[] = [];
  const skillCommands: UiCommandSpec[] = [];
  for (const skill of sanitizedSkills) {
    const command = skillToCommand(skill);
    if (
      occupiedCommandIds.has(command.id) ||
      !isExternalCommandEligible(command, occupiedPathKeys)
    ) {
      continue;
    }
    slashInvocableSkills.push(skill);
    skillCommands.push(command);
    for (const pathKey of commandPathKeys(command)) {
      occupiedPathKeys.add(pathKey);
    }
    occupiedCommandIds.add(command.id);
  }
  return {
    catalog: buildCommandCatalog({
      extraCommands: [...acceptedExtraCommands, ...skillCommands],
    }),
    slashInvocableSkills,
  };
}

async function buildCatalog(
  options: CommandServiceOptions,
  acceptedExtraCommands: readonly UiCommandSpec[],
): Promise<UiCommandCatalog> {
  return (await buildCommandProjection(options, acceptedExtraCommands)).catalog;
}

async function listSlashInvocableSkills(
  options: CommandServiceOptions,
  acceptedExtraCommands: readonly UiCommandSpec[],
): Promise<readonly CommandSkillSummary[]> {
  return (await buildCommandProjection(options, acceptedExtraCommands))
    .slashInvocableSkills;
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
  if (!options.submitPromptAndWait) {
    context.emitOutput({ kind: "markdown", markdown: prompt });
    return;
  }
  const completion = await options.submitPromptAndWait(prompt, {
    sessionId: invocation.sessionId,
  });
  if (completion.prompt.status !== "succeeded") {
    context.fail({
      code: `SKILL_PROMPT_${completion.prompt.status.toUpperCase()}`,
      message:
        completion.prompt.status === "failed" ||
        completion.prompt.status === "interrupted"
          ? completion.prompt.error.message
          : "Skill prompt was cancelled",
      recoverable: completion.prompt.status !== "interrupted",
    });
    return;
  }
  context.emitAction({
    kind: "skill.submitted",
    data: { skill: skillName },
  });
}

export function createCommandService(
  options: CommandServiceOptions,
): CommandService {
  const acceptedExtraCommands = selectAcceptedExtraCommands(
    options.extraCommands ?? [],
  );
  const acceptedExtraCommandIds = new Set(
    acceptedExtraCommands.map((command) => command.id),
  );
  const handlers = createBuiltinHandlers(options, {
    async listCommands(surface): Promise<UiCommandCatalog> {
      return filterCommandCatalogBySurface(
        await buildCatalog(options, acceptedExtraCommands),
        surface,
      );
    },
    listSlashInvocableSkills(): Promise<readonly CommandSkillSummary[]> {
      return listSlashInvocableSkills(options, acceptedExtraCommands);
    },
  });
  for (const handler of options.extraHandlers ?? []) {
    if (acceptedExtraCommandIds.has(handler.id)) {
      handlers.set(handler.id, handler);
    }
  }
  const createCommandRunId =
    options.createCommandRunId ?? createDefaultCommandRunId();
  const now = options.now ?? Date.now;

  return {
    async listCommands(query): Promise<UiCommandCatalog> {
      return filterCommandCatalogBySurface(
        await buildCatalog(options, acceptedExtraCommands),
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
        if (
          isSkillCommandId(invocation.commandId) &&
          !acceptedExtraCommandIds.has(invocation.commandId)
        ) {
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
