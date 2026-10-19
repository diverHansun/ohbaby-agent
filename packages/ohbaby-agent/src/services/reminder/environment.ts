import type { ReminderBody, ReminderProvider } from "./index.js";

export function createEnvironmentReminderProvider(): ReminderProvider {
  return {
    type: "environment",
    kind: "snapshot",
    audience: "both",
    collect(context): ReminderBody | undefined {
      if (context.environment === undefined) return undefined;
      const info = context.environment;
      // The shared reminder wrapper escapes all external values exactly once.
      const text = [
        `Current working directory: ${info.cwd}`,
        `Platform: ${info.platform}`,
        ...(!context.isSubagent && info.osVersion
          ? [`OS version: ${info.osVersion}`]
          : []),
        `Date: ${info.date}`,
        `Git repository: ${String(info.isGitRepo)}`,
      ].join("\n");
      return { key: text, text };
    },
  };
}
