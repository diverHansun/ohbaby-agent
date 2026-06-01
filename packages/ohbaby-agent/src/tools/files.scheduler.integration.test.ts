import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import {
  createToolScheduler,
  type ToolSchedulerInstance,
} from "../core/tool-scheduler/index.js";
import { createHostLocalEnvironment } from "../adapters/ui-runtime/host-local-environment.js";
import {
  createPermissionManager,
  createPermissionState,
  PermissionEvent,
  type PermissionInfo,
} from "../permission/index.js";
import { createBuiltinTools } from "./index.js";

function createScheduler(): ToolSchedulerInstance {
  const scheduler = createToolScheduler({
    bus: createBus(),
    permissionState: createPermissionState({ initialLevel: "full-access" }),
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
    expect(missingMtime.error?.message).toContain(
      "expected_mtime_ms is required",
    );
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

  it("allows absolute paths outside the workspace through default permission approval", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({
      bus,
      initialLevel: "default",
    });
    const permission = createPermissionManager({
      bus,
      generateId: (() => {
        let next = 1;
        return (): string => `permission_${String(next++)}`;
      })(),
      state: permissionState,
    });
    const scheduler = createToolScheduler({ bus, permission, permissionState });
    const permissionUpdates: PermissionInfo[] = [];
    for (const tool of createBuiltinTools()) {
      scheduler.register(tool);
    }
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, { type: "once" });
    });
    const environment = createHostLocalEnvironment(tempRoot);
    const outsideReadPath = path.join(outsideRoot, "secret.txt");
    const outsideWritePath = path.join(outsideRoot, "written.txt");
    const outsideEditPath = path.join(outsideRoot, "editable.txt");
    await fs.writeFile(outsideReadPath, "secret\n", "utf8");
    await fs.writeFile(outsideEditPath, "old\n", "utf8");

    const read = await scheduler.execute({
      callId: "read_outside",
      environment,
      messageId: "message_1",
      params: { file_path: outsideReadPath },
      sessionId: "session_1",
      toolName: "read",
    });
    const readForEdit = await scheduler.execute({
      callId: "read_outside_edit_target",
      environment,
      messageId: "message_1",
      params: { file_path: outsideEditPath },
      sessionId: "session_1",
      toolName: "read",
    });
    const write = await scheduler.execute({
      callId: "write_outside",
      environment,
      messageId: "message_1",
      params: {
        content: "changed\n",
        file_path: outsideWritePath,
      },
      sessionId: "session_1",
      toolName: "write",
    });
    const edit = await scheduler.execute({
      callId: "edit_outside",
      environment,
      messageId: "message_1",
      params: {
        expected_mtime_ms: (await fs.stat(outsideEditPath)).mtimeMs,
        file_path: outsideEditPath,
        new_string: "changed",
        old_string: "old",
      },
      sessionId: "session_1",
      toolName: "edit",
    });

    expect(read.status).toBe("success");
    expect(read.output).toContain("secret");
    expect(readForEdit.status).toBe("success");
    expect(write.status).toBe("success");
    expect(edit.status).toBe("success");
    expect(permissionUpdates.map((info) => info.callId)).toEqual([
      "read_outside",
      "read_outside_edit_target",
      "write_outside",
      "edit_outside",
    ]);
    expect(permissionUpdates.map((info) => info.name)).toEqual([
      "external_directory",
      "external_directory",
      "write",
      "edit",
    ]);
    expect(permissionUpdates[0]?.title).toContain("External path access");
    expect(permissionUpdates[1]?.title).toContain("External path access");
    expect(permissionUpdates[2]?.pattern).toContain("write(");
    expect(permissionUpdates[3]?.pattern).toContain("edit(");
    await expect(fs.readFile(outsideReadPath, "utf8")).resolves.toBe(
      "secret\n",
    );
    await expect(fs.readFile(outsideWritePath, "utf8")).resolves.toBe(
      "changed\n",
    );
    await expect(fs.readFile(outsideEditPath, "utf8")).resolves.toBe(
      "changed\n",
    );
  });

  it("remembers full-access external absolute write approval", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({
      bus,
      initialLevel: "full-access",
    });
    const permission = createPermissionManager({
      bus,
      generateId: (() => {
        let next = 1;
        return (): string => `permission_external_auto_${String(next++)}`;
      })(),
      state: permissionState,
    });
    const scheduler = createToolScheduler({ bus, permission, permissionState });
    const permissionUpdates: PermissionInfo[] = [];
    for (const tool of createBuiltinTools()) {
      scheduler.register(tool);
    }
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, {
        type: permissionUpdates.length === 1 ? "always" : "once",
      });
    });
    const environment = createHostLocalEnvironment(tempRoot);
    const outsideWritePath = path.join(outsideRoot, "auto-external.txt");
    const outsideEditPath = path.join(outsideRoot, "auto-editable.txt");
    await fs.writeFile(outsideEditPath, "old\n", "utf8");

    const internal = await scheduler.execute({
      callId: "write_internal_auto",
      environment,
      messageId: "message_1",
      params: {
        content: "internal\n",
        file_path: "auto-internal.txt",
      },
      sessionId: "session_1",
      toolName: "write",
    });
    const external = await scheduler.execute({
      callId: "write_external_auto",
      environment,
      messageId: "message_1",
      params: {
        content: "external\n",
        file_path: outsideWritePath,
      },
      sessionId: "session_1",
      toolName: "write",
    });
    const readForEdit = await scheduler.execute({
      callId: "read_external_auto_edit",
      environment,
      messageId: "message_1",
      params: { file_path: outsideEditPath },
      sessionId: "session_1",
      toolName: "read",
    });
    const externalEdit = await scheduler.execute({
      callId: "edit_external_auto",
      environment,
      messageId: "message_1",
      params: {
        expected_mtime_ms: (await fs.stat(outsideEditPath)).mtimeMs,
        file_path: outsideEditPath,
        new_string: "new",
        old_string: "old",
      },
      sessionId: "session_1",
      toolName: "edit",
    });

    expect(internal.status).toBe("success");
    expect(external.status).toBe("success");
    expect(readForEdit.status).toBe("success");
    expect(externalEdit.status).toBe("success");
    expect(permissionUpdates.map((info) => info.callId)).toEqual([
      "write_external_auto",
    ]);
    expect(permissionUpdates[0]?.name).toBe("external_directory");
    expect(permissionUpdates[0]?.pattern.replaceAll("\\", "/")).toContain(
      outsideRoot.replaceAll("\\", "/").toLowerCase(),
    );
    await expect(fs.readFile(outsideWritePath, "utf8")).resolves.toBe(
      "external\n",
    );
    await expect(fs.readFile(outsideEditPath, "utf8")).resolves.toBe("new\n");
  });

  it("matches remembered absolute-path permissions against canonical paths", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: (() => {
        let next = 1;
        return (): string => `permission_canonical_${String(next++)}`;
      })(),
      state: permissionState,
    });
    const scheduler = createToolScheduler({ bus, permission, permissionState });
    const permissionUpdates: PermissionInfo[] = [];
    for (const tool of createBuiltinTools()) {
      scheduler.register(tool);
    }
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, {
        type: permissionUpdates.length === 1 ? "always" : "once",
      });
    });
    const environment = createHostLocalEnvironment(tempRoot);
    const safeDir = path.join(outsideRoot, "safe");
    const otherDir = path.join(outsideRoot, "other");
    await fs.mkdir(safeDir);
    await fs.mkdir(otherDir);
    const safePath = path.join(safeDir, "note.txt");
    const siblingViaDotDot = `${safeDir}${path.sep}..${path.sep}other${path.sep}note.txt`;

    const safeWrite = await scheduler.execute({
      callId: "write_safe_absolute",
      environment,
      messageId: "message_1",
      params: {
        content: "safe\n",
        file_path: safePath,
      },
      sessionId: "session_1",
      toolName: "write",
    });
    const siblingWrite = await scheduler.execute({
      callId: "write_sibling_dotdot",
      environment,
      messageId: "message_1",
      params: {
        content: "other\n",
        file_path: siblingViaDotDot,
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(safeWrite.status).toBe("success");
    expect(siblingWrite.status).toBe("success");
    expect(permissionUpdates.map((info) => info.callId)).toEqual([
      "write_safe_absolute",
      "write_sibling_dotdot",
    ]);
    expect(permissionUpdates[1]?.pattern).not.toContain("..");
    expect(permissionUpdates[1]?.pattern.replaceAll("\\", "/")).toContain(
      "/other/**",
    );
  });

  it("allows explicit absolute paths through symlinked parents", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({
      bus,
      initialLevel: "full-access",
    });
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_symlink_absolute",
      state: permissionState,
    });
    const scheduler = createToolScheduler({
      bus,
      permission,
      permissionState,
    });
    for (const tool of createBuiltinTools()) {
      scheduler.register(tool);
    }
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permission.respond(event.info.sessionId, event.info.id, { type: "once" });
    });
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

    expect(result.status).toBe("success");
    await expect(fs.access(escapedDirectory)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(escapedDirectory, "note.txt"), "utf8"),
    ).resolves.toBe("escape\n");
  });

  it("asks before default relative symlink escapes and writes the canonical target", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({
      bus,
      initialLevel: "default",
    });
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_relative_symlink_escape",
      state: permissionState,
    });
    const scheduler = createToolScheduler({ bus, permission, permissionState });
    const permissionUpdates: PermissionInfo[] = [];
    for (const tool of createBuiltinTools()) {
      scheduler.register(tool);
    }
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, {
        type: permissionUpdates.length === 1 ? "always" : "once",
      });
    });
    const environment = createHostLocalEnvironment(tempRoot);
    await fs.symlink(
      outsideRoot,
      path.join(tempRoot, "linked-outside"),
      "junction",
    );

    const result = await scheduler.execute({
      callId: "write_relative_symlink_escape",
      environment,
      messageId: "message_1",
      params: {
        content: "escape\n",
        file_path: path.join("linked-outside", "newdir", "note.txt"),
      },
      sessionId: "session_1",
      toolName: "write",
    });

    expect(result.status).toBe("success");
    expect(permissionUpdates.map((info) => info.callId)).toEqual([
      "write_relative_symlink_escape",
    ]);
    expect(permissionUpdates[0]?.name).toBe("write");
    expect(permissionUpdates[0]?.pattern.replaceAll("\\", "/")).toContain(
      "/newdir/**",
    );
    await expect(
      fs.readFile(path.join(outsideRoot, "newdir", "note.txt"), "utf8"),
    ).resolves.toBe("escape\n");
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
    expect(editWithoutRead.error?.message).toContain(
      "must be read before edit",
    );
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
    expect(otherSessionEdit.error?.message).toContain(
      "must be read before edit",
    );
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
    expect(staleReadStateEdit.error?.message).toContain(
      "read again before edit",
    );

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
