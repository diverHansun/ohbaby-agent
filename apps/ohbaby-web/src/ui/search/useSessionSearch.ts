import { useCallback, useEffect, useRef, useState } from "react";
import type { UiSessionSearchPage, UiSessionSearchResult } from "ohbaby-sdk";

export type SessionSearch = (input: {
  query: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}) => Promise<UiSessionSearchPage>;

interface SearchState {
  query: string;
  setQuery: (query: string) => void;
  results: readonly UiSessionSearchResult[];
  nextCursor: string | undefined;
  loading: boolean;
  error: string | undefined;
  ready: boolean;
  loadMore: () => void;
  retry: () => void;
}
export function useSessionSearch(
  open: boolean,
  search: SessionSearch,
): SearchState {
  const [query, setQuery] = useState("");
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
  const changeQuery = useCallback(
    (value: string) => {
      cancel();
      setQuery(value);
    },
    [cancel],
  );
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
    [query, search],
  );
  useEffect(() => {
    cancel();
    setError(undefined);
    setReady(false);
    setNextCursor(undefined);
    if (!open || !query.trim()) {
      setResults([]);
      setLoading(false);
      if (!open) setQuery("");
      return;
    }
    setLoading(true);
    timer.current = setTimeout(() => {
      void run();
    }, 250);
    return cancel;
  }, [open, query, run, cancel]);
  return {
    query,
    setQuery: changeQuery,
    results,
    nextCursor,
    loading,
    error,
    ready,
    loadMore: (): void => {
      if (!loading && nextCursor) void run(nextCursor);
    },
    retry: (): void => {
      void run(failedCursor.current);
    },
  };
}
