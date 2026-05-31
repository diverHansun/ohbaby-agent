import {
  filterCommandCatalog as filterSdkCommandCatalog,
  parseSlashInput as parseSdkSlashInput,
  resolveCommand as resolveSdkCommand,
  type UiCommandInvocation,
  type UiCommandSpec,
  type UiParsedSlashInput,
} from "ohbaby-sdk";
import type { TuiCommandCatalog } from "../store/snapshot.js";

export type ParsedSlashInput = UiParsedSlashInput | null;

export type ResolveCommandResult =
  | {
      readonly kind: "resolved";
      readonly command: UiCommandSpec;
      readonly invocation: UiCommandInvocation;
    }
  | {
      readonly kind: "not-found";
      readonly reason: string;
    }
  | {
      readonly kind: "not-slash";
      readonly reason: string;
    };

export interface CommandRuntimeOptions {
  readonly surface: "tui";
  readonly sessionId?: string;
}

let invocationCounter = 0;

export function parseSlashInput(input: string): ParsedSlashInput {
  return parseSdkSlashInput(input);
}

export function resolveCommand(
  parsed: ParsedSlashInput,
  catalog: TuiCommandCatalog,
  options: CommandRuntimeOptions,
): ResolveCommandResult {
  const resolved = resolveSdkCommand(catalog, parsed, {
    surface: options.surface,
  });

  if (!resolved.ok) {
    return resolved.error.code === "NOT_A_COMMAND"
      ? {
          kind: "not-slash",
          reason: resolved.error.message,
        }
      : {
          kind: "not-found",
          reason: resolved.error.message,
        };
  }

  return {
    command: resolved.command,
    invocation: {
      argumentMode: resolved.command.argumentMode,
      argv: resolved.argv,
      body: resolved.body,
      clientInvocationId: createInvocationId(),
      commandId: resolved.command.id,
      path: resolved.path,
      raw: resolved.raw,
      rawArgs: resolved.rawArgs,
      sessionId: options.sessionId,
      surface: options.surface,
    },
    kind: "resolved",
  };
}

export function filterCommandCatalog(
  parsed: ParsedSlashInput,
  catalog: TuiCommandCatalog,
  options: Pick<CommandRuntimeOptions, "surface">,
): readonly UiCommandSpec[] {
  if (!parsed) {
    return [];
  }

  return filterSdkCommandCatalog(catalog, parsed.raw, {
    surface: options.surface,
  });
}

export function applySlashCompletion(
  input: string,
  catalog: TuiCommandCatalog,
  options: Pick<CommandRuntimeOptions, "surface">,
): string {
  const matches = filterCommandCatalog(
    parseSlashInput(input),
    catalog,
    options,
  );

  if (matches.length !== 1) {
    return input;
  }

  return `/${matches[0]?.path.join(" ")} `;
}

function createInvocationId(): string {
  invocationCounter += 1;
  return `tui_${String(invocationCounter)}`;
}
