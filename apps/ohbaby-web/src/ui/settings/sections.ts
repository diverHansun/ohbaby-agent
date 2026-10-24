export type SettingsSection = "models" | "search";

/** Navigation order (D12); 4b adds MCP, Skills and About. */
export const SETTINGS_SECTIONS: readonly {
  readonly id: SettingsSection;
  readonly label: string;
}[] = [
  { id: "models", label: "Models" },
  { id: "search", label: "Web search" },
];

const STORAGE_KEY = "ohbaby.settings.section";

function isSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/** The section shown on the first open of a page load: last time's, else Models. */
export function readLastSection(): SettingsSection {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isSection(stored) ? stored : "models";
  } catch {
    return "models";
  }
}

export function rememberSection(section: SettingsSection): void {
  try {
    localStorage.setItem(STORAGE_KEY, section);
  } catch {
    // Remembering the section is a convenience only.
  }
}
