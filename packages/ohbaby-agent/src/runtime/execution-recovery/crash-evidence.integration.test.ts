import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { createDatabaseRunLedger } from "../run-ledger/index.js";
import { repairInterruptedRunHistory } from "./history.js";

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Fixture process survived SIGKILL"));
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.kill("SIGKILL");
  });
}

it.each([
  "before-invoke",
  "after-invoke",
  "after-start",
  "completed",
  "rejected",
  "recovery-partial",
] as const)(
  "recovers the durable evidence at the real process crash barrier %s without replaying effects",
  async (barrier) => {
    const root = await mkdtemp(join(tmpdir(), "improve4-crash-evidence-"));
    const dbPath = join(root, "facts.db");
    const marker = join(root, "effects.txt");
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      initDatabase({ dbPath });
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,project_root,title,status,created_at,updated_at,data) VALUES ('s','p',?,'s','active',1,1,'{}')",
        )
        .run(root);
      closeDatabase();
      const moduleUrl = (path: string): string =>
        pathToFileURL(resolve("packages/ohbaby-agent/src", path)).href;
      const code = `
        const {appendFileSync}=await import('node:fs');
        const {createBus}=await import(${JSON.stringify(moduleUrl("bus/index.ts"))});
        const {initDatabase}=await import(${JSON.stringify(moduleUrl("services/database/index.ts"))});
        const {createMessageManager,createDatabaseMessageStore}=await import(${JSON.stringify(moduleUrl("core/message/index.ts"))});
        const {createDatabaseRunLedger}=await import(${JSON.stringify(moduleUrl("runtime/run-ledger/index.ts"))});
        const input=JSON.parse(process.env.OHBABY_TEST_CRASH_INPUT);
        initDatabase({dbPath:input.dbPath});
        const ledger=createDatabaseRunLedger({ownerId:'dead-owner',ownerPid:process.pid});
        await ledger.claimPendingRun({runId:'A',sessionId:'s',triggerSource:'user'});
        await ledger.markRunning('A');
        const manager=createMessageManager({bus:createBus(),store:createDatabaseMessageStore()});
        const message=await manager.createMessage({sessionId:'s',runId:'A',role:'assistant',agent:'primary'});
        const part=await manager.appendPart(message.id,{type:'tool',tool:'write',callId:'same-call',state:{status:'pending',input:{path:'fixture'},raw:'{}'},metadata:{execution:{runId:'A',phase:'preparing',createdAt:100,phaseStartedAt:100}}});
        // The actual tool operation has an independently observable side effect.
        // Both before-invoke and after-invoke leave the same durable tool facts.
        if(!['before-invoke','rejected'].includes(input.barrier)) appendFileSync(input.marker,'effect\\n');
        if(input.barrier==='after-start') await manager.updatePart(part.id,{state:{status:'running',input:{path:'fixture'}},metadata:{execution:{runId:'A',phase:'executing',createdAt:100,phaseStartedAt:200,executionStartedAt:200}}});
        if(input.barrier==='completed') await manager.updatePart(part.id,{state:{status:'completed',input:{path:'fixture'},output:'real committed result'},metadata:{execution:{runId:'A',phase:'ended',createdAt:100,phaseStartedAt:300,executionStartedAt:200,endedAt:300,outcome:'success'}}});
        if(input.barrier==='rejected') await manager.updatePart(part.id,{state:{status:'error',input:{path:'fixture'},error:'Permission denied before invocation'}});
        if(input.barrier==='recovery-partial') {
          await manager.appendPart(message.id,{type:'tool',tool:'write',callId:'second-call',state:{status:'pending',input:{},raw:'{}'}});
          await ledger.markRunInterrupted('A','process-interrupted',{endedAt:400});
          const {repairInterruptedRunHistory}=await import(${JSON.stringify(moduleUrl("runtime/execution-recovery/history.ts"))});
          const update=manager.updatePart.bind(manager);
          manager.updatePart=async (...args)=>{
            const saved=await update(...args);
            process.stdout.write('CRASH_READY '+part.id+'\\n');
            await new Promise(()=>{setInterval(()=>{},1000)});
            return saved;
          };
          await repairInterruptedRunHistory(manager,{sessionId:'s',runId:'A',reason:'process-interrupted',now:()=>450});
        } else {
          process.stdout.write('CRASH_READY '+part.id+'\\n');
          setInterval(()=>{},1000);
        }
      `;
      child = spawn(process.execPath, ["--import", "tsx", "--eval", code], {
        env: {
          ...process.env,
          OHBABY_TEST_CRASH_INPUT: JSON.stringify({ dbPath, marker, barrier }),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const activeChild = child;
      const partId = await new Promise<string>((resolveReady, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          reject(new Error(`Crash barrier timeout: ${stderr}`));
        }, 10000);
        activeChild.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
          const line = stdout
            .split("\n")
            .find((value) => value.startsWith("CRASH_READY "));
          if (line) {
            clearTimeout(timer);
            resolveReady(line.slice(12));
          }
        });
        activeChild.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        activeChild.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        activeChild.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Exited before barrier: ${stderr}`));
        });
      });
      await stop(child);
      initDatabase({ dbPath });
      const manager = createMessageManager({
        bus: createBus(),
        store: createDatabaseMessageStore(),
      });
      const original = await manager.getPart(partId);
      const before = existsSync(marker) ? await readFile(marker, "utf8") : "";
      await createDatabaseRunLedger().recoverOrphanedRuns({ sessionId: "s" });
      const repair = (): Promise<boolean> =>
        repairInterruptedRunHistory(manager, {
          sessionId: "s",
          runId: "A",
          reason: "process-interrupted",
          now: () => 500,
        });
      await repair();
      if (barrier === "recovery-partial") {
        const page = await manager.listPageByRun("s", "A", { limit: 100 });
        expect(
          page.messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool")
            .map((part) => part.state.status),
        ).toEqual(["error", "error"]);
        expect(await manager.getPart(partId)).toEqual(original);
        expect(await createDatabaseRunLedger().get("A")).toMatchObject({
          status: "interrupted",
          endedAt: 400,
        });
      }
      const repaired = await manager.getPart(partId);
      if (barrier === "completed" || barrier === "rejected")
        expect(repaired).toEqual(original);
      else {
        expect(repaired?.type).toBe("tool");
        if (repaired?.type !== "tool" || repaired.state.status !== "error")
          throw new Error("Unfinished tool was not repaired");
        expect(repaired.state.error).toContain("outcome unknown");
        expect(repaired.metadata?.execution?.executionStartedAt).toBe(
          barrier === "after-start" ? 200 : undefined,
        );
        expect(repaired.metadata?.execution?.endTimeSource).toBe("recovery");
      }
      await repair();
      expect(await manager.getPart(partId)).toEqual(repaired);
      expect(existsSync(marker) ? await readFile(marker, "utf8") : "").toBe(
        before,
      );
      expect(before).toBe(
        ["before-invoke", "rejected"].includes(barrier) ? "" : "effect\n",
      );
    } finally {
      if (child) await stop(child);
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
