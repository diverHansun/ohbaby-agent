import type {
  UiCommandCatalog,
  UiCommandSpec,
  UiCommandSurface,
} from "ohbaby-sdk";

const CATALOG_VERSION = "builtin-v1";
const COMMON_SURFACES = ["tui", "stdout", "headless"] as const;
const INTERACTIVE_SURFACES = ["tui", "stdout"] as const;

const BUILTIN_COMMANDS: readonly UiCommandSpec[] = [
  {
    id: "status",
    path: ["status"],
    aliases: [],
    argumentMode: "argv",
    category: "system",
    description: "Show backend status",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "tools",
    path: ["tools"],
    aliases: [],
    argumentMode: "argv",
    category: "system",
    description: "List available tools",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "abort",
    path: ["abort"],
    aliases: [["cancel"]],
    argumentMode: "argv",
    category: "system",
    description: "Abort the active run",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "exit",
    path: ["exit"],
    aliases: [["quit"], ["q"]],
    argumentMode: "argv",
    category: "system",
    description: "Exit the current UI surface",
    source: "builtin",
    surfaces: INTERACTIVE_SURFACES,
  },
  {
    id: "model",
    path: ["model"],
    aliases: [],
    argumentMode: "argv",
    category: "model",
    description: "Show the current model",
    parentBehavior: "none",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "model.list",
    path: ["model", "list"],
    aliases: [],
    argumentMode: "argv",
    category: "model",
    description: "List configured models",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "model.current",
    path: ["model", "current"],
    aliases: [],
    argumentMode: "argv",
    category: "model",
    description: "Show the current model",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "session",
    path: ["session"],
    aliases: [],
    argumentMode: "argv",
    category: "session",
    description: "Choose a session",
    parentBehavior: "interaction",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "session.new",
    path: ["session", "new"],
    aliases: [["new"]],
    argumentMode: "argv",
    category: "session",
    description: "Start a new session",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "session.compact",
    path: ["session", "compact"],
    aliases: [["compact"]],
    acceptsArguments: true,
    argsHint: "[--session_id <id>] [--force]",
    argumentMode: "argv",
    category: "session",
    description: "Compact the current session context",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "session.resume",
    path: ["resume"],
    aliases: [],
    acceptsArguments: true,
    argsHint: "--session_id <id>",
    argumentMode: "argv",
    category: "session",
    description: "Resume a session",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "permission",
    path: ["permission"],
    aliases: [],
    argumentMode: "argv",
    category: "permission",
    description: "Choose the permission level",
    parentBehavior: "none",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "permission.default",
    path: ["permission", "default"],
    aliases: [],
    argumentMode: "argv",
    category: "permission",
    description: "Use the default permission level",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
  {
    id: "permission.full-access",
    path: ["permission", "full-access"],
    aliases: [],
    argumentMode: "argv",
    category: "permission",
    description: "Use the full-access permission level",
    source: "builtin",
    surfaces: COMMON_SURFACES,
  },
];

function keyForPath(path: readonly string[]): string {
  return path.join("/").toLowerCase();
}

export function validateUniqueAliases(
  commands: readonly UiCommandSpec[],
): void {
  const owners = new Map<string, string>();
  for (const command of commands) {
    for (const path of [command.path, ...(command.aliases ?? [])]) {
      const key = keyForPath(path);
      const existingOwner = owners.get(key);
      if (existingOwner && existingOwner !== command.id) {
        throw new Error(`Duplicate command path or alias: ${key}`);
      }
      owners.set(key, command.id);
    }
  }
}

export function buildCommandCatalog(
  options: {
    readonly extraCommands?: readonly UiCommandSpec[];
  } = {},
): UiCommandCatalog {
  const commands = [...BUILTIN_COMMANDS, ...(options.extraCommands ?? [])];
  validateUniqueAliases(commands);
  return {
    version: CATALOG_VERSION,
    commands,
  };
}

export function filterCommandCatalogBySurface(
  catalog: UiCommandCatalog,
  surface?: UiCommandSurface,
): UiCommandCatalog {
  if (!surface) {
    return catalog;
  }

  return {
    ...catalog,
    commands: catalog.commands.filter((command) =>
      command.surfaces.includes(surface),
    ),
  };
}
