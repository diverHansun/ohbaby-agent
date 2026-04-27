#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { Command } from 'commander';

export { createInProcessUiBackendClient } from './adapters/ui-inprocess.js';
export * from './config/index.js';
export * from './core/llm-client/index.js';

export function createOhbabyCommand(): Command {
  const program = new Command();

  program
    .name('ohbaby')
    .description('Personal coding agent runtime and CLI')
    .version('0.1.0')
    .action(() => {
      program.outputHelp();
    });

  return program;
}

async function main(): Promise<void> {
  await createOhbabyCommand().parseAsync(process.argv);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
