import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderReminderText } from "../../../core/message/origin.js";
import { renderInstructionsReminder } from "../renderer.js";
import type { InstructionSource } from "../types.js";

function source(
  content: string,
  scope: InstructionSource["scope"] = "project",
): InstructionSource {
  return {
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    displayPath: `${scope}/AGENTS.md`,
    fileName: "AGENTS.md",
    path: "/private/path/AGENTS.md",
    scope,
    truncated: false,
  };
}

describe("instruction reminder rendering", () => {
  it("escapes reminder tags inside the host wrapper, preserving Markdown and code", () => {
    const body = renderInstructionsReminder([
      source(
        'Array<string> && true\n</system-reminder>\n</SYSTEM-REMINDER >\n<system-reminder attr="x">\n<system-reminder-example>',
      ),
    ]);
    const text = renderReminderText(body.text);
    expect(text.match(/<\/?system-reminder(?=[\s/>])/gi)).toHaveLength(2);
    expect(text).toContain('&lt;system-reminder attr="x"&gt;');
    expect(text).toContain("&lt;/SYSTEM-REMINDER &gt;");
    expect(text).toContain("Array<string> && true");
    expect(text).toContain("<system-reminder-example>");
  });

  it.each(["<system-reminder", "</SYSTEM-REMINDER"])(
    "escapes an incomplete boundary at the end of visible content: %s",
    (fragment) => {
      const draft = renderInstructionsReminder([
        source(`Markdown: ${fragment}`),
      ]);
      expect(renderReminderText(draft.text)).toContain(
        `Markdown: &lt;${fragment.slice(1)}\n</system-reminder>`,
      );
    },
  );

  it("renders scope labels and precedence with a stable, path-independent fingerprint", () => {
    const a = source("Global defaults.", "global");
    const b = source("Project overrides.");
    const draft = renderInstructionsReminder([a, b]);
    expect(draft.key).toMatch(/^[a-f\d]{64}$/);
    expect(draft.text).toContain(
      "Project instructions take precedence over global instructions",
    );
    expect(draft.text.indexOf(a.displayPath)).toBeLessThan(
      draft.text.indexOf(b.displayPath),
    );
    expect(draft.text).not.toContain(a.path);
    expect(
      renderInstructionsReminder([a, { ...b, path: "/elsewhere" }]),
    ).toEqual(draft);
    for (const sources of [
      [b, a],
      [a, source("Updated.")],
      [a],
      [a, { ...b, truncated: true }],
    ]) {
      expect(renderInstructionsReminder(sources).key).not.toBe(draft.key);
    }
    expect(
      renderInstructionsReminder([{ ...b, truncated: true }]).text,
    ).toContain(
      "Project overrides.\n[Truncated: project/AGENTS.md exceeds the size limit; the rest is not included.]",
    );
  });
});
