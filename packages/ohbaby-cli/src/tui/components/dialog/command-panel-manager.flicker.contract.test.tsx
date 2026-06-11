import { EventEmitter } from "node:events";
import { render } from "ink";
import { render as renderForFrames } from "ink-testing-library";
import type { CoreAPI } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AppShell } from "../../layout/app-shell.js";
import { ThemeProvider } from "../../theme/index.js";
import {
  CommandPanelManager,
  resolveSkillsPanelVisibleLines,
} from "./command-panel-manager.js";
import type { DisplayCommandPanelState } from "./command-panel-state.js";

const ERASE_SCREEN = "[2J";
const PAGE_DOWN = "[6~";

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly chunks: string[] = [];

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }

  readonly write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };

  output(): string {
    return this.chunks.join("");
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private readonly queue: string[] = [];

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
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  read(): string | null {
    return this.queue.shift() ?? null;
  }

  write(data: string): void {
    this.queue.push(data);
    this.emit("readable");
  }
}

describe("skills panel rendering contract", () => {
  it("pages with pgdn without falling back to full-screen clears", async () => {
    const stdout = new FakeStdout(80, 24);
    const stdin = new FakeStdin();
    const app = render(panelScene(skillsPanel(22)), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      await until(() => stdout.output().includes("showing 1-10 of 22"));
      stdin.write(PAGE_DOWN);
      await until(() => stdout.output().includes("showing 11-20 of 22"));

      expect(stdout.output()).not.toContain(ERASE_SCREEN);
    } finally {
      app.unmount();
    }
  });

  it("shrinks the page size on short terminals instead of clearing per frame", async () => {
    const stdout = new FakeStdout(80, 16);
    const stdin = new FakeStdin();
    const app = render(panelScene(skillsPanel(22)), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      await until(() => stdout.output().includes("showing 1-3 of 22"));
      stdin.write(PAGE_DOWN);
      await until(() => stdout.output().includes("showing 4-6 of 22"));

      expect(stdout.output()).not.toContain(ERASE_SCREEN);
    } finally {
      app.unmount();
    }
  });

  it("keeps each skill row on a single truncated line", async () => {
    const app = renderForFrames(panelScene(skillsPanel(12)));

    try {
      await until(() =>
        (app.lastFrame() ?? "").includes("showing 1-10 of 12"),
      );

      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("skill-with-very-long-name-01");
      expect(frame).not.toContain("ZZTAIL");
    } finally {
      app.unmount();
    }
  });

  it("resets the selection when a new skills panel opens", async () => {
    const app = renderForFrames(panelScene(skillsPanel(22, "inv_1")));

    try {
      await until(() => (app.lastFrame() ?? "").includes("showing 1-10 of 22"));
      app.stdin.write(PAGE_DOWN);
      await until(() =>
        (app.lastFrame() ?? "").includes("showing 11-20 of 22"),
      );

      app.rerender(panelScene(null));
      app.rerender(panelScene(skillsPanel(22, "inv_2")));
      await until(() => (app.lastFrame() ?? "").includes("showing 1-10 of 22"));

      expect(app.lastFrame() ?? "").toContain("> skill-with-very-long-name-01");
    } finally {
      app.unmount();
    }
  });
});

describe("resolveSkillsPanelVisibleLines", () => {
  it("keeps ten lines per page on tall terminals", () => {
    expect(resolveSkillsPanelVisibleLines(40)).toBe(10);
    expect(resolveSkillsPanelVisibleLines(24)).toBe(10);
  });

  it("degrades with the terminal height down to a floor", () => {
    expect(resolveSkillsPanelVisibleLines(20)).toBe(6);
    expect(resolveSkillsPanelVisibleLines(16)).toBe(3);
    expect(resolveSkillsPanelVisibleLines(8)).toBe(3);
  });

  it("falls back to the full page when rows are unknown", () => {
    expect(resolveSkillsPanelVisibleLines(Number.NaN)).toBe(10);
  });
});

function panelScene(panel: DisplayCommandPanelState | null): ReactElement {
  return (
    <ThemeProvider>
      <AppShell>
        <CommandPanelManager
          catalog={null}
          client={{} as unknown as CoreAPI}
          contextWindowUsage={null}
          onClose={() => undefined}
          panel={panel}
          runtime={{ kind: "idle" }}
        />
      </AppShell>
    </ThemeProvider>
  );
}

function skillsPanel(
  count: number,
  clientInvocationId = "inv_1",
): DisplayCommandPanelState {
  return {
    clientInvocationId,
    kind: "skills",
    mode: "display",
    openedAt: 0,
    output: {
      data: { skills: skillsFixture(count) },
      kind: "data",
      subject: "skills",
    },
    sessionId: "session_1",
    status: "ready",
  };
}

function skillsFixture(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    return {
      // Keep the marker inside formatSkillRow's 64-char description budget so
      // it only disappears when the row itself stops wrapping.
      description: `${"d".repeat(52)}ZZTAIL`,
      name: `skill-with-very-long-name-${ordinal}`,
      scope: "user",
      source: "project-native",
    };
  });
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for frame condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}
