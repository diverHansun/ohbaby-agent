import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import xterm from "@xterm/headless";

const { Terminal } = xterm;
const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: node scripts/validate-tui-improve4-pty.mjs <evidence-directory>",
  );
const results = [];

for (const filename of (await readdir(directory)).filter((name) =>
  name.endsWith(".phases.json"),
)) {
  const capture = JSON.parse(
    await readFile(path.join(directory, filename), "utf8"),
  );
  const data = await readFile(path.join(directory, `${capture.case}.ansi`));
  const term = new Terminal({
    cols: capture.initialColumns,
    rows: capture.initialRows,
    allowProposedApi: true,
    scrollback: 10000,
  });
  const snapshots = [];
  let offset = 0;
  try {
    for (const phase of capture.phases) {
      await new Promise((resolve) =>
        term.write(data.subarray(offset, phase.offset), resolve),
      );
      offset = phase.offset;
      const buffer = term.buffer.active;
      const lines = Array.from(
        { length: term.rows },
        (_, index) =>
          buffer
            .getLine(buffer.viewportY + index)
            ?.translateToString(true, 0, term.cols) ?? "",
      );
      snapshots.push({
        ...phase,
        buffer: buffer.type,
        cursor: [buffer.cursorX, buffer.cursorY],
        base: buffer.baseY,
        viewport: buffer.viewportY,
        mouse: term.modes.mouseTrackingMode,
        lines,
      });
      if (phase.resizeTo)
        term.resize(phase.resizeTo.columns, phase.resizeTo.rows);
    }
    await writeFile(
      path.join(directory, `${capture.case}.screens.json`),
      JSON.stringify(snapshots, null, 2),
    );
    const get = (name) => {
      const snapshot = snapshots.find((item) => item.name === name);
      assert(snapshot, `${capture.case}: missing phase ${name}`);
      return snapshot;
    };
    const text = (name) => get(name).lines.join("\n");
    const has = (name, wanted) =>
      assert(
        text(name).includes(wanted),
        `${capture.case} ${name}: expected visible ${wanted}\n${text(name)}`,
      );
    for (const snapshot of snapshots.filter((item) => item.name !== "exited")) {
      assert.equal(
        snapshot.buffer,
        "alternate",
        `${capture.case} ${snapshot.name}: buffer owner`,
      );
      assert.equal(
        snapshot.base,
        0,
        `${capture.case} ${snapshot.name}: alternate output overflow`,
      );
      assert(
        !snapshot.lines
          .join("\n")
          .includes("INTERNAL_OBSERVATION_DO_NOT_DISPLAY"),
      );
      if (snapshot.newest) has(snapshot.name, snapshot.newest);
    }
    has("draft", "保留草稿");
    const history = snapshots.filter((item) =>
      item.name.startsWith("history-"),
    );
    assert(
      history.some((item) =>
        item.lines.some((line) => line.includes("STREAM-000")),
      ),
      `${capture.case}: first streaming row is unreachable before completion`,
    );
    assert.notDeepEqual(
      get("wheel-pinned").lines.slice(0, 2),
      get("latest-before-wheel").lines.slice(0, 2),
      `${capture.case}: mouse wheel did not move the document`,
    );
    assert.deepEqual(
      get("wheel-burst").lines,
      get("wheel-stepped").lines,
      `${capture.case}: batched wheel reports lost scroll distance`,
    );
    assert(
      !text("wheel-follow-restored").includes("History ·"),
      `${capture.case}: scrolling to the bottom did not restore follow mode`,
    );
    for (const name of ["wheel-stream-65", "wheel-stream-70"])
      assert.deepEqual(
        get(name).lines,
        get("wheel-pinned").lines,
        `${capture.case}: new token moved pinned document at ${name}`,
      );
    has("tasks-expanded", "Tasks");
    for (const name of [
      "tasks-expanded",
      "tasks-stream",
      "resized",
      "resize-restored",
      "approval-resolved",
    ])
      has(name, "保留草稿");
    has("approval", "Allow once");
    has("approval", "Deny");
    has("approval-deny-selected", "> Deny");
    assert(!text("approval").includes("Option:"));
    assert.deepEqual(
      get("refresh").lines,
      get("complete").lines,
      `${capture.case}: equivalent snapshot changed visible cells`,
    );
    has("table-start", "TABLE19");
    has("table-token-10", "xxxxxxxxxx");
    has("list-start", "LIST19");
    has("list-token-10", "xxxxxxxxxx");
    assert(
      snapshots
        .filter((item) => item.name.startsWith("prose-history-"))
        .some((item) =>
          item.lines.some((line) => line.includes("PROSE-FIRST")),
        ),
      `${capture.case}: earlier soft-wrapped paragraph content is unreachable during generation`,
    );
    assert.notDeepEqual(
      get("prose-wheel-pinned").lines.slice(0, 2),
      get("prose-latest").lines.slice(0, 2),
      `${capture.case}: prose wheel did not scroll`,
    );
    for (const name of ["prose-wheel-stream-5", "prose-wheel-stream-10"])
      assert.deepEqual(
        get(name).lines,
        get("prose-wheel-pinned").lines,
        `${capture.case}: soft-wrap tokens moved pinned prose at ${name}`,
      );
    const exited = get("exited");
    assert.equal(exited.buffer, "normal");
    assert.equal(exited.mouse, "none");
    const normal = Array.from(
      { length: term.buffer.normal.length },
      (_, index) =>
        term.buffer.normal
          .getLine(index)
          ?.translateToString(true, 0, term.cols) ?? "",
    ).join("\n");
    for (const wanted of [
      "SHELL-SENTINEL",
      "SHELL-RESTORED",
      "STREAM-000",
      "STREAM-074",
      "TABLE00",
      "TABLE19",
      "LIST00",
      "LIST19",
      "PROSE-FIRST",
      "PROSE-10",
    ])
      assert(
        normal.includes(wanted),
        `${capture.case}: exit transcript missing ${wanted}`,
      );
    for (const forbidden of [
      "INTERNAL_OBSERVATION_DO_NOT_DISPLAY",
      "Allow once",
      "Ctrl+T expand",
      "STREAM-APPROVAL",
    ])
      assert(
        !normal.includes(forbidden),
        `${capture.case}: exit transcript leaked transient UI ${forbidden}`,
      );
    await writeFile(
      path.join(directory, `${capture.case}.exit-transcript.txt`),
      normal,
    );
    const result = {
      case: capture.case,
      phases: snapshots.length,
      passed: true,
      normalRows: term.buffer.normal.length,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  } finally {
    term.dispose();
  }
}
await writeFile(
  path.join(directory, "cells-summary.json"),
  JSON.stringify(results, null, 2),
);
