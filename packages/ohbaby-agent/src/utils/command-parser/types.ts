export interface CommandDetail {
  readonly text: string;
  readonly root: string;
  readonly rootIndex: number;
  readonly tokens: readonly string[];
  readonly paths: readonly string[];
}

export interface ParsedCommand {
  readonly roots: readonly string[];
  readonly hasError: boolean;
  readonly details: readonly CommandDetail[];
}
