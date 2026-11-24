import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../render/wrap.js";
import {
  detailHeader,
  keyLine,
  lineText,
  taskListModel,
  taskRowLine,
  TRAILING_WIDTH,
} from "./task-lines.js";
import { NOW, taskRow, typicalRows } from "./test-fixtures.js";

const background = typicalRows().filter((row) => row.mode === "background");

describe("background task lines", () => {
  it.each([72, 60, 44])(
    "never exceeds %i columns and keeps the right column whole",
    (width) => {
      for (const row of background) {
        const line = lineText(
          taskRowLine({
            row,
            now: NOW,
            width,
            selected: false,
            showOwner: true,
            cancelling: false,
          }),
        );
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line.slice(-TRAILING_WIDTH).trim()).toMatch(
          /^(\d+[smh]( \d+m)?|Failed|Timed out|Cancelled|Unknown)$/u,
        );
      }
    },
  );

  it("shows the command from 60 columns and drops it below (03 §5)", () => {
    const row = background[0];
    const line = (width: number): string =>
      lineText(
        taskRowLine({
          row,
          now: NOW,
          width,
          selected: false,
          showOwner: false,
          cancelling: false,
        }),
      );
    expect(line(72)).toContain("pnpm");
    expect(line(44)).not.toContain("pnpm");
    expect(line(44)).toContain("Dev server");
  });

  it("keeps the time column width while a task is cancelling", () => {
    const row = background[1];
    const base = {
      row,
      now: NOW,
      width: 72,
      selected: true,
      showOwner: false,
    };
    const idle = lineText(taskRowLine({ ...base, cancelling: false }));
    const busy = lineText(taskRowLine({ ...base, cancelling: true }));
    expect(visibleWidth(busy)).toBe(visibleWidth(idle));
    expect(busy).toContain("Cancelling…");
    expect(idle.startsWith("› ")).toBe(true);
  });

  it("groups by status with backend counts and marks only failures", () => {
    const model = taskListModel({
      rows: background,
      now: NOW,
      width: 72,
      selected: 0,
      filter: "main",
      cancelling: new Set(),
    });
    const text = model.lines.map(lineText);
    expect(text[0]).toBe("Running 2");
    expect(text).toContain("Done 3");
    expect(model.rows.map((row) => row.jobId)).toEqual([
      "dev",
      "watch",
      "unit",
      "build",
      "tsc",
    ]);
    const failures = model.lines.filter((line) =>
      line.some((segment) => segment.tone === "error"),
    );
    expect(failures).toHaveLength(1);
  });

  it("caps a long command at three rows in the detail header", () => {
    const header = detailHeader({
      row: taskRow("long", { command: "x".repeat(400) }),
      now: NOW,
      width: 60,
      cancelling: false,
    });
    const commandRows = header.slice(1).map(lineText);
    expect(commandRows).toHaveLength(3);
    expect(commandRows[2]?.endsWith("…")).toBe(true);
  });

  it("lists only keys that work now", () => {
    expect(
      lineText(
        keyLine({
          view: "list",
          canCancel: false,
          filterable: false,
          following: true,
          retry: false,
        }),
      ),
    ).toBe("↑/↓ select · Enter open · Esc close");
    expect(
      lineText(
        keyLine({
          view: "detail",
          canCancel: true,
          filterable: true,
          following: false,
          retry: true,
        }),
      ),
    ).toBe("↑/↓ scroll · End follow · c cancel · r retry · Esc back");
  });
});
