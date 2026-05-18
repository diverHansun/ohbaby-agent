export type LayerType = "agent" | "custom" | "environment" | "identity";

export interface EnvironmentInfo {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly date: string;
  readonly isGitRepo: boolean;
  readonly osVersion?: string;
}

export interface AssembleOptions {
  readonly agentName: string;
  readonly agentPrompt?: string;
  readonly isSubagent: boolean;
  readonly environment: EnvironmentInfo;
  readonly customInstructions?: readonly string[];
  readonly tools?: readonly string[];
}

export interface AssembleResult {
  readonly prompts: readonly string[];
  readonly layers: readonly {
    readonly type: LayerType;
    readonly length: number;
  }[];
  readonly totalLength: number;
}
