import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRemoteUiBackendClient } from "../../packages/ohbaby-server/src/protocols/jsonrpc/client.js";
import { loadEnvFile } from "../../packages/ohbaby-agent/src/config/llm/loaders.js";
import { NodeSqliteConnection } from "../../packages/ohbaby-agent/src/services/database/connection.js";
import { readSystemProxy } from "../../packages/ohbaby-agent/src/utils/network-proxy/system.js";
import type { ToolPart } from "../../packages/ohbaby-agent/src/core/message/types.js";

const enabled = process.env.OHBABY_RUN_REAL_PROCESS_TOOLS === "1";
const batch = process.env.OHBABY_REAL_PROCESS_BATCH ?? "network";
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
interface WireRow {
  sequence: number;
  toolResults: {
    callIdHash: string;
    role: string;
    characters: number;
    markers: string[];
  }[];
}

function ready(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(
      () => finish(new Error("CLI_START_TIMEOUT")),
      30_000,
    );
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /ohbaby web ready: http:\/\/127\.0\.0\.1:(\d+)/u.exec(
        output,
      );
      if (match) finish(undefined, Number(match[1]));
    };
    const onExit = (): void => finish(new Error("CLI_EXIT_BEFORE_READY"));
    const finish = (error?: Error, port?: number): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolveReady(port!);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

describe.runIf(enabled)("real compiled CLI tool transport", () => {
  it(`verifies ${batch} tools, default approvals and next provider requests`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-process-tools-"));
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    const dbPath = join(root, "state.db");
    const wirePath = join(root, "wire.jsonl");
    const markers =
      batch === "network"
        ? ["NETWORK_PARENT_OK_7261", "NETWORK_CHILD_OK_7261"]
        : [
            "COMPOUND_alpha_7261",
            "COMPOUND_beta_7261",
            "COMPOUND_CHILD_gamma_7261",
            "glob-alpha-7261.txt",
            "glob-beta-7261.txt",
          ];
    const commands =
      batch === "network"
        ? markers.map(
            (marker) =>
              `curl -fsSI --max-time 30 https://example.com && printf '${marker}\\n'`,
          )
        : [
            "for value in alpha beta; do printf 'COMPOUND_%s_7261\\n' \"$value\"; done",
            "printf 'COMPOUND_CHILD_%s_7261\\n' \"$(printf gamma)\"",
          ];
    const approvals: {
      sessionId: string;
      rootSessionId: string;
      callIdHash: string;
      marker: string;
      allowed: boolean;
      choices: string[];
    }[] = [];
    const permissionErrors: string[] = [];
    const pending = new Set<Promise<void>>();
    const evidence: Record<string, unknown> = {
      checkedAt: new Date().toISOString(),
      batch,
      model: "openai/gpt-5.6-luna",
      transport: "compiled CLI child process / HTTP",
      passed: false,
      approvals,
      permissionErrors,
      explicitProxy: false,
    };
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: ReturnType<typeof createRemoteUiBackendClient> | undefined;
    let database: NodeSqliteConnection | undefined;
    let off = (): void => undefined;
    let phase = "setup";
    try {
      await mkdir(profile);
      await mkdir(workspace);
      await writeFile(join(profile, ".skip-auto-migrate"), "");
      const environment = await loadEnvFile(resolve(".env"));
      const key = process.env.ZENMUX_API_KEY ?? environment.ZENMUX_API_KEY;
      if (!key) throw new Error("MISSING_REAL_MODEL_KEY");
      const system = await readSystemProxy();
      const httpProxy = system.httpProxy;
      const httpsProxy = system.httpsProxy ?? httpProxy;
      if (!httpProxy || !httpsProxy)
        throw new Error("SYSTEM_PROXY_ENDPOINT_REQUIRED");
      evidence.explicitProxy = true;
      await writeFile(
        join(profile, "model.json"),
        JSON.stringify({
          provider: "zenmux",
          defaultModel: "openai/gpt-5.6-luna",
          apiConfig: {
            apiKeyEnv: "ZENMUX_API_KEY",
            baseUrl: "https://zenmux.ai/api/v1",
            interfaceProvider: "openai-compatible",
          },
          models: [
            {
              model: "openai/gpt-5.6-luna",
              contextWindowTokens: 128000,
              reasoningCapabilities: {
                mode: "effort",
                wire: "reasoning",
                supportsDisabled: true,
                efforts: ["low", "medium", "high"],
                temperature: "unsupported",
              },
            },
          ],
          llmParams: {
            maxTokens: 4096,
            reasoning: { enabled: true, effort: "medium" },
          },
        }),
        { mode: 0o600 },
      );
      if (batch !== "network") {
        await mkdir(join(workspace, "fixtures"));
        for (const marker of markers.filter((value) =>
          value.startsWith("glob-"),
        ))
          await writeFile(join(workspace, "fixtures", marker), "fixture\n");
      }
      child = spawn(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          resolve("tests/smoke/process-tools-provider-observer.mjs"),
          resolve("packages/ohbaby-cli/dist/bin.js"),
          "serve",
          "--port",
          "0",
          "--no-open",
          "--db-path",
          dbPath,
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            OHBABY_HOME: profile,
            OHBABY_STORAGE_ROOT: join(root, "storage"),
            OHBABY_DB_PATH: dbPath,
            ZENMUX_API_KEY: key,
            NO_COLOR: "1",
            HTTP_PROXY: httpProxy,
            http_proxy: httpProxy,
            HTTPS_PROXY: httpsProxy,
            https_proxy: httpsProxy,
            ALL_PROXY: "",
            all_proxy: "",
            NO_PROXY: "localhost,127.0.0.1,::1",
            no_proxy: "localhost,127.0.0.1,::1",
            OHBABY_REAL_WIRE_PATH: wirePath,
            OHBABY_REAL_TOOL_MARKERS: JSON.stringify(markers),
          },
          stdio: "pipe",
        },
      );
      // Drain diagnostics without exposing raw errors or unexpected provider content.
      let stderrCharacters = 0;
      let stdoutCharacters = 0;
      child.stderr.on("data", (chunk: Buffer) => {
        stderrCharacters += chunk.length;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutCharacters += chunk.length;
      });
      phase = "start-cli";
      const port = await ready(child);
      const state = JSON.parse(
        await readFile(join(profile, "server", "daemon-state.json"), "utf8"),
      ) as { authToken: string };
      client = createRemoteUiBackendClient({
        port,
        authToken: state.authToken,
        directory: workspace,
        startupIntent: {
          startupSessionMode: { type: "fresh" },
          initialPermission: { level: "default", mode: "auto" },
        },
      });
      database = new NodeSqliteConnection(dbPath);
      const parts = (): ToolPart[] =>
        database!
          .prepare<{ data: string }>(
            "SELECT data FROM part WHERE type = 'tool'",
          )
          .all()
          .map((row) => JSON.parse(row.data) as ToolPart);
      off = client.subscribePermissionEvents((event) => {
        if (event.type !== "permission.requested") return;
        const task = (async (): Promise<void> => {
          const part = parts().find(
            (item) =>
              item.callId === event.request.callId &&
              item.sessionId === event.request.sessionId,
          );
          const command = String(part?.state.input.command);
          const allowed = part?.tool === "bash" && commands.includes(command);
          approvals.push({
            sessionId: event.request.sessionId,
            rootSessionId: event.request.rootSessionId,
            callIdHash: hash(event.request.callId),
            marker:
              markers.find((marker) => command.includes(marker)) ?? "compound",
            allowed,
            choices: event.request.choices.map((choice) => choice.id),
          });
          if (
            batch === "shell-glob" &&
            allowed &&
            event.request.choices.some((choice) => choice.id === "allow_always")
          )
            permissionErrors.push("INCOMPLETE_COMMAND_OFFERED_ALWAYS");
          const choice = event.request.choices.find((item) =>
            allowed ? item.id === "allow_once" : item.intent === "deny",
          );
          if (!choice) throw new Error("NO_SCOPED_PERMISSION_CHOICE");
          if (!allowed) permissionErrors.push("UNEXPECTED_PERMISSION_TOOL");
          await client!.respondPermission(event.request.id, {
            choiceId: choice.id,
            remember: false,
          });
        })().catch(() => {
          permissionErrors.push("PERMISSION_RESPONSE_FAILED");
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
      const snapshot = await client.getSnapshot();
      expect(snapshot.permission).toMatchObject({
        level: "default",
        mode: "auto",
      });
      phase = "model-tools";
      const prompt =
        batch === "network"
          ? `Controlled proxy acceptance. Use only select_tools, bash, subagent_run. First execute bash command exactly ${JSON.stringify(commands[0])} with timeout=45000. Then activate subagent_run and call it exactly once with role=generic, mode=foreground. Child prompt: execute bash command exactly ${JSON.stringify(commands[1])} with timeout=45000; only select_tools and bash allowed, no skill or other tools and no retries; report the actual output. After child returns, report both actual output markers. Do not alter commands or infer results.`
          : `Controlled shell and glob acceptance. Only select_tools, bash, glob and subagent_run permitted, no skills. Execute bash command exactly ${JSON.stringify(commands[0])} with timeout=5000. Then activate subagent_run and call it exactly once with role=generic, mode=foreground. Child prompt: execute bash command exactly ${JSON.stringify(commands[1])} with timeout=5000; only select_tools and bash allowed, no skills, no retries; report the actual output. After child returns, call glob with pattern=fixtures/*.txt in this workspace. Report all three actual shell output lines and both filenames returned. Do not guess results or change commands.`;
      const completion = await client.submitPromptAndWait(prompt, {
        signal: AbortSignal.timeout(360000),
      });
      await Promise.all([...pending]);
      evidence.completionStatus = completion.prompt.status;
      evidence.rootSessionId = completion.prompt.sessionId;
      const toolParts = parts();
      const safeParts = toolParts.map((part) => ({
        tool: part.tool,
        sessionId: part.sessionId,
        callIdHash: hash(part.callId),
        status: part.state.status,
        failureFlags: [
          ["download-execute-preflight", /downloads a file and executes it/iu],
          ["shell-syntax", /unsupported shell syntax/iu],
          ["trusted-owner", /trusted execution owner/iu],
          ["permission-denied", /permission.*denied|denied.*permission/iu],
          ["timeout", /timed out|timeout/iu],
          ["curl-connect", /curl: \(7\)/u],
          ["curl-certificate", /curl: \(60\)/u],
        ].flatMap(([name, pattern]) =>
          (pattern as RegExp).test(
            ("error" in part.state ? part.state.error : "") +
              ("output" in part.state ? part.state.output : ""),
          )
            ? [name as string]
            : [],
        ),
        markers: markers.filter(
          (marker) =>
            "output" in part.state &&
            typeof part.state.output === "string" &&
            part.state.output.includes(marker),
        ),
      }));
      evidence.tools = safeParts;
      const wire = (await readFile(wirePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as WireRow);
      evidence.providerRequests = wire;
      evidence.stdoutCharacters = stdoutCharacters;
      evidence.stderrCharacters = stderrCharacters;
      expect(completion.prompt.status).toBe("succeeded");
      for (const marker of markers) {
        const expectedTool = marker.startsWith("glob-") ? "glob" : "bash";
        const part = safeParts.find(
          (item) =>
            item.tool === expectedTool &&
            item.status === "completed" &&
            item.markers.includes(marker),
        );
        expect(Boolean(part), `persisted tool result: ${marker}`).toBe(true);
        expect(
          wire.some((request) =>
            request.toolResults.some(
              (result) =>
                result.callIdHash === part?.callIdHash &&
                result.role === "tool" &&
                result.markers.includes(marker),
            ),
          ),
          `next provider request: ${marker}`,
        ).toBe(true);
      }
      expect(permissionErrors).toEqual([]);
      expect(
        new Set(
          approvals
            .filter((item) => item.allowed)
            .map((item) => item.callIdHash),
        ).size,
      ).toBe(commands.length);
      expect(new Set(approvals.map((item) => item.sessionId)).size).toBe(2);
      expect(
        approvals.every(
          (item) => item.rootSessionId === completion.prompt.sessionId,
        ),
      ).toBe(true);
      expect(
        approvals.some(
          (item) => item.sessionId === completion.prompt.sessionId,
        ),
      ).toBe(true);
      evidence.passed = true;
      phase = "verified";
    } finally {
      evidence.phase = phase;
      off();
      await client?.dispose().catch(() => {
        permissionErrors.push("REMOTE_CLIENT_DISPOSE_FAILED");
      });
      database?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((done) => {
          const deadline = setTimeout(() => {
            child!.kill("SIGKILL");
            done();
          }, 10000);
          child!.once("exit", () => {
            clearTimeout(deadline);
            done();
          });
        });
      }
      const report = resolve(
        `.ohbaby/test-evidence/process-tools/${batch}.json`,
      );
      await mkdir(join(report, ".."), { recursive: true });
      await writeFile(report, JSON.stringify(evidence, null, 2), {
        mode: 0o600,
      });
      await rm(root, { recursive: true, force: true });
    }
  });
});
