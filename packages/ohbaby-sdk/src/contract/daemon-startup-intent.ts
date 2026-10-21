export interface DaemonStartupIntent {
  readonly startupSessionMode?: { readonly type: "continue" | "fresh" };
  readonly resumeSessionId?: string;
  readonly initialPermission?: {
    readonly level: "default" | "full-access";
    readonly mode: "plan" | "auto";
  };
}
