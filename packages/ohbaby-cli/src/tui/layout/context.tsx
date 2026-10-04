import { createContext, useContext } from "react";
import type { DOMElement } from "ink";
import type { RefObject, ReactElement, ReactNode } from "react";
import { computeLayoutMetrics, type TuiLayoutMetrics } from "./metrics.js";

const DEFAULT_METRICS = computeLayoutMetrics({ columns: 80, rows: 24 });

export const LiveTailRefContext = createContext<
  RefObject<DOMElement | null> | undefined
>(undefined);

export const TodoPanelRefContext = createContext<
  RefObject<DOMElement | null> | undefined
>(undefined);

export const TranscriptAnchorContext = createContext<
  Map<string, DOMElement> | undefined
>(undefined);

export const TranscriptWindowContext = createContext<
  { top: number; height: number } | undefined
>(undefined);

export const TranscriptDocumentContext = createContext(false);

const LayoutContext = createContext<TuiLayoutMetrics>(DEFAULT_METRICS);

export interface LayoutProviderProps {
  readonly children: ReactNode;
  readonly value: TuiLayoutMetrics;
}

export function LayoutProvider({
  children,
  value,
}: LayoutProviderProps): ReactElement {
  return (
    <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
  );
}

export function useTuiLayout(): TuiLayoutMetrics {
  return useContext(LayoutContext);
}
