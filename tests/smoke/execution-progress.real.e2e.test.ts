import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";
import { createFormalCacheSession } from "./formal-cache-session.js";
import { createDaemonHttpServer } from "../../packages/ohbaby-server/src/runtime/daemon/server.js";
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import type { ToolPart } from "../../packages/ohbaby-agent/src/core/message/types.js";
import type { UiPromptReceipt, UiPromptCompletion } from "ohbaby-sdk";

it.runIf(process.env.OHBABY_RUN_REAL_EXECUTION_PROGRESS === "1")(
  "real HTTP model reads, overlaps two foreground child tools, approves and returns final text",
  async () => {
    const localFetch = globalThis.fetch;
    const profileId =
      process.env.OHBABY_EXECUTION_REAL_PROFILE ?? "zenmux-gpt56-luna-chat";
    if (
      !["zenmux-gpt56-luna-chat", "zenmux-claude-sonnet5-anthropic"].includes(
        profileId,
      )
    )
      throw new Error("Execution acceptance profile is not allowlisted");
    const profile = NATIVE_REAL_PROFILES.find((item) => item.id === profileId);
    if (!profile)
      throw new Error("Execution acceptance profile is unavailable");
    const session = await createFormalCacheSession(profileId, {
      maxRequests: 24,
    });
    const fixture = join(session.root, "workspace", "overlap");
    await mkdir(fixture, { recursive: true });
    const script = join(fixture, "gate.cjs");
    await writeFile(
      script,
      `const fs=require('node:fs'); const path=require('node:path'); const side=process.argv[2]; const root=__dirname; const start=Date.now(); fs.writeFileSync(path.join(root,side+'.start'),String(start)); const deadline=setTimeout(()=>{process.stderr.write('OVERLAP_GATE_EXPIRED');process.exit(2)},45000); const timer=setInterval(()=>{if(fs.existsSync(path.join(root,side+'.release'))){clearInterval(timer);clearTimeout(deadline);fs.writeFileSync(path.join(root,side+'.end'),String(Date.now()));process.stdout.write('CHILD_'+side+'_ACTUAL_TOOL_DONE')}},20);`,
    );
    const commands = ["left", "right"].map(
      (side) => `node '${script}' ${side}`,
    );
    const token = randomUUID();
    const clientId = randomUUID();
    const server = createDaemonHttpServer({
      backend: session.backend,
      authToken: token,
      host: "127.0.0.1",
      port: 0,
    });
    const permissionErrors: string[] = [];
    const permissionDiagnostics: Record<string, unknown>[] = [];
    const attemptId = randomUUID();
    const approved: string[] = [];
    const pending = new Set<Promise<void>>();
    const tools = (): ToolPart[] =>
      getDatabase()
        .prepare<{ data: string }>(
          "SELECT data FROM part WHERE type='tool' ORDER BY rowid",
        )
        .all()
        .map((r) => JSON.parse(r.data) as ToolPart);
    const off = session.backend.subscribeEvents((event) => {
      if (event.type !== "permission.requested") return;
      const work = (async () => {
        const part = tools().find(
          (p) =>
            p.callId === event.request.callId &&
            p.sessionId === event.request.sessionId,
        );
        const allow =
          part?.tool === "bash" &&
          commands.includes(String(part.state.input.command));
        const actual =
          typeof part?.state.input.command === "string"
            ? part.state.input.command
            : undefined;
        permissionDiagnostics.push({
          callId: event.request.callId,
          sessionId: event.request.sessionId,
          contextScopeId: part?.contextScopeId,
          partFound: part !== undefined,
          tool: part?.tool,
          exactCommandMatch: allow,
          expectedSide: commands.indexOf(actual ?? ""),
          commandHash:
            actual === undefined
              ? null
              : createHash("sha256").update(actual).digest("hex"),
          commandLength: actual?.length,
          // Only expose fixture-script commands made of shell path/quote characters.
          commandShape:
            actual?.includes(script) && /^[a-zA-Z0-9\s_./'"-]+$/.test(actual)
              ? actual.replaceAll(script, "<fixture-script>")
              : "<non-fixture-or-unsupported-command>",
        });
        const choice = event.request.choices.find((c) =>
          allow ? c.id === "allow_once" : c.intent === "deny",
        );
        if (!choice) throw new Error("MISSING_SAFE_PERMISSION_CHOICE");
        await session.backend.respondPermission(event.request.id, {
          choiceId: choice.id,
          remember: false,
        });
        if (allow) approved.push(event.request.callId);
        else permissionErrors.push("UNEXPECTED_PERMISSION");
      })().catch(() => {
        permissionErrors.push("PERMISSION_RESPONSE_FAILED");
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
    });
    let gateFailure: string | undefined;
    let released = false;
    let checking = false;
    const checker = setInterval(() => {
      if (checking || released) return;
      checking = true;
      void Promise.all(
        ["left", "right"].map((side) =>
          readFile(join(fixture, side + ".start"), "utf8"),
        ),
      )
        .then(async () => {
          await Promise.all(
            ["left", "right"].map((side) =>
              writeFile(join(fixture, side + ".release"), "go"),
            ),
          );
          released = true;
        })
        .catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            gateFailure = "OVERLAP_OBSERVATION_FAILED";
        })
        .finally(() => {
          checking = false;
        });
    }, 25);
    async function request<T>(path: string, body?: unknown): Promise<T> {
      const response = await localFetch(server.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-ohbaby-client-id": clientId,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok) throw new Error(`HTTP_STATUS_${response.status}`);
      return (await response.json()) as T;
    }
    try {
      await server.start();
      await request("/v1/clients", { clientId });
      const receipt = await request<UiPromptReceipt>("/v1/prompts", {
        clientRequestId: randomUUID(),
        text: `Controlled execution acceptance. ONLY read, select_tools, subagent_run and bash are permitted for this fixture. Do not invoke skill or load skills; pass this restriction explicitly to both children. First use read to inspect exactly ${session.readFilePath}. Activate subagent_run with select_tools if needed. Then issue TWO subagent_run calls IN THE SAME response, each mode=foreground and role=generic. Left child must execute bash command exactly ${JSON.stringify(commands[0])}, timeout=55000; right child must execute bash command exactly ${JSON.stringify(commands[1])}, timeout=55000. Children may activate bash if needed but must not run any other commands. Each child must return its actual command output. These commands wait for each other, so sequential dispatch cannot succeed. Do not retry failed commands. After both return, provide a final answer mentioning the read's project/release/owner and both actual CHILD outputs. Do not modify files yourself, invoke additional tools or inspect outside these fixture paths.`,
      });
      const { completion } = await request<{ completion: UiPromptCompletion }>(
        `/v1/prompts/${receipt.promptId}/completion`,
      );
      await Promise.all([...pending]);
      expect(completion.prompt.status).toBe("succeeded");
      expect(permissionErrors).toEqual([]);
      expect(gateFailure).toBeUndefined();
      expect(released).toBe(true);
      const intervals = await Promise.all(
        ["left", "right"].map(async (side) => ({
          side,
          start: Number(await readFile(join(fixture, side + ".start"), "utf8")),
          end: Number(await readFile(join(fixture, side + ".end"), "utf8")),
        })),
      );
      expect(Math.max(...intervals.map((i) => i.start))).toBeLessThan(
        Math.min(...intervals.map((i) => i.end)),
      );
      const all = tools();
      expect(
        all.filter(
          (p) =>
            p.tool === "read" &&
            p.state.input.file_path === session.readFilePath &&
            p.state.status === "completed",
        ),
      ).toHaveLength(1);
      const children = all.filter(
        (p) => p.tool === "subagent_run" && p.state.input.mode === "foreground",
      );
      expect(children).toHaveLength(2);
      expect(new Set(children.map((p) => p.messageId)).size).toBe(1);
      expect(children.every((p) => p.state.status === "completed")).toBe(true);
      const childBash = all.filter(
        (p) =>
          p.tool === "bash" && commands.includes(String(p.state.input.command)),
      );
      expect(childBash).toHaveLength(2);
      const childOwners = getDatabase()
        .prepare<{
          session_id: string;
          context_scope_id: string;
          parent_session_id: string;
        }>(
          "SELECT session_id, context_scope_id, parent_session_id FROM subagent_instance WHERE parent_session_id = ?",
        )
        .all(receipt.sessionId);
      expect(childOwners).toHaveLength(2);
      expect(
        childBash.every((p) =>
          childOwners.some(
            (owner) =>
              owner.session_id === p.sessionId &&
              owner.context_scope_id === p.contextScopeId,
          ),
        ),
      ).toBe(true);
      expect(
        childBash.every(
          (p) =>
            typeof p.contextScopeId === "string" && p.contextScopeId.length > 0,
        ),
      ).toBe(true);
      expect(new Set(childBash.map((p) => p.contextScopeId)).size).toBe(2);
      expect(childBash.every((p) => p.state.status === "completed")).toBe(true);
      expect(approved).toHaveLength(2);
      const snapshot = await session.backend.getSnapshot();
      const finalText =
        snapshot.sessions
          .find((s) => s.id === receipt.sessionId)
          ?.messages.filter((m) => m.role === "assistant")
          .flatMap((m) =>
            m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
          )
          .join("\n") ?? "";
      expect(finalText).toContain("CHILD_left_ACTUAL_TOOL_DONE");
      expect(finalText).toContain("CHILD_right_ACTUAL_TOOL_DONE");
      const evidenceDir = join(
        process.cwd(),
        ".ohbaby/test-evidence/improve-2",
      );
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(
        join(evidenceDir, "real-model.json"),
        JSON.stringify(
          {
            revision: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            workingTree: "uncommitted improve-2 under acceptance",
            protocol: profile.protocol,
            model: profile.model,
            passed: true,
            intervals,
            approvals: approved.length,
            requests: session.providerRequests.map((r) => ({
              id: r.id,
              purpose: r.purpose,
              sessionId: r.sessionId,
              settled: r.settled,
              exhausted: r.exhausted,
            })),
            calls: all.map((p) => ({
              tool: p.tool,
              callId: p.callId,
              sessionId: p.sessionId,
              contextScopeId: p.contextScopeId,
              status: p.state.status,
            })),
            limitation:
              "One observed model run; does not guarantee general model compliance.",
          },
          null,
          2,
        ),
      );
    } finally {
      clearInterval(checker);
      try {
        const diagnosticDir = join(
          process.cwd(),
          ".ohbaby/test-evidence/improve-2",
        );
        await mkdir(diagnosticDir, { recursive: true });
        await writeFile(
          join(diagnosticDir, `real-model-attempt-${attemptId}.json`),
          JSON.stringify(
            {
              attemptId,
              protocol: profile.protocol,
              model: profile.model,
              permissions: permissionDiagnostics,
              permissionErrors,
              approvedCount: approved.length,
              overlapGateReleased: released,
              requestCount: session.providerRequests.length,
              calls: tools().map((p) => ({
                tool: p.tool,
                callId: p.callId,
                messageId: p.messageId,
                sessionId: p.sessionId,
                contextScopeId: p.contextScopeId,
                status: p.state.status,
                shellStatus:
                  p.state.status === "completed"
                    ? p.state.metadata?.status
                    : undefined,
                execution: p.metadata?.execution,
              })),
              markers: await Promise.all(
                ["left.start", "left.end", "right.start", "right.end"].map(
                  async (name) => ({
                    name,
                    at: await readFile(join(fixture, name), "utf8")
                      .then(Number)
                      .catch(() => null),
                  }),
                ),
              ),
            },
            null,
            2,
          ),
        );
        console.log(
          `REAL_EXECUTION_DIAGNOSTICS real-model-attempt-${attemptId}.json`,
        );
      } finally {
        await Promise.all(
          ["left", "right"].map((side) =>
            writeFile(join(fixture, side + ".release"), "cleanup"),
          ),
        );
        await Promise.all([...pending]);
        off();
        await server.stop();
        await session.close();
        await rm(session.root, { recursive: true, force: true });
      }
    }
  },
  600000,
);
