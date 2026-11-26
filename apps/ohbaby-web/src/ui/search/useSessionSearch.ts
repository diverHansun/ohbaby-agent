import { useCallback, useEffect, useRef, useState } from "react";
import type { UiSessionSearchPage, UiSessionSearchResult } from "ohbaby-sdk";

export type SearchOrder = "desc" | "asc";

export type SessionSearch = (input: {
  query: string;
  order?: SearchOrder;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}) => Promise<UiSessionSearchPage>;

interface SearchState {
  query: string;
  setQuery: (query: string) => void;
  order: SearchOrder;
  toggleOrder: () => void;
  results: readonly UiSessionSearchResult[];
  nextCursor: string | undefined;
  loading: boolean;
  error: string | undefined;
  /** The current query has answered at least once. */
  ready: boolean;
  loadMore: () => void;
  retry: () => void;
}

const DEBOUNCE_MS = 250;

/**
 * Server search for the open search dialog. The hook lives as long as the
 * dialog, so reopening starts from an empty query and newest first. A new
 * query or order drops the previous results at once, so Enter never opens a
 * row from an earlier answer.
 */
export function useSessionSearch(search: SessionSearch): SearchState {
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<SearchOrder>("desc");
  const [results, setResults] = useState<readonly UiSessionSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const failedCursor = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    generation.current += 1;
    request.current?.abort();
    clearTimeout(timer.current);
  }, []);
  const run = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const current = ++generation.current;
      setLoading(true);
      setError(undefined);
      failedCursor.current = cursor;
      try {
        const page = await search({
          query: query.trim(),
          order,
          ...(cursor ? { cursor } : {}),
          signal: controller.signal,
        });
        if (current !== generation.current || controller.signal.aborted) return;
        setResults((previous) =>
          cursor
            ? [
                ...previous,
                ...page.results.filter(
                  (result) =>
                    !previous.some(
                      (existing) => existing.session.id === result.session.id,
                    ),
                ),
              ]
            : page.results,
        );
        setNextCursor(page.nextCursor);
        setReady(true);
      } catch (cause) {
        if (current !== generation.current || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Search failed");
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [query, order, search],
  );
  useEffect(() => {
    cancel();
    setError(undefined);
    setReady(false);
    setNextCursor(undefined);
    setResults([]);
    if (!query.trim()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(() => {
      void run();
    }, DEBOUNCE_MS);
    return cancel;
  }, [query, order, run, cancel]);
  return {
    query,
    setQuery,
    order,
    toggleOrder: (): void => {
      setOrder((current) => (current === "desc" ? "asc" : "desc"));
    },
    results,
    nextCursor,
    loading,
    error,
    ready,
    loadMore: (): void => {
      if (!loading && !error && nextCursor) void run(nextCursor);
    },
    retry: (): void => {
      void run(failedCursor.current);
    },
  };
}
