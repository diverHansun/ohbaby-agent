#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import type { UiSnapshot } from "ohbaby-sdk";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
} from "./adapters/ui-persistent.js";
import type { CliArgs } from "./cli/args.js";
import { CliArgumentError, parseCliArgs, renderHelp } from "./cli/args.js";
import { EXIT_CODES } from "./cli/exit-codes.js";
import { readStdin } from "./cli/stdin.js";
import { createStdoutRenderer } from "./cli/stdout-renderer.js";
import { McpManager } from "./mcp/index.js";
import { loadRuntimeEnvIntoProcessEnv } from "./utils/project-env.js";

const VERSION = "0.1.0";

function initialSnapshotFromArgs(args: CliArgs): UiSnapshot | undefined {
  if (!args.permissionMode && !args.permissionLevel) {
    return undefined;
  }
  return {
    activeSessionId: null,
    permission: {
      level: args.permissionLevel ?? "default",
      mode: args.permissionMode ?? "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

async function disposeNonInteractiveResources(): Promise<void> {
  try {
    await McpManager.disposeAll();
  } finally {
    closePersistentUiBackendDatabase();
  }
}

export async function runOhbabyCli(
  argv: readonly string[] = process.argv,
): Promise<number> {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(renderHelp());
      return EXIT_CODES.usage;
    }
    throw error;
  }

  if (args.mode === "help") {
    process.stdout.write(renderHelp());
    return EXIT_CODES.ok;
  }
  if (args.mode === "version") {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_CODES.ok;
  }

  await loadRuntimeEnvIntoProcessEnv();

  const client = createPersistentUiBackendClient({
    initialSnapshot: initialSnapshotFromArgs(args),
  });
  if (args.mode === "prompt" || !process.stdin.isTTY) {
    const renderer = createStdoutRenderer();
    client.subscribeEvents((event) => {
      renderer.handle(event);
    });
    try {
      const prompt =
        args.mode === "prompt" ? args.prompt : (await readStdin()).trim();
      await client.submitPrompt(prompt);
      return EXIT_CODES.ok;
    } finally {
      await disposeNonInteractiveResources();
    }
  }

  const { renderTerminalUi } = await import("ohbaby-cli");
  renderTerminalUi({ client });
  return EXIT_CODES.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runOhbabyCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = EXIT_CODES.failure;
    });
}
