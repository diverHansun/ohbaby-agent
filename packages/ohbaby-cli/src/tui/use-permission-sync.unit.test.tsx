import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type {
  CoreAPI,
  UiPermissionSnapshot,
  UiSessionIndexEntry,
} from "ohbaby-sdk";
import type { TuiStore } from "./store/snapshot.js";
import { usePermissionSync } from "./use-permission-sync.js";

const root: UiSessionIndexEntry = {
  id: "root",
  title: "Root",
  createdAt: "2026-09-25T00:00:00Z",
  updatedAt: "2026-09-25T00:00:00Z",
};
const baseline: UiPermissionSnapshot = {
  permissionEpoch: "epoch",
  rootSessionId: "root",
  permissionRevision: 0,
  requests: [],
};

function fixture(): {
  client: CoreAPI;
  store: TuiStore;
  index: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const index = vi
    .fn<() => Promise<readonly UiSessionIndexEntry[]>>()
    .mockResolvedValue([root]);
  const query = vi
    .fn<CoreAPI["getPermissionSnapshot"]>()
    .mockResolvedValue(baseline);
  const client = {
    getSessionIndex: index,
    getPermissionSnapshot: query,
    subscribePermissionEvents: () => (): void => undefined,
  } as unknown as CoreAPI;
  const store = { setPermissions: vi.fn() } as unknown as TuiStore;
  return { client, store, index, query };
}

function Probe({
  client,
  store,
}: {
  client: CoreAPI;
  store: TuiStore;
}): React.ReactElement {
  const { state } = usePermissionSync(client, store, "root");
  return (
    <Text>
      {state.status}:{state.attempts}
    </Text>
  );
}

describe("TUI approval bootstrap attempts", () => {
  it("fetches fresh metadata after a transient index failure without manual retry", async () => {
    const test = fixture();
    test.index.mockRejectedValueOnce(new Error("temporary metadata failure"));
    const app = render(<Probe {...test} />);
    try {
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain("ready:");
      });
      expect(test.index).toHaveBeenCalledTimes(2);
      expect(test.query).toHaveBeenCalledTimes(2);
    } finally {
      app.unmount();
      app.cleanup();
    }
  });

  it("does not reuse stale metadata when retrying a failed snapshot", async () => {
    const test = fixture();
    test.index.mockResolvedValueOnce([]);
    test.query.mockRejectedValueOnce(new Error("temporary snapshot failure"));
    const app = render(<Probe {...test} />);
    try {
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain("ready:");
      });
      expect(test.index).toHaveBeenCalledTimes(2);
      expect(test.query).toHaveBeenCalledTimes(2);
    } finally {
      app.unmount();
      app.cleanup();
    }
  });

  it.each([false, true])(
    "aborts outstanding snapshots on metadata failure (unavailable=%s)",
    async (unavailable) => {
      const test = fixture();
      test.index.mockRejectedValue(
        Object.assign(
          new Error("metadata failed"),
          unavailable ? { code: "PERMISSION_UNAVAILABLE" } : {},
        ),
      );
      const signals: AbortSignal[] = [];
      test.query.mockImplementation((input: { signal?: AbortSignal }) => {
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        if (!input.signal) throw new Error("Missing bootstrap signal");
        signals.push(input.signal);
        return new Promise<UiPermissionSnapshot>(() => undefined);
      });
      const app = render(<Probe {...test} />);
      try {
        await vi.waitFor(
          () => {
            expect(app.lastFrame()).toContain(
              unavailable ? "unavailable:1" : "error:4",
            );
          },
          { timeout: 2000 },
        );
        expect(signals).toHaveLength(unavailable ? 1 : 4);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(test.index).toHaveBeenCalledTimes(unavailable ? 1 : 4);
      } finally {
        app.unmount();
        app.cleanup();
      }
    },
  );
});
