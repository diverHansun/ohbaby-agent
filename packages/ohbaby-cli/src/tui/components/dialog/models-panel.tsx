import { Box, Text, useInput } from "ink";
import type { CoreAPI, UiContextWindowUsage } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { formatContextWindowUsage } from "../../render/usage.js";
import { useTheme } from "../../theme/index.js";

interface ModelRow {
  readonly id: string;
  readonly label: string;
  readonly provider?: string;
  readonly model?: string;
  readonly interfaceProvider?: string;
  readonly active: boolean;
  readonly default: boolean;
}

export interface ModelsPanelProps {
  readonly client: CoreAPI;
  readonly contextWindowUsage: UiContextWindowUsage | null;
  readonly data: Record<string, unknown>;
  /** The chat the panel was opened in; null for a draft. */
  readonly sessionId: string | null;
  readonly pendingModelEntryId: string | null;
  readonly onDraftSelect: (entryId: string) => void;
  readonly onClose: () => void;
  readonly visibleLines: number;
}

/**
 * `/models` (session-model D20): Enter picks the model for this chat only, or
 * for the draft's first prompt; `d` makes the row the default and keeps the
 * panel open. Esc is handled by the panel manager.
 */
export function ModelsPanel({
  client,
  contextWindowUsage,
  data,
  sessionId,
  pendingModelEntryId,
  onDraftSelect,
  onClose,
  visibleLines,
}: ModelsPanelProps): ReactElement {
  const theme = useTheme();
  const rows = modelRows(data.models);
  // `d` moves the default and may move a chat that follows it.
  const [override, setOverride] = useState<{
    readonly defaultId?: string;
    readonly activeId?: string;
  }>({});
  const defaultId = override.defaultId ?? rows.find((row) => row.default)?.id;
  const activeId =
    override.activeId ??
    (sessionId === null ? (pendingModelEntryId ?? defaultId) : undefined) ??
    rows.find((row) => row.active)?.id;
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(
      0,
      rows.findIndex((row) => row.id === activeId),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Input handlers re-register after commit; read the latest frame's values.
  const latest = useRef({ rows, selectedIndex });
  latest.current = { rows, selectedIndex };
  // Keys in one stdin chunk arrive before a re-render; guard synchronously.
  const saving = useRef(false);
  // Esc may close the panel while a save is in flight; drop its outcome then.
  const mounted = useRef(true);
  useEffect(
    () => (): void => {
      mounted.current = false;
    },
    [],
  );

  const run = (work: () => Promise<void>): void => {
    saving.current = true;
    setBusy(true);
    setError(null);
    void work()
      .catch((caught: unknown) => {
        if (mounted.current)
          setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        saving.current = false;
        if (mounted.current) setBusy(false);
      });
  };

  useInput((value, key) => {
    const { rows: current, selectedIndex: index } = latest.current;
    if (saving.current || current.length === 0) return;
    const last = current.length - 1;
    const delta = key.downArrow
      ? 1
      : key.upArrow
        ? -1
        : key.pageDown
          ? visibleLines
          : key.pageUp
            ? -visibleLines
            : 0;
    if (delta !== 0) {
      setSelectedIndex(Math.max(0, Math.min(last, index + delta)));
      return;
    }
    const row = current.at(Math.min(index, last));
    if (!row) return;
    if (key.return) {
      if (sessionId === null) {
        onDraftSelect(row.id);
        onClose();
        return;
      }
      run(async () => {
        await client.updateSessionModel({ sessionId, modelEntryId: row.id });
        if (mounted.current) onClose();
      });
      return;
    }
    if (value === "d" && !key.ctrl && !key.meta) {
      run(async () => {
        const result = await client.selectDefaultModel(row.id);
        const next = result.active?.id ?? row.id;
        // A session may follow the default; ask which model it now uses.
        const model = sessionId
          ? await client.getCurrentModel({ sessionId })
          : null;
        if (!mounted.current) return;
        setOverride({
          defaultId: next,
          ...(model ? { activeId: model.id } : {}),
        });
      });
    }
  });

  const shown = rows.find((row) => row.id === activeId);
  const current = getRecord(data, "current");
  const summary = [
    shown?.model ??
      shown?.label ??
      (current ? stringField(current, "model") : undefined) ??
      "Unavailable",
    shown?.provider ?? (current ? stringField(current, "provider") : undefined),
    shown?.interfaceProvider ??
      (current ? stringField(current, "interfaceProvider") : undefined),
    contextWindowUsage
      ? `Context ${formatContextWindowUsage(contextWindowUsage)}`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  const clamped = Math.min(selectedIndex, Math.max(0, rows.length - 1));
  const windowStart = Math.floor(clamped / visibleLines) * visibleLines;
  const windowRows = rows.slice(windowStart, windowStart + visibleLines);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.text.heading}>
          {sessionId === null ? "Next chat " : "This chat "}
        </Text>
        {summary}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.text.heading}>Models</Text>
        {rows.length === 0 ? (
          <Text dimColor>No models</Text>
        ) : (
          windowRows.map((row, offset) => {
            const selected = windowStart + offset === clamped;
            return (
              <Text key={row.id}>
                <Text color={selected ? theme.status.accent : undefined}>
                  {selected ? "> " : "  "}
                  {row.label}
                  {row.id === activeId ? " ✓" : ""}
                </Text>
                <Text dimColor>
                  {row.provider ? ` ${row.provider}` : ""}
                  {row.id === defaultId ? " · default" : ""}
                </Text>
              </Text>
            );
          })
        )}
        {rows.length > visibleLines ? (
          <Text dimColor>
            showing {windowStart + 1}-
            {Math.min(windowStart + visibleLines, rows.length)} of {rows.length}{" "}
            · pgup/pgdn
          </Text>
        ) : null}
      </Box>
      {rows.length > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ move · enter use in this chat · d set default · esc close
            {busy ? " · Saving..." : ""}
          </Text>
        </Box>
      ) : null}
      {error ? <Text color={theme.status.error}>{error}</Text> : null}
    </Box>
  );
}

function modelRows(value: unknown): readonly ModelRow[] {
  return Array.isArray(value)
    ? value
        .map((item) => (isRecord(item) ? toRow(item) : undefined))
        .filter((row): row is ModelRow => row !== undefined)
    : [];
}

function toRow(
  record: Record<string, unknown> | undefined,
): ModelRow | undefined {
  const id = record ? stringField(record, "id") : undefined;
  if (!record || !id) return undefined;
  return {
    id,
    label: stringField(record, "label") ?? id,
    provider: stringField(record, "provider"),
    model: stringField(record, "model"),
    interfaceProvider: stringField(record, "interfaceProvider"),
    active: record.active === true,
    default: record.default === true,
  };
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
