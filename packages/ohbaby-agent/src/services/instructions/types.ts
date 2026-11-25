import type {
  PromptSecurityFinding,
  scanPromptLikeContent,
} from "../../core/system-prompt/security/index.js";

export interface LastGoodRead {
  readonly content: string;
  readonly truncated: boolean;
}

export interface InstructionSource extends LastGoodRead {
  readonly scope: "global" | "project";
  readonly fileName: "AGENTS.md" | "CLAUDE.md";
  readonly path: string;
  readonly displayPath: string;
  readonly contentHash: string;
}

export interface InstructionWarning {
  readonly sourcePath: string;
  readonly kind: "read-error" | "rejected" | "truncated" | "budget-omitted";
  readonly code: string;
  readonly message: string;
}

export interface LoadInstructionsOptions {
  readonly projectDirectory?: string;
  readonly homeDirectory?: string;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly securityScanner?: typeof scanPromptLikeContent;
  readonly lastGoodReads?: Map<string, LastGoodRead>;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
  readonly onWarning?: (warning: InstructionWarning) => void;
}
