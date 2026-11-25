import type { ReminderBody, ReminderProvider } from "../reminder/index.js";
import { loadInstructions } from "./loader.js";
import {
  INSTRUCTIONS_CLEARED_TEXT,
  renderInstructionsReminder,
} from "./renderer.js";
import type { LastGoodRead, LoadInstructionsOptions } from "./types.js";

type ProviderOptions = Omit<
  LoadInstructionsOptions,
  "projectDirectory" | "lastGoodReads"
>;

export function createInstructionsReminderProvider({
  onWarning,
  onSecurityFinding,
  ...options
}: ProviderOptions = {}): ReminderProvider {
  const lastGoodReads = new Map<string, LastGoodRead>();
  const activeDiagnostics = new Map<string, Set<string>>();
  return {
    type: "instructions",
    kind: "snapshot",
    audience: "both",
    async collect(context, previousKey): Promise<ReminderBody | undefined> {
      const projectDirectory = context.projectRoot ?? context.directory;
      const reports = new Map<string, () => void>();
      const sources = await loadInstructions({
        ...options,
        projectDirectory,
        lastGoodReads,
        onWarning(warning) {
          const key = JSON.stringify([
            warning.sourcePath,
            warning.kind,
            warning.code,
          ]);
          reports.set(key, () => onWarning?.(warning));
        },
        onSecurityFinding(finding) {
          const key = JSON.stringify([
            finding.sourcePath,
            "security-finding",
            finding.patternId,
          ]);
          reports.set(key, () => onSecurityFinding?.(finding));
        },
      });
      // Compare and replace together after I/O so concurrent sessions share one report.
      const root = projectDirectory ?? "";
      const previous = activeDiagnostics.get(root);
      if (reports.size === 0) activeDiagnostics.delete(root);
      else activeDiagnostics.set(root, new Set(reports.keys()));
      for (const [key, report] of reports) {
        if (!previous?.has(key)) report();
      }

      if (sources.length > 0) return renderInstructionsReminder(sources);
      if (previousKey === undefined || previousKey === "cleared")
        return undefined;
      return { key: "cleared", text: INSTRUCTIONS_CLEARED_TEXT };
    },
  };
}
