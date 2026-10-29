import type { MessageManager } from "../../core/message/types.js";
import type { SessionManager } from "../session/types.js";

export type ExportFormat = "html" | "jsonl";

export interface ExportInput {
  readonly sessionId: string;
  readonly format: ExportFormat;
}

export interface ExportResult {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: string;
  readonly messageCount: number;
}

export interface ExportDependencies {
  readonly sessionManager: Pick<SessionManager, "get">;
  readonly messageManager: Pick<MessageManager, "listBySession">;
  readonly appVersion: string;
  readonly now?: () => Date;
}

export interface ExportUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning?: number;
  readonly total: number;
}

export type ExportPart = (
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "reasoning";
      readonly text: string;
      readonly endReason?: "normal" | "interrupted" | "failed";
    }
  | {
      readonly type: "tool";
      readonly tool: string;
      readonly callId: string;
      readonly status:
        | "pending"
        | "running"
        | "completed"
        | "error"
        | "aborted";
      readonly input: Record<string, unknown>;
      readonly output?: string;
      readonly error?: string;
    }
) & { readonly compacted?: true };

export interface ExportMessage {
  readonly type: "message";
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly kind?: "compaction-summary" | "abort" | "error" | "info";
  readonly runtimeInput?:
    | "subagent-result"
    | "subagent-status"
    | "subagent-message";
  readonly time: { readonly created: string; readonly completed?: string };
  readonly model?: { readonly providerId?: string; readonly modelId?: string };
  readonly status?: "running" | "completed" | "error" | "aborted";
  readonly finish?: string;
  readonly error?: { readonly name: string; readonly message?: string };
  readonly usage?: ExportUsage;
  readonly usageComplete?: boolean;
  readonly parts: readonly ExportPart[];
}

export interface ExportHeader {
  readonly type: "session";
  readonly format: "ohbaby.session-export";
  readonly version: 1;
  readonly exportedAt: string;
  readonly app: { readonly name: "ohbaby"; readonly version: string };
  readonly session: {
    readonly id: string;
    readonly title: string;
    readonly projectRoot: string;
    readonly agent: string;
    readonly status: "active" | "archived";
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly stats: {
    readonly messageCount: number;
    readonly models: readonly string[];
    readonly tokens?: ExportUsage;
    readonly usageCoverage: {
      readonly known: number;
      readonly unknown: number;
    };
  };
}

export interface ExportDocument {
  readonly header: ExportHeader;
  readonly messages: readonly ExportMessage[];
}
