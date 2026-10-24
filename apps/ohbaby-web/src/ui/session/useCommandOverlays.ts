import type { UiBackendClient, UiWebCommandCatalog } from "ohbaby-sdk";
import { parseSlashCommandInput, resolveSlashCommand } from "ohbaby-sdk";
import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import {
  DEFAULT_GOAL_PANEL_INTENT,
  type GoalPanelIntent,
  goalPanelIntentFromArgs,
} from "../commands/GoalControl.js";
import { slashCommandLabel } from "../commands/slashCommands.js";
import {
  type StructuredCommandRequest,
  structuredOverlayKindForAction,
  type StructuredOverlayState,
} from "../commands/StructuredCommandOverlay.js";
import type { ComposerPrefill } from "../composer/Composer.js";

export interface CommandInputError {
  readonly scopeKey: string;
  readonly clientRequestId: string | undefined;
  readonly message: string;
}

/**
 * Owns slash-command overlays, composer prefill and command input errors for one
 * conversation scope. Everything resets when the draft scope or client changes.
 */
export function useCommandOverlays(input: {
  readonly runtime: OhbabyWebRuntime;
  readonly client: UiBackendClient;
  readonly draftScopeKey: string;
  readonly onScopeReset: () => void;
}): {
  readonly commandScopeGeneration: RefObject<number>;
  readonly composerEditRevision: RefObject<number>;
  readonly structuredOverlay: StructuredOverlayState | null;
  readonly closeStructuredOverlay: () => void;
  readonly composerPrefill: ComposerPrefill | null;
  readonly prefillComposer: (text: string) => void;
  readonly commandInputError: CommandInputError | null;
  readonly setCommandInputError: (error: CommandInputError | null) => void;
  readonly trackComposerRevision: (revision: number) => void;
  readonly openOverlayForSlashText: (
    text: string,
  ) => Promise<boolean | "goal-resume-with-arguments">;
  readonly openGoalPanel: (intent?: GoalPanelIntent) => void;
  readonly openStructuredCommand: (request: StructuredCommandRequest) => void;
} {
  const { runtime, client, draftScopeKey, onScopeReset } = input;
  const composerEditRevision = useRef(0);
  const composerPrefillNonce = useRef(0);
  const commandScopeGeneration = useRef(0);
  const [commandInputError, setCommandInputError] =
    useState<CommandInputError | null>(null);
  const [structuredOverlay, setStructuredOverlay] =
    useState<StructuredOverlayState | null>(null);
  const [composerPrefill, setComposerPrefill] =
    useState<ComposerPrefill | null>(null);
  const onScopeResetRef = useRef(onScopeReset);
  onScopeResetRef.current = onScopeReset;

  const trackComposerRevision = useCallback(
    (revision: number): void => {
      composerEditRevision.current = revision;
      setCommandInputError(null);
      for (const notice of runtime.store.getSnapshot().view.commandNotices)
        if (notice.kind === "error") runtime.store.consumeCommand(notice.id);
    },
    [runtime],
  );

  useLayoutEffect(() => {
    commandScopeGeneration.current += 1;
    setStructuredOverlay(null);
    setComposerPrefill(null);
    setCommandInputError(null);
    onScopeResetRef.current();
    return (): void => {
      commandScopeGeneration.current += 1;
    };
  }, [draftScopeKey, client]);

  const openOverlayForSlashText = useCallback(
    async (text: string): Promise<boolean | "goal-resume-with-arguments"> => {
      const generation = commandScopeGeneration.current;
      let catalog: UiWebCommandCatalog;
      try {
        catalog = await runtime.listWebCommands();
      } catch {
        return false;
      }
      if (generation !== commandScopeGeneration.current) return false;
      const resolved = resolveSlashCommand(
        catalog,
        parseSlashCommandInput(text),
        { surface: "tui" },
      );
      if (!resolved.ok) {
        return false;
      }
      const command = catalog.commands.find(
        (candidate) => candidate.id === resolved.command.id,
      );
      if (command?.executionKind !== "overlay") {
        return false;
      }
      const kind = structuredOverlayKindForAction(command.action);
      if (!kind) {
        return false;
      }
      if (
        kind === "goal" &&
        resolved.argv[0] === "resume" &&
        (resolved.argv.length > 1 || resolved.body.trim().length > 0)
      ) {
        return "goal-resume-with-arguments";
      }
      setStructuredOverlay({
        commandLabel: slashCommandLabel(command),
        ...(kind === "goal"
          ? {
              goalIntent: goalPanelIntentFromArgs(
                [resolved.rawArgs, resolved.body].join("\n"),
              ),
            }
          : {}),
        kind,
      });
      return true;
    },
    [runtime],
  );

  const openGoalPanel = useCallback((intent?: GoalPanelIntent) => {
    setStructuredOverlay({
      commandLabel: "/goal",
      goalIntent: intent ?? DEFAULT_GOAL_PANEL_INTENT,
      kind: "goal",
    });
  }, []);

  const openStructuredCommand = useCallback(
    (request: StructuredCommandRequest) => {
      const { item, text } = request;
      const kind = structuredOverlayKindForAction(item.action);
      if (!kind) {
        return;
      }
      setStructuredOverlay({
        commandLabel: item.label,
        ...(kind === "goal"
          ? {
              goalIntent: goalPanelIntentFromArgs(
                text.startsWith(item.label)
                  ? text.slice(item.label.length)
                  : "",
              ),
            }
          : {}),
        kind,
      });
    },
    [],
  );

  const prefillComposer = useCallback(
    (text: string): void => {
      composerPrefillNonce.current += 1;
      setComposerPrefill({
        nonce: composerPrefillNonce.current,
        scopeKey: draftScopeKey,
        editRevision: composerEditRevision.current,
        text,
      });
    },
    [draftScopeKey],
  );

  return {
    commandScopeGeneration,
    composerEditRevision,
    structuredOverlay,
    closeStructuredOverlay: useCallback(() => {
      setStructuredOverlay(null);
    }, []),
    composerPrefill,
    prefillComposer,
    commandInputError,
    setCommandInputError,
    trackComposerRevision,
    openOverlayForSlashText,
    openGoalPanel,
    openStructuredCommand,
  };
}
