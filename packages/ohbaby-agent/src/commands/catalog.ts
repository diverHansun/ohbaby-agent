import type {
  UiCommandCatalog,
  UiCommandSpec,
  UiCommandSurface,
} from "ohbaby-sdk";

const CATALOG_VERSION = "builtin-v2";
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
    title: "Agent Status",
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
    title: "Exit",
  },
  {
    id: "help",
    path: ["help"],
    aliases: [["?"]],
    argumentMode: "argv",
    category: "system",
    description: "List available commands",
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Help",
  },
  {
    id: "models",
    path: ["models"],
    aliases: [],
    argumentMode: "argv",
    category: "model",
    description: "Show and switch the active model",
    parentBehavior: "interaction",
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Models",
  },
  {
    id: "sessions",
    path: ["sessions"],
    aliases: [],
    argumentMode: "argv",
    category: "session",
    description: "Browse and switch sessions",
    parentBehavior: "interaction",
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Sessions",
  },
  {
    id: "new",
    path: ["new"],
    aliases: [],
    argumentMode: "argv",
    category: "session",
    description: "Start a new session",
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "New Session",
  },
  {
    id: "compact",
    path: ["compact"],
    aliases: [],
    acceptsArguments: true,
    argsHint: "[--session_id <id>] [--force]",
    argumentMode: "argv",
    category: "session",
    description: "Compact the current session context",
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Compact Session",
  },
  {
    id: "resume",
    path: ["resume"],
    aliases: [],
    acceptsArguments: true,
    argsHint: "--session_id <id>",
    argumentMode: "argv",
    category: "session",
    description: "Resume a session",
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Resume Session",
  },
  {
    id: "permission",
    path: ["permission"],
    aliases: [],
    argumentMode: "argv",
    category: "permission",
    description: "Choose the permission level",
    parentBehavior: "interaction",
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Permission Level",
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
