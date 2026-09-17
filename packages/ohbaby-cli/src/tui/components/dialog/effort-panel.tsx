import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiReasoningCapabilityView,
  UiReasoningConfig,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../theme/index.js";

interface EffortChoice {
  readonly label: string;
  readonly reasoning: UiReasoningConfig;
}

export interface EffortPanelProps {
  readonly client: CoreAPI;
  readonly sessionId: string | null;
  readonly pendingReasoning: UiReasoningConfig | null;
  readonly onSelect: (reasoning: UiReasoningConfig) => Promise<void>;
  readonly onClose: () => void;
}

function choicesFor(view: UiReasoningCapabilityView): readonly EffortChoice[] {
  if (view.status !== "identified" || view.mode === "none") return [];
  const choices: EffortChoice[] =
    view.mode === "effort"
      ? view.efforts.map((effort) => ({
          label: effort,
          reasoning: { enabled: true, effort },
        }))
      : [{ label: "On", reasoning: { enabled: true } }];
  if (view.supportsDisabled)
    choices.push({ label: "Off", reasoning: { enabled: false } });
  return choices;
}

export function EffortPanel({
  client,
  sessionId,
  pendingReasoning,
  onSelect,
  onClose,
}: EffortPanelProps): ReactElement {
  const theme = useTheme();
  const [view, setView] = useState<UiReasoningCapabilityView | null>(null);
  const [current, setCurrent] = useState<UiReasoningConfig | null>(
    pendingReasoning,
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const choices = view ? choicesFor(view) : [];

  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.getCurrentModel(), client.getSnapshot()])
      .then(([model, snapshot]) => {
        if (cancelled) return;
        const capability = model?.reasoning ?? {
          status: "unknown" as const,
          efforts: [],
        };
        const preference = sessionId
          ? (snapshot.sessions.find((session) => session.id === sessionId)
              ?.reasoning ?? null)
          : pendingReasoning;
        const active =
          preference?.enabled !== false && preference?.effort === undefined
            ? (capability.default ?? preference)
            : preference;
        const options = choicesFor(capability);
        const index = options.findIndex((option) =>
          active?.enabled === false
            ? option.reasoning.enabled === false
            : option.reasoning.enabled !== false &&
              option.reasoning.effort === active?.effort,
        );
        setView(capability);
        setCurrent(preference);
        selectedIndexRef.current = Math.max(0, index);
        setSelectedIndex(selectedIndexRef.current);
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : String(caught));
      });
    return (): void => {
      cancelled = true;
    };
  }, [client, sessionId, pendingReasoning]);

  useInput((_value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (saving || choices.length === 0) return;
    if (key.downArrow || key.pageDown) {
      selectedIndexRef.current = Math.min(
        selectedIndexRef.current + 1,
        choices.length - 1,
      );
      setSelectedIndex(selectedIndexRef.current);
      return;
    }
    if (key.upArrow || key.pageUp) {
      selectedIndexRef.current = Math.max(selectedIndexRef.current - 1, 0);
      setSelectedIndex(selectedIndexRef.current);
      return;
    }
    if (key.return) {
      const choice = choices[selectedIndexRef.current];
      setSaving(true);
      setError(null);
      void onSelect(choice.reasoning)
        .then(onClose)
        .catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          setSaving(false);
        });
    }
  });

  return (
    <Box flexDirection="column">
      {view === null && error === null ? (
        <Text dimColor>Loading reasoning options...</Text>
      ) : null}
      {view !== null && choices.length === 0 ? (
        <Text dimColor>No verified reasoning levels for this model.</Text>
      ) : null}
      {choices.map((choice, index) => (
        <Text
          key={choice.label}
          color={index === selectedIndex ? theme.status.accent : undefined}
        >
          {index === selectedIndex ? "> " : "  "}
          {choice.label}
          {current?.enabled === choice.reasoning.enabled &&
          current?.effort === choice.reasoning.effort
            ? " (saved)"
            : ""}
        </Text>
      ))}
      {choices.length > 0 ? (
        <Text dimColor>
          ↑↓ select · Enter save · Esc close{saving ? " · Saving..." : ""}
        </Text>
      ) : null}
      {error ? <Text color={theme.status.error}>{error}</Text> : null}
    </Box>
  );
}
