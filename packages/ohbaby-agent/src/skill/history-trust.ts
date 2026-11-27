import type { MessageWithParts } from "../core/message/types.js";
import type { SandboxLease } from "../sandbox/types.js";
import { slashSkillName } from "./usage.js";
import { activateSkillRuntime } from "./tool.js";
import type { SkillRegistryPort } from "./types.js";

/** Resolve historical skill identities against the current registry, including after a restart or fork. */
export async function trustLoadedSkills(
  history: readonly MessageWithParts[],
  registry: SkillRegistryPort,
  lease: SandboxLease,
): Promise<void> {
  const names = new Set<string>();
  for (const { info, parts } of history) {
    for (const part of parts) {
      if (info.role === "user" && part.type === "text" && !part.ignored) {
        const name = slashSkillName(part);
        if (name) names.add(name);
      } else if (
        info.role === "assistant" &&
        info.finish !== "error" &&
        part.type === "tool" &&
        (part.tool === "skill" || part.tool === "skill_resource") &&
        part.state.status === "completed" &&
        part.state.metadata?.uiToolSource === "skill" &&
        typeof part.state.metadata.name === "string"
      ) {
        names.add(part.state.metadata.name);
      }
    }
  }
  if (!names.size) return;
  await registry.refresh?.();
  for (const { name, baseDir } of await registry.all())
    if (names.has(name))
      await activateSkillRuntime({ name, baseDir, environment: lease });
}
