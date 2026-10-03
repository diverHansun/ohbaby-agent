import { EventEmitter } from "node:events";
import { Box, render, Text } from "ink";
import {
  createSubagentReader,
  type UiSubagentExecutionList,
  type UiSubagentReaderState,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { useSubagentState } from "./use-subagent-state.js";

class FakeStdout extends EventEmitter {
  readonly columns = 80;
  readonly rows = 12;
  readonly isTTY = true;
  readonly chunks: string[] = [];
  readonly write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };
}
class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  read(): null {
    return null;
  }
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
}
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));
const initialList: UiSubagentExecutionList = {
  executions: [],
  hasMore: false,
  waiting: true,
  approvalBlocked: false,
  activeCount: 1,
  completedCount: 0,
};

function mount(node: ReactElement, stdout: FakeStdout) {
  return render(node, {
    exitOnCtrlC: false,
    incrementalRendering: true,
    patchConsole: false,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
}

describe("root subagent subscription", () => {
  it("produces no long-frame writes for equivalent real-reader refreshes but delivers visible changes", async () => {
    let list = initialList;
    const reader = createSubagentReader(
      {
        listSubagentExecutions: () =>
          Promise.resolve({
            ...list,
            executions: [...list.executions],
          }),
        getSubagentExecutionView: () =>
          Promise.reject(new Error("No selection")),
      },
      "root",
    );
    await reader.refresh();
    let observed: UiSubagentReaderState | undefined;
    function View(): ReactElement {
      observed = useSubagentState(reader, false);
      return (
        <Box flexDirection="column">
          <Text>{"stable history\n".repeat(40)}</Text>
          <Text>
            {observed.list?.completedCount} done · {observed.list?.activeCount}{" "}
            open · {String(observed.list?.approvalBlocked)}
          </Text>
        </Box>
      );
    }
    const stdout = new FakeStdout();
    const app = mount(<View />, stdout);
    try {
      await tick();
      const baseline = stdout.chunks.length;
      const snapshot = observed;
      for (let i = 0; i < 3; i += 1) {
        await reader.refresh();
        await tick();
      }
      expect(stdout.chunks.slice(baseline).join("")).toBe("");
      expect(observed).toBe(snapshot);
      list = {
        ...list,
        completedCount: 1,
        activeCount: 0,
        approvalBlocked: true,
      };
      await reader.refresh();
      await tick();
      expect(observed?.list).toMatchObject({
        completedCount: 1,
        activeCount: 0,
        approvalBlocked: true,
      });
      expect(stdout.chunks.slice(baseline).join("")).toContain(
        "1 done · 0 open · true",
      );
    } finally {
      app.unmount();
      reader.dispose();
    }
  });

  it("exposes current complete state on opening and preserves loading and errors while browsing", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    let fail = false;
    const reader = createSubagentReader(
      {
        listSubagentExecutions: () =>
          fail
            ? new Promise<UiSubagentExecutionList>((_resolve, reject) => {
                rejectRequest = reject;
              })
            : Promise.resolve(initialList),
        getSubagentExecutionView: () =>
          Promise.reject(new Error("No selection")),
      },
      "root",
    );
    await reader.refresh();
    let observed: UiSubagentReaderState | undefined;
    function View({ open }: { open: boolean }): ReactElement {
      observed = useSubagentState(reader, open);
      return (
        <Text>
          {observed.loading ? "Loading" : (observed.error ?? "ready")}
        </Text>
      );
    }
    const stdout = new FakeStdout();
    const app = mount(<View open={false} />, stdout);
    try {
      await tick();
      fail = true;
      const request = reader.refresh();
      await tick();
      expect(reader.getSnapshot().loading).toBe(true);
      expect(observed?.loading).toBe(false);
      app.rerender(<View open />);
      await tick();
      expect(observed).toBe(reader.getSnapshot());
      expect(observed?.loading).toBe(true);
      rejectRequest?.(new Error("offline"));
      await request;
      await tick();
      expect(observed).toBe(reader.getSnapshot());
      expect(observed?.error).toBe("offline");
      expect(observed?.loading).toBe(false);
    } finally {
      app.unmount();
      reader.dispose();
    }
  });

  it("does not reuse cached summaries across readers or sessions", async () => {
    const first = createSubagentReader({}, "first");
    const second = createSubagentReader({}, "second");
    let observed: UiSubagentReaderState | undefined;
    function View({ reader }: { reader: typeof first }): ReactElement {
      observed = useSubagentState(reader, false);
      return <Text>root</Text>;
    }
    const app = mount(<View reader={first} />, new FakeStdout());
    try {
      await tick();
      expect(observed).toBe(first.getSnapshot());
      app.rerender(<View reader={second} />);
      await tick();
      expect(observed).toBe(second.getSnapshot());
    } finally {
      app.unmount();
      first.dispose();
      second.dispose();
    }
  });
});
