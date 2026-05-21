import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import {
  createToolScheduler,
  type PolicyPort,
  type ToolSchedulerInstance,
} from "../core/tool-scheduler/index.js";
import { createHostLocalEnvironment } from "../adapters/ui-runtime/host-local-environment.js";
import { createBuiltinTools } from "./index.js";

function createAllowPolicy(): PolicyPort {
  return {
    check: () => ({ type: "allow" }),
    getMode: () => "agent",
  };
}

function createScheduler(): ToolSchedulerInstance {
  const scheduler = createToolScheduler({
    bus: createBus(),
    policy: createAllowPolicy(),
  });
  for (const tool of createBuiltinTools()) {
    scheduler.register(tool);
  }

  return scheduler;
}

describe("file tools scheduler integration", () => {
  let outsideRoot: string;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-file-scheduler-")),
    );
    outsideRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-file-outside-")),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(outsideRoot, { force: true, recursive: true });
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("routes write dry_run and absolute-path writes through ToolScheduler", async () => {
    const scheduler = createScheduler();
    const environment = createHostLocalEnvironment(tempRoot);
    const absolutePath = path.join(tempRoot, "nested", "note.txt");

    const preview = await scheduler.execute({
      callId: "write_preview",
      environment,
      messageId: "message_1",
      params: {
        content: "hello\n",
        dry_run: true,
        file_path: absolutePath,
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(preview.status).toBe("success");
    expect(preview.output).toContain("Dry run: no changes written.");
    expect(preview.output).toContain("@@ -0,0 +1,1 @@");
    await expect(fs.access(absolutePath)).rejects.toThrow();

    const write = await scheduler.execute({
      callId: "write_actual",
      environment,
      messageId: "message_1",
      params: {
        content: "hello\n",
        file_path: absolutePath,
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(write.status).toBe("success");
    await expect(fs.readFile(absolutePath, "utf8")).resolves.toBe("hello\n");
  });

  it("enforces write mtime preconditions through ToolScheduler", async () => {
    const scheduler = createScheduler();
    const environment = createHostLocalEnvironment(tempRoot);
    const filePath = path.join(tempRoot, "note.txt");
    await fs.writeFile(filePath, "old\n", "utf8");

    const missingMtime = await scheduler.execute({
      callId: "write_missing_mtime",
      environment,
      messageId: "message_1",
      params: {
        content: "new\n",
        file_path: "note.txt",
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(missingMtime.status).toBe("error");
    expect(missingMtime.error?.message).toContain("expected_mtime_ms is required");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("old\n");

    const staleMtime = await scheduler.execute({
      callId: "write_stale_mtime",
      environment,
      messageId: "message_1",
      params: {
        content: "new\n",
        expected_mtime_ms: 1,
        file_path: "note.txt",
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(staleMtime.status).toBe("error");
    expect(staleMtime.error?.message).toContain("mtime mismatch");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("old\n");

    const currentMtime = (await fs.stat(filePath)).mtimeMs;
    const success = await scheduler.execute({
      callId: "write_matching_mtime",
      environment,
      messageId: "message_1",
      params: {
        content: "new\n",
        expected_mtime_ms: currentMtime,
        file_path: "note.txt",
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(success.status).toBe("success");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new\n");
  });

  it("surfaces atomic rename failures through ToolScheduler and cleans temporary files", async () => {
    const scheduler = createScheduler();
    const environment = createHostLocalEnvironment(tempRoot);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    const result = await scheduler.execute({
      callId: "write_rename_failure",
      environment,
      messageId: "message_1",
      params: {
        content: "hello\n",
        file_path: "note.txt",
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("rename failed");
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });

  it("rejects absolute paths outside the workspace for read, write, and edit", async () => {
    const scheduler = createScheduler();
    const environment = createHostLocalEnvironment(tempRoot);
    const outsidePath = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(outsidePath, "secret\n", "utf8");

    const read = await scheduler.execute({
      callId: "read_outside",
      environment,
      messageId: "message_1",
      params: { file_path: outsidePath },
      sessionId: "session_1",
      toolName: "read",
    });
    const write = await scheduler.execute({
      callId: "write_outside",
      environment,
      messageId: "message_1",
      params: {
        content: "changed\n",
        file_path: outsidePath,
      },
      sessionId: "session_1",
      toolName: "write",
    });
    const edit = await scheduler.execute({
      callId: "edit_outside",
      environment,
      messageId: "message_1",
      params: {
        expected_mtime_ms: (await fs.stat(outsidePath)).mtimeMs,
        file_path: outsidePath,
        new_string: "changed",
        old_string: "secret",
      },
      sessionId: "session_1",
      toolName: "edit",
    });

    expect(read.status).toBe("error");
    expect(write.status).toBe("error");
    expect(edit.status).toBe("error");
    expect(read.error?.message).toContain("escapes workspace");
    expect(write.error?.message).toContain("escapes workspace");
    expect(edit.error?.message).toContain("escapes workspace");
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("secret\n");
  });

  it("does not create directories through symlinked absolute-path parents before rejecting writes", async () => {
    const scheduler = createScheduler();
    const environment = createHostLocalEnvironment(tempRoot);
    const linkedPath = path.join(tempRoot, "linked-outside");
    await fs.symlink(outsideRoot, linkedPath, "junction");
    const escapedTarget = path.join(linkedPath, "newdir", "note.txt");
    const escapedDirectory = path.join(outsideRoot, "newdir");

    const result = await scheduler.execute({
      callId: "write_symlink_escape",
      environment,
      messageId: "message_1",
      params: {
        content: "escape\n",
        file_path: escapedTarget,
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("escapes workspace");
    await expect(fs.access(escapedDirectory)).rejects.toThrow();
  });

  it("requires scheduler read before edit and supports edit dry_run", async () => {
    const scheduler = createScheduler();
    const environment = createHostLocalEnvironment(tempRoot);
    const filePath = path.join(tempRoot, "note.txt");
    await fs.writeFile(filePath, "old\n", "utf8");
    const staleFreeMtime = (await fs.stat(filePath)).mtimeMs;

    const editWithoutRead = await scheduler.execute({
      callId: "edit_without_read",
      environment,
      messageId: "message_1",
      params: {
        expected_mtime_ms: staleFreeMtime,
        file_path: "note.txt",
        new_string: "new",
        old_string: "old",
      },
      sessionId: "session_requires_read",
      toolName: "edit",
    });

    expect(editWithoutRead.status).toBe("error");
    expect(editWithoutRead.error?.message).toContain("must be read before edit");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("old\n");

    const read = await scheduler.execute({
      callId: "read_before_edit",
      environment,
      messageId: "message_1",
      params: { file_path: "note.txt" },
      sessionId: "session_edit",
      toolName: "read",
    });
    expect(read.status).toBe("success");
    const mtimeMs = read.metadata?.mtimeMs;
    expect(mtimeMs).toEqual(expect.any(Number));

    const otherSessionEdit = await scheduler.execute({
      callId: "edit_other_session",
      environment,
      messageId: "message_1",
      params: {
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
        new_string: "new",
        old_string: "old",
      },
      sessionId: "session_other",
      toolName: "edit",
    });

    expect(otherSessionEdit.status).toBe("error");
    expect(otherSessionEdit.error?.message).toContain("must be read before edit");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("old\n");

    const preview = await scheduler.execute({
      callId: "edit_preview",
      environment,
      messageId: "message_1",
      params: {
        dry_run: true,
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
        new_string: "new",
        old_string: "old",
      },
      sessionId: "session_edit",
      toolName: "edit",
    });

    expect(preview.status).toBe("success");
    expect(preview.output).toContain("Dry run: no changes written.");
    expect(preview.output).toContain("@@ -1,1 +1,1 @@");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("old\n");

    await fs.writeFile(filePath, "old external\n", "utf8");
    await fs.utimes(filePath, new Date(), new Date(Date.now() + 2_000));
    const modifiedMtime = (await fs.stat(filePath)).mtimeMs;
    const staleReadStateEdit = await scheduler.execute({
      callId: "edit_stale_read_state",
      environment,
      messageId: "message_1",
      params: {
        expected_mtime_ms: modifiedMtime,
        file_path: "note.txt",
        new_string: "new",
        old_string: "old",
      },
      sessionId: "session_edit",
      toolName: "edit",
    });

    expect(staleReadStateEdit.status).toBe("error");
    expect(staleReadStateEdit.error?.message).toContain("read again before edit");

    const readAgain = await scheduler.execute({
      callId: "read_again_before_edit",
      environment,
      messageId: "message_1",
      params: { file_path: "note.txt" },
      sessionId: "session_edit",
      toolName: "read",
    });
    const freshMtime = readAgain.metadata?.mtimeMs;
    expect(freshMtime).toEqual(expect.any(Number));

    const actual = await scheduler.execute({
      callId: "edit_actual",
      environment,
      messageId: "message_1",
      params: {
        expected_mtime_ms: freshMtime,
        file_path: "note.txt",
        new_string: "new",
        old_string: "old",
      },
      sessionId: "session_edit",
      toolName: "edit",
    });

    expect(actual.status).toBe("success");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new external\n");
  });
});
