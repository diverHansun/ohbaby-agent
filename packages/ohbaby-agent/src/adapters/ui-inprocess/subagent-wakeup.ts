import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import type { SessionExecutionGate } from "../session-execution.js";
export interface SubagentWakeupAdmission {
  readonly sessionId: string;
  readonly reason: "result" | "supervision";
  readonly signal: AbortSignal;
  readonly candidates: readonly SubagentExecutionRecord[];
  readonly executions: Pick<SubagentExecutionStore, "claimWakeup">;
  readonly gate: SessionExecutionGate;
  readonly now: () => number;
  readonly canStart: () => Promise<boolean>;
  readonly reserveToken?: () => Promise<symbol | undefined>;
  readonly withSessionControl: <T>(
    sessionId: string,
    work: () => Promise<T>,
  ) => Promise<T>;
}
export function reserveSubagentWakeup(
  input: SubagentWakeupAdmission,
): Promise<symbol | undefined> {
  const isAborted = (): boolean => input.signal.aborted;
  return input.withSessionControl(input.sessionId, async () => {
    if (
      isAborted() ||
      input.gate.isHeld(input.sessionId) ||
      !(await input.canStart()) ||
      isAborted()
    )
      return undefined;
    const token = input.reserveToken
      ? await input.reserveToken()
      : Symbol(`subagent ${input.reason}`);
    if (!token || isAborted()) return undefined;
    if (!input.gate.reserve(input.sessionId, token)) return undefined;
    let admitted = false;
    try {
      if (input.reason === "supervision") admitted = !isAborted();
      else
        for (const record of input.candidates) {
          if (isAborted()) break;
          if (
            record.rootSessionId !== input.sessionId ||
            record.mode !== "background" ||
            (record.delivery.state !== "pending" &&
              record.delivery.state !== "delivered") ||
            record.delivery.wakeupAttemptedAt !== undefined
          )
            continue;
          admitted =
            (await input.executions.claimWakeup(record, input.now())) ||
            admitted;
        }
      return admitted ? token : undefined;
    } catch (error) {
      admitted = false;
      throw error;
    } finally {
      if (!admitted) input.gate.release(token);
    }
  });
}
