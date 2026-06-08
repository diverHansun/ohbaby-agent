import { Box, Text, useInput } from "ink";
import type { UiCommandCatalog, UiContextWindowUsage } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatContextWindowUsage } from "../../render/usage.js";
import { useTheme } from "../../theme/index.js";
import type { CommandPanelState } from "./command-panel-state.js";
import { OverlayCard } from "./overlay-card.js";

const SKILLS_PANEL_VISIBLE_LINES = 10;

interface SkillsScrollSignal {
  readonly direction: "next" | "previous";
  readonly sequence: number;
}

export interface CommandPanelManagerProps {
  readonly catalog: UiCommandCatalog | null;
  readonly contextWindowUsage: UiContextWindowUsage | null;
  readonly onClose: () => void;
  readonly panel: CommandPanelState | null;
}

export function CommandPanelManager({
  catalog,
  contextWindowUsage,
  onClose,
  panel,
}: CommandPanelManagerProps): ReactElement | null {
  const theme = useTheme();
  const [skillsScrollSignal, setSkillsScrollSignal] =
    useState<SkillsScrollSignal | null>(null);

  useInput(
    (_value, key) => {
      if (key.escape) {
        setSkillsScrollSignal(null);
        onClose();
        return;
      }

      if (panel?.kind === "skills" && key.pageDown) {
        setSkillsScrollSignal((current) => ({
          direction: "next",
          sequence: (current?.sequence ?? 0) + 1,
        }));
        return;
      }

      if (panel?.kind === "skills" && key.pageUp) {
        setSkillsScrollSignal((current) => ({
          direction: "previous",
          sequence: (current?.sequence ?? 0) + 1,
        }));
      }
    },
    { isActive: panel !== null },
  );

  if (panel === null) {
    return null;
  }

  return (
    <OverlayCard title={panelTitle(panel.kind)}>
      {panel.status === "loading" ? (
        <Text dimColor>Loading...</Text>
      ) : panel.status === "error" ? (
        <Text color={theme.status.error}>{panel.error ?? "Command failed"}</Text>
      ) : (
        <CommandPanelBody
          catalog={catalog}
          contextWindowUsage={contextWindowUsage}
          panel={panel}
          skillsScrollSignal={skillsScrollSignal}
        />
      )}
    </OverlayCard>
  );
}

function CommandPanelBody({
  catalog,
  contextWindowUsage,
  panel,
  skillsScrollSignal,
}: {
  readonly catalog: UiCommandCatalog | null;
  readonly contextWindowUsage: UiContextWindowUsage | null;
  readonly panel: CommandPanelState;
  readonly skillsScrollSignal: SkillsScrollSignal | null;
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
      return <ModelsPanel contextWindowUsage={contextWindowUsage} data={data} />;
    case "skills":
      return <SkillsPanel data={data} scrollSignal={skillsScrollSignal} />;
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
      <PanelRow label="Runtime" value={getString(data, "status") ?? "unknown"} />
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
  const categories = Array.isArray(data.categories)
    ? data.categories
    : catalog
      ? [{ commands: catalog.commands, title: "Commands" }]
      : [];

  if (categories.length === 0) {
    return <Text dimColor>No commands</Text>;
  }

  return (
    <Box flexDirection="column">
      {categories.slice(0, 6).map((category, index) =>
        isRecord(category) ? (
          <HelpCategory category={category} key={String(index)} />
        ) : null,
      )}
    </Box>
  );
}

function HelpCategory({
  category,
}: {
  readonly category: Record<string, unknown>;
}): ReactElement {
  const theme = useTheme();
  const title =
    getString(category, "title") ?? getString(category, "name") ?? "Commands";
  const commands = Array.isArray(category.commands) ? category.commands : [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.text.heading}>{title}</Text>
      {commands.slice(0, 8).map((command, index) =>
        isRecord(command) ? (
          <Text key={String(index)}>
            <Text color={theme.text.headingAccent}>
              {formatCommandPath(command)}
            </Text>
            <Text dimColor> - {getString(command, "description") ?? ""}</Text>
          </Text>
        ) : null,
      )}
    </Box>
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
      {servers.slice(0, 12).map((server, index) =>
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
  data,
  scrollSignal,
}: {
  readonly data: Record<string, unknown>;
  readonly scrollSignal: SkillsScrollSignal | null;
}): ReactElement {
  const theme = useTheme();
  const skills = Array.isArray(data.skills)
    ? data.skills.filter(isRecord)
    : [];
  const lines = useMemo(() => formatSkillLines(skills), [skills]);
  const maxStart = Math.max(0, lines.length - SKILLS_PANEL_VISIBLE_LINES);
  const maxStartRef = useRef(maxStart);
  const [start, setStart] = useState(0);

  useEffect(() => {
    maxStartRef.current = maxStart;
    setStart((current) => Math.min(current, maxStart));
  }, [maxStart]);

  useEffect(() => {
    if (scrollSignal === null) {
      return;
    }

    const delta =
      scrollSignal.direction === "next"
        ? SKILLS_PANEL_VISIBLE_LINES
        : -SKILLS_PANEL_VISIBLE_LINES;
    setStart((current) =>
      Math.max(0, Math.min(maxStartRef.current, current + delta)),
    );
  }, [scrollSignal]);

  if (skills.length === 0) {
    return <Text dimColor>No skills</Text>;
  }

  const visibleLines = lines.slice(
    start,
    start + SKILLS_PANEL_VISIBLE_LINES,
  );

  return (
    <Box flexDirection="column">
      {visibleLines.map((line) =>
        line.kind === "summary" ? (
          <Text key={line.key}>
            <Text color={theme.text.headingAccent}>{line.name}</Text>
            {line.metadata ? <Text dimColor> {line.metadata}</Text> : null}
          </Text>
        ) : (
          <Text dimColor key={line.key}>
            {"  "}
            {line.description}
          </Text>
        ),
      )}
      {lines.length > SKILLS_PANEL_VISIBLE_LINES ? (
        <Box marginTop={1}>
          <Text dimColor>
            showing {start + 1}-
            {Math.min(start + SKILLS_PANEL_VISIBLE_LINES, lines.length)} of{" "}
            {lines.length} · pgup/pgdn
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
                  color={
                    isActiveModel(model) ? theme.status.accent : undefined
                  }
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

interface SkillPanelLine {
  readonly description?: string;
  readonly key: string;
  readonly kind: "summary" | "description";
  readonly metadata?: string;
  readonly name?: string;
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
  }
}

function formatPermission(
  permission: Record<string, unknown> | undefined,
): string | undefined {
  const mode = permission ? getString(permission, "mode") : undefined;
  const level = permission ? getString(permission, "level") : undefined;
  return mode && level ? `${mode} / ${level}` : undefined;
}

function formatTools(tools: Record<string, unknown> | undefined): string | null {
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

function formatSkillLines(
  skills: readonly Record<string, unknown>[],
): SkillPanelLine[] {
  return skills.flatMap((skill, index) => {
    const name = getString(skill, "name") ?? "skill";
    const description = getString(skill, "description")?.trim();
    const metadata = [
      getString(skill, "scope"),
      getString(skill, "source"),
    ].filter((item): item is string => Boolean(item));
    const summaryLine: SkillPanelLine = {
      key: `${String(index)}:summary`,
      kind: "summary",
      metadata: metadata.join(" · "),
      name,
    };

    return description
      ? [
          summaryLine,
          {
            description,
            key: `${String(index)}:description`,
            kind: "description",
          },
        ]
      : [summaryLine];
  });
}

function formatUsageOrUnavailable(
  usage: UiContextWindowUsage | null,
): string {
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
