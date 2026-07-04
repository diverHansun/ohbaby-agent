import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiCommandCatalog,
  UiContextWindowUsage,
  UiRunStatus,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { formatContextWindowUsage } from "../../render/usage.js";
import { useTheme } from "../../theme/index.js";
import type {
  CommandPanelState,
  DisplayCommandPanelState,
} from "./command-panel-state.js";
import { ConnectPanel } from "./connect-panel.js";
import { ConnectSearchPanel } from "./connect-search-panel.js";
import { OverlayCard } from "./overlay-card.js";

const SKILLS_PANEL_MAX_VISIBLE_LINES = 10;
const SKILLS_PANEL_MIN_VISIBLE_LINES = 3;
// Rows kept free around the skills list: overlay border, padding, title, and
// footer plus the prompt area below the card. Keeping the dynamic frame
// shorter than the terminal avoids Ink's clearTerminal-per-frame fallback
// (see layout/metrics.ts).
const SKILLS_PANEL_RESERVED_ROWS = 14;

export function resolveSkillsPanelVisibleLines(rows: number): number {
  const available =
    (Number.isFinite(rows) ? Math.floor(rows) : 24) -
    SKILLS_PANEL_RESERVED_ROWS;
  return Math.max(
    SKILLS_PANEL_MIN_VISIBLE_LINES,
    Math.min(SKILLS_PANEL_MAX_VISIBLE_LINES, available),
  );
}

interface SkillsSelection {
  readonly index: number;
  readonly invocationId: string | null;
}

export interface CommandPanelManagerProps {
  readonly catalog: UiCommandCatalog | null;
  readonly client: CoreAPI;
  readonly contextWindowUsage: UiContextWindowUsage | null;
  readonly onClose: () => void;
  readonly panel: CommandPanelState | null;
  readonly runtime: UiRunStatus;
}

export function CommandPanelManager({
  catalog,
  client,
  contextWindowUsage,
  onClose,
  panel,
  runtime,
}: CommandPanelManagerProps): ReactElement | null {
  const theme = useTheme();
  const layout = useTuiLayout();
  const skillsVisibleLines = resolveSkillsPanelVisibleLines(layout.rows);
  const skills = panelSkills(panel);
  const maxSkillIndex = Math.max(0, skills.length - 1);
  const skillsPanelInvocationId =
    panel !== null && panel.mode === "display" && panel.kind === "skills"
      ? panel.clientInvocationId
      : null;
  // Selection is keyed by the panel invocation so a freshly opened panel
  // derives index 0 without a reset effect.
  const [skillsSelection, setSkillsSelection] = useState<SkillsSelection>({
    index: 0,
    invocationId: null,
  });
  const skillsSelectedIndex =
    skillsSelection.invocationId === skillsPanelInvocationId
      ? skillsSelection.index
      : 0;
  // Input handlers re-register in a passive effect, so a keypress can hit a
  // handler whose closure predates the latest commit (e.g. the loading frame
  // before skills data arrived). Route per-frame data through a render-synced
  // ref so navigation always sees the committed skills window.
  const skillsNavigationRef = useRef({
    invocationId: skillsPanelInvocationId,
    maxIndex: maxSkillIndex,
    pageSize: skillsVisibleLines,
  });
  skillsNavigationRef.current = {
    invocationId: skillsPanelInvocationId,
    maxIndex: maxSkillIndex,
    pageSize: skillsVisibleLines,
  };

  useInput(
    (_value, key) => {
      if (key.escape) {
        onClose();
        return;
      }

      if (panel?.kind !== "skills") {
        return;
      }

      const { invocationId, maxIndex, pageSize } = skillsNavigationRef.current;
      const delta = key.downArrow
        ? 1
        : key.upArrow
          ? -1
          : key.pageDown
            ? pageSize
            : key.pageUp
              ? -pageSize
              : 0;
      if (delta !== 0) {
        setSkillsSelection((current) => {
          const baseIndex =
            current.invocationId === invocationId
              ? clampSkillIndex(current.index, maxIndex)
              : 0;
          return {
            index: clampSkillIndex(baseIndex + delta, maxIndex),
            invocationId,
          };
        });
      }
    },
    { isActive: panel?.mode === "display" },
  );

  if (panel === null) {
    return null;
  }

  if (panel.mode === "interactive") {
    const panelBody =
      panel.kind === "connect-search" ? (
        <ConnectSearchPanel
          client={client}
          onClose={onClose}
          runtime={runtime}
        />
      ) : (
        <ConnectPanel client={client} onClose={onClose} runtime={runtime} />
      );
    return (
      <OverlayCard title={panelTitle(panel.kind)}>{panelBody}</OverlayCard>
    );
  }

  return (
    <OverlayCard title={panelTitle(panel.kind)}>
      {panel.status === "loading" ? (
        <Text dimColor>Loading...</Text>
      ) : panel.status === "error" ? (
        <Text color={theme.status.error}>
          {panel.error ?? "Command failed"}
        </Text>
      ) : (
        <CommandPanelBody
          catalog={catalog}
          contextWindowUsage={contextWindowUsage}
          panel={panel}
          skills={skills}
          skillsSelectedIndex={skillsSelectedIndex}
          skillsVisibleLines={skillsVisibleLines}
        />
      )}
    </OverlayCard>
  );
}

function CommandPanelBody({
  catalog,
  contextWindowUsage,
  panel,
  skills,
  skillsSelectedIndex,
  skillsVisibleLines,
}: {
  readonly catalog: UiCommandCatalog | null;
  readonly contextWindowUsage: UiContextWindowUsage | null;
  readonly panel: DisplayCommandPanelState;
  readonly skills: readonly Record<string, unknown>[];
  readonly skillsSelectedIndex: number;
  readonly skillsVisibleLines: number;
}): ReactElement {
  const data = panel.output?.kind === "data" ? panel.output.data : {};

  switch (panel.kind) {
    case "status":
      return <StatusPanel data={data} />;
    case "help":
      return <HelpPanel catalog={catalog} data={data} />;
    case "mcps":
      return <McpsPanel data={data} />;
    case "models":
      return (
        <ModelsPanel contextWindowUsage={contextWindowUsage} data={data} />
      );
    case "skills":
      return (
        <SkillsPanel
          selectedIndex={skillsSelectedIndex}
          skills={skills}
          visibleLines={skillsVisibleLines}
        />
      );
  }
}

function StatusPanel({
  data,
}: {
  readonly data: Record<string, unknown>;
}): ReactElement {
  const permission = getRecord(data, "permission");
  const model = getRecord(data, "model");
  const tools = getRecord(data, "tools");
  const mcps = getRecord(data, "mcps");
  const contextWindow = toContextWindowUsage(getRecord(data, "contextWindow"));

  return (
    <Box flexDirection="column">
      <PanelRow
        label="Runtime"
        value={getString(data, "status") ?? "unknown"}
      />
      <PanelRow label="Session" value={getString(data, "sessionId")} />
      <PanelRow label="Permission" value={formatPermission(permission)} />
      <PanelRow label="Model" value={formatModelLabel(model)} />
      <PanelRow
        label="Context"
        value={formatUsageOrUnavailable(contextWindow)}
      />
      <PanelRow label="Tools" value={formatTools(tools)} />
      <PanelRow label="MCP" value={formatMcpSummary(mcps)} />
      <PanelRow label="Project" value={getString(data, "projectRoot")} />
    </Box>
  );
}

function HelpPanel({
  catalog,
  data,
}: {
  readonly catalog: UiCommandCatalog | null;
  readonly data: Record<string, unknown>;
}): ReactElement {
  const commands = Array.isArray(data.commands)
    ? data.commands
    : catalog
      ? catalog.commands
      : [];

  if (commands.length === 0) {
    return <Text dimColor>No commands</Text>;
  }

  return (
    <Box flexDirection="column">
      {commands.map((command, index) =>
        isRecord(command) ? (
          <HelpCommand command={command} key={String(index)} />
        ) : null,
      )}
    </Box>
  );
}

function HelpCommand({
  command,
}: {
  readonly command: Record<string, unknown>;
}): ReactElement {
  const theme = useTheme();

  return (
    <Text>
      <Text color={theme.text.headingAccent}>
        {formatCommandUsage(command)}
      </Text>
      <Text dimColor> - {getString(command, "description") ?? ""}</Text>
    </Text>
  );
}

function McpsPanel({
  data,
}: {
  readonly data: Record<string, unknown>;
}): ReactElement {
  const servers = Array.isArray(data.servers) ? data.servers : [];

  if (servers.length === 0) {
    return <Text dimColor>No MCP servers</Text>;
  }

  return (
    <Box flexDirection="column">
      {servers
        .slice(0, 12)
        .map((server, index) =>
          isRecord(server) ? (
            <PanelRow
              key={String(index)}
              label={getString(server, "name") ?? "server"}
              value={getString(server, "status") ?? "unknown"}
            />
          ) : null,
        )}
    </Box>
  );
}

function SkillsPanel({
  selectedIndex,
  skills,
  visibleLines,
}: {
  readonly selectedIndex: number;
  readonly skills: readonly Record<string, unknown>[];
  readonly visibleLines: number;
}): ReactElement {
  const theme = useTheme();

  if (skills.length === 0) {
    return <Text dimColor>No skills</Text>;
  }

  const clampedIndex = clampSkillIndex(selectedIndex, skills.length - 1);
  const windowStart = Math.floor(clampedIndex / visibleLines) * visibleLines;
  const visibleSkills = skills.slice(windowStart, windowStart + visibleLines);

  return (
    <Box flexDirection="column">
      {visibleSkills.map((skill, index) => {
        const absoluteIndex = windowStart + index;
        const selected = absoluteIndex === clampedIndex;
        return (
          <Text
            bold={selected}
            color={selected ? theme.status.accent : undefined}
            dimColor={!selected}
            key={String(absoluteIndex)}
            wrap="truncate-end"
          >
            {selected ? "> " : "  "}
            {formatSkillRow(skill)}
          </Text>
        );
      })}
      {skills.length > visibleLines ? (
        <Box marginTop={1}>
          <Text dimColor>
            showing {windowStart + 1}-
            {Math.min(windowStart + visibleLines, skills.length)} of{" "}
            {skills.length} · pgup/pgdn
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ModelsPanel({
  contextWindowUsage,
  data,
}: {
  readonly contextWindowUsage: UiContextWindowUsage | null;
  readonly data: Record<string, unknown>;
}): ReactElement {
  const theme = useTheme();
  const current = getRecord(data, "current");
  const models = Array.isArray(data.models) ? data.models : [];

  return (
    <Box flexDirection="column">
      <Text color={theme.text.heading}>Models (current)</Text>
      <Box flexDirection="column" marginTop={1}>
        <PanelRow label="Model" value={getString(current ?? {}, "model")} />
        <PanelRow
          label="Provider"
          value={getString(current ?? {}, "provider")}
        />
        <PanelRow
          label="Interface"
          value={getString(current ?? {}, "interfaceProvider")}
        />
        <PanelRow
          label="Context"
          value={formatUsageOrUnavailable(contextWindowUsage)}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.text.heading}>Models (switch)</Text>
        {models.length === 0 ? (
          <Text dimColor>No models</Text>
        ) : (
          models.slice(0, 8).map((model, index) =>
            isRecord(model) ? (
              <Text key={String(index)}>
                <Text
                  color={isActiveModel(model) ? theme.status.accent : undefined}
                >
                  {isActiveModel(model) ? "> " : "  "}
                  {formatModelLabel(model) ?? "Unnamed model"}
                </Text>
                <Text dimColor>
                  {" "}
                  {getString(model, "provider") ?? "Unavailable"}
                </Text>
              </Text>
            ) : null,
          )
        )}
      </Box>
    </Box>
  );
}

function PanelRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value?: string | null;
}): ReactElement {
  return (
    <Text>
      <Text bold>{label.padEnd(10, " ")} </Text>
      {value && value.trim() !== "" ? value : "Unavailable"}
    </Text>
  );
}

function panelTitle(kind: CommandPanelState["kind"]): string {
  switch (kind) {
    case "status":
      return "Status";
    case "help":
      return "Help";
    case "mcps":
      return "MCP";
    case "models":
      return "Models";
    case "skills":
      return "Skills";
    case "connect":
      return "Connect";
    case "connect-search":
      return "Connect Search";
  }
}

function formatPermission(
  permission: Record<string, unknown> | undefined,
): string | undefined {
  const mode = permission ? getString(permission, "mode") : undefined;
  const level = permission ? getString(permission, "level") : undefined;
  return mode && level ? `${mode} / ${level}` : undefined;
}

function formatTools(
  tools: Record<string, unknown> | undefined,
): string | null {
  if (!tools) {
    return null;
  }

  return `${formatCount(getNumber(tools, "builtin"))} builtin, ${formatCount(
    getNumber(tools, "module"),
  )} module, ${formatCount(getNumber(tools, "skill"))} skill, ${formatCount(
    getNumber(tools, "mcp"),
  )} mcp`;
}

function formatMcpSummary(
  mcps: Record<string, unknown> | undefined,
): string | null {
  if (!mcps) {
    return null;
  }
  const labels = [
    { count: getNumber(mcps, "connected"), label: "connected" },
    { count: getNumber(mcps, "failed"), label: "failed" },
    { count: getNumber(mcps, "disabled"), label: "disabled" },
    { count: getNumber(mcps, "disconnected"), label: "disconnected" },
  ]
    .filter(
      (entry): entry is { readonly count: number; readonly label: string } =>
        entry.count !== undefined && entry.count > 0,
    )
    .map((entry) => `${formatCount(entry.count)} ${entry.label}`);

  return labels.length > 0 ? labels.join(", ") : "none";
}

function formatModelLabel(
  model: Record<string, unknown> | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }
  return getString(model, "label") ?? getString(model, "id");
}

function formatCommandPath(command: Record<string, unknown>): string {
  const path = getStringArray(command, "path");
  return path.length > 0 ? `/${path.join(" ")}` : "/";
}

function formatCommandUsage(command: Record<string, unknown>): string {
  const path = formatCommandPath(command);
  const argsHint = getString(command, "argsHint");
  return argsHint ? `${path} ${argsHint}` : path;
}

function formatSkillRow(skill: Record<string, unknown>): string {
  const name = getString(skill, "name") ?? "skill";
  const description = truncatePanelText(getString(skill, "description"));
  const metadata = [
    getString(skill, "scope"),
    getString(skill, "source"),
  ].filter((item): item is string => Boolean(item));
  const suffixes = [
    metadata.length > 0 ? metadata.join(" · ") : "",
    description ? `- ${description}` : "",
  ].filter((item) => item !== "");

  return suffixes.length > 0 ? `${name} ${suffixes.join(" ")}` : name;
}

function panelSkills(
  panel: CommandPanelState | null,
): readonly Record<string, unknown>[] {
  if (
    panel?.mode !== "display" ||
    panel.kind !== "skills" ||
    panel.status !== "ready" ||
    panel.output?.kind !== "data"
  ) {
    return [];
  }

  const skills = panel.output.data.skills;
  return Array.isArray(skills) ? skills.filter(isRecord) : [];
}

function clampSkillIndex(index: number, maxIndex: number): number {
  return Math.max(0, Math.min(maxIndex, index));
}

function truncatePanelText(value: string | undefined, maxLength = 64): string {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatUsageOrUnavailable(usage: UiContextWindowUsage | null): string {
  const formatted = formatContextWindowUsage(usage);
  return formatted === "" ? "Unavailable" : formatted;
}

function toContextWindowUsage(
  record: Record<string, unknown> | undefined,
): UiContextWindowUsage | null {
  if (!record) {
    return null;
  }
  const currentTokens = getNumber(record, "currentTokens");
  const contextWindowTokens = getNumber(record, "contextWindowTokens");
  const contextWindowRatio = getNumber(record, "contextWindowRatio");
  if (
    currentTokens === undefined ||
    contextWindowTokens === undefined ||
    contextWindowRatio === undefined
  ) {
    return null;
  }

  return {
    contextWindowRatio,
    contextWindowTokens,
    currentTokens,
    estimatedAt: getString(record, "estimatedAt") ?? "",
    modelId: getString(record, "modelId") ?? "",
    sessionId: getString(record, "sessionId") ?? "",
  };
}

function isActiveModel(model: Record<string, unknown>): boolean {
  return getBoolean(model, "active") === true;
}

function formatCount(value: number | undefined): string {
  return String(Math.max(0, Math.round(value ?? 0)));
}

function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function getBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
