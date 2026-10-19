import { escapeReminderValue } from "../../core/message/origin.js";
import type { ReminderBody, ReminderProvider } from "./index.js";

export function createEnvironmentReminderProvider(): ReminderProvider {
  return {
    type: "environment",
    kind: "snapshot",
    audience: "both",
    collect(context): ReminderBody | undefined {
      if (context.environment === undefined) return undefined;
      const info = context.environment;
      const text = [
        `Current working directory: ${escapeReminderValue(info.cwd)}`,
        `Platform: ${escapeReminderValue(info.platform)}`,
        ...(!context.isSubagent && info.osVersion
          ? [`OS version: ${escapeReminderValue(info.osVersion)}`]
          : []),
        `Date: ${escapeReminderValue(info.date)}`,
        `Git repository: ${String(info.isGitRepo)}`,
      ].join("\n");
      return { key: text, text };
    },
  };
}
