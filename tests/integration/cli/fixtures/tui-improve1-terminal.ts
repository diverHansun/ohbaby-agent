import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";

// Resolve the CLI's installed public Ink entry without a root dependency.
const cliRequire = createRequire(
  new URL("../../../../packages/ohbaby-cli/package.json", import.meta.url),
);
export const { render, Box, useBoxMetrics } = await import(
  cliRequire.resolve("ink")
);

export class TerminalOutput extends EventEmitter {
  columns = 80;
  rows = 24;
  readonly isTTY = true;
  readonly chunks: string[] = [];
  write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };
  text(): string {
    return stripVTControlCharacters(this.chunks.join(""));
  }
}
export class TerminalInput extends EventEmitter {
  readonly isTTY = true;
  raw = false;
  private readonly input: string[] = [];
  setEncoding(): this {
    return this;
  }
  setRawMode(value: boolean): this {
    this.raw = value;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  read(): string | null {
    return this.input.shift() ?? null;
  }
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  send(value: string): void {
    this.input.push(value);
    this.emit("readable");
  }
}
export const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 90));
};
