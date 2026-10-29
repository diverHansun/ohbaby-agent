import { createHash } from "node:crypto";
import type {
  MessageManager,
  MessageWithParts,
} from "../../core/message/index.js";
import {
  CurrentRunInputConflictError,
  type CurrentRunInputRecord,
  type CurrentRunInputStore,
} from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type { RunLedger } from "../../runtime/run-ledger/types.js";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "./execution-store.js";

export interface UnprocessedExecutionMessage {
  readonly inputId: string;
  readonly text: string;
  readonly reason: string;
}
export interface ExecutionMessageChannel {
  acceptExecutionMessage(input: {
    readonly execution: SubagentExecutionRecord;
    readonly message: string;
    readonly inputId: string;
  }): Promise<{ readonly accepted: boolean }>;
  getExecutionMessage(input: {
    readonly parentSessionId: string;
    readonly subagentId: string;
    readonly inputId: string;
  }): Promise<{ readonly execution: SubagentExecutionRecord } | undefined>;
  closeExecutionInputs(input: {
    readonly execution: SubagentExecutionRecord;
    readonly reason: string;
  }): Promise<readonly UnprocessedExecutionMessage[]>;
  readExecutionInputs(input: {
    readonly execution: SubagentExecutionRecord;
  }): Promise<readonly UnprocessedExecutionMessage[]>;
}
export function createExecutionMessageChannel(options: {
  readonly inputs: CurrentRunInputStore;
  readonly executions: SubagentExecutionStore;
  readonly messages: MessageManager;
  readonly runLedger?: RunLedger;
  readonly now?: () => number;
}): ExecutionMessageChannel {
  const now = options.now ?? Date.now;
  async function ownedExecution(
    execution: SubagentExecutionRecord,
  ): Promise<SubagentExecutionRecord> {
    const saved = await options.executions.get({
      parentSessionId: execution.parentSessionId,
      executionId: execution.executionId,
    });
    if (
      saved?.subagentId !== execution.subagentId ||
      saved.childSessionId !== execution.childSessionId ||
      saved.childScopeId !== execution.childScopeId ||
      saved.childRunId !== execution.childRunId
    )
      throw new CurrentRunInputConflictError(
        "Execution input ownership conflict",
      );
    return saved;
  }

  function belongs(
    record: CurrentRunInputRecord,
    execution: SubagentExecutionRecord,
  ): boolean {
    return (
      record.source === "subagent-message" &&
      record.sourceId === record.inputId &&
      record.runId === execution.childRunId &&
      record.sessionId === execution.childSessionId &&
      record.contextScopeId === execution.childScopeId
    );
  }

  async function originalText(record: CurrentRunInputRecord): Promise<string> {
    const savedMessages = await options.messages.listByIds(record.sessionId, [
      record.messageId,
    ]);
    const message = savedMessages.at(0);
    if (
      !message ||
      message.info.contextScopeId !== record.contextScopeId ||
      message.info.runId !== record.runId ||
      message.info.runtimeInput?.inputId !== record.inputId
    )
      throw new CurrentRunInputConflictError(
        "Saved execution input message is missing or has conflicting ownership",
      );
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  async function retry(
    execution: SubagentExecutionRecord,
    inputId: string,
    text: string,
  ): Promise<boolean> {
    const old = await options.inputs.getInput(inputId);
    if (!old) return false;
    if (!belongs(old, execution) || (await originalText(old)) !== text)
      throw new CurrentRunInputConflictError(
        "Execution message idempotency conflict",
      );
    return true;
  }

  async function readExecutionInputs({
    execution,
  }: {
    readonly execution: SubagentExecutionRecord;
  }): Promise<readonly UnprocessedExecutionMessage[]> {
    const saved = await ownedExecution(execution);
    if (!saved.childRunId) return [];
    const records = (await options.inputs.listByRun(saved.childRunId)).filter(
      (record) =>
        belongs(record, saved) &&
        record.closedAt !== undefined &&
        record.processedRequestId === undefined,
    );
    const result: UnprocessedExecutionMessage[] = [];
    for (const record of records)
      result.push({
        inputId: record.inputId,
        text: await originalText(record),
        reason: record.closeReason ?? "closed",
      });
    return result;
  }

  return {
    async acceptExecutionMessage({
      execution,
      message: text,
      inputId,
    }): Promise<{ readonly accepted: boolean }> {
      if (!inputId.trim() || !text.trim())
        throw new CurrentRunInputConflictError(
          "Execution message identity and text must not be empty",
        );
      const saved = await ownedExecution(execution);
      if (await retry(saved, inputId, text)) return { accepted: true };
      if (!saved.childSessionId || !saved.childScopeId || !saved.childRunId)
        throw new CurrentRunInputConflictError("Execution input is not ready");
      const messageId = `subagent-message:${createHash("sha256").update(inputId).digest("hex")}`;
      const message: MessageWithParts = {
        info: {
          id: messageId,
          sessionId: saved.childSessionId,
          contextScopeId: saved.childScopeId,
          runId: saved.childRunId,
          role: "user",
          agent: "subagent",
          time: { created: now() },
        },
        parts: [
          {
            id: `${messageId}:text`,
            messageId,
            sessionId: saved.childSessionId,
            contextScopeId: saved.childScopeId,
            orderIndex: 0,
            type: "text",
            text,
          },
        ],
      };
      try {
        await options.inputs.acceptRuntimeInput({
          inputId,
          source: "subagent-message",
          sourceId: inputId,
          runId: saved.childRunId,
          sessionId: saved.childSessionId,
          contextScopeId: saved.childScopeId,
          message,
        });
        return { accepted: true };
      } catch (error) {
        if (!(error instanceof CurrentRunInputConflictError)) throw error;
        // Acceptance and completion share the input store's transaction. Only a
        // proven closed run means that Host may attempt a new execution.
        if (await retry(saved, inputId, text)) return { accepted: true };
        if (error.reason === "target-closed") return { accepted: false };
        const run = await options.runLedger?.get(saved.childRunId);
        if (
          run &&
          (run.sessionId !== saved.childSessionId ||
            run.contextScopeId !== saved.childScopeId)
        )
          throw error;
        if (
          run?.inputsClosedAt !== undefined ||
          (run && run.status !== "pending" && run.status !== "running")
        )
          return { accepted: false };
        const current = await ownedExecution(saved);
        if (current.status !== "queued" && current.status !== "running")
          return { accepted: false };
        if (!run || run.status === "pending")
          throw new CurrentRunInputConflictError(
            "Execution input is not ready",
          );
        throw error;
      }
    },
    async getExecutionMessage({
      parentSessionId,
      subagentId,
      inputId,
    }): Promise<{ readonly execution: SubagentExecutionRecord } | undefined> {
      const record = await options.inputs.getInput(inputId);
      if (record?.source !== "subagent-message" || !record.contextScopeId)
        return undefined;
      const execution = await options.executions.getByChildRun({
        sessionId: record.sessionId,
        contextScopeId: record.contextScopeId,
        runId: record.runId,
      });
      if (
        execution?.parentSessionId !== parentSessionId ||
        execution.subagentId !== subagentId ||
        !belongs(record, execution)
      )
        return undefined;
      return { execution };
    },
    async closeExecutionInputs({
      execution,
      reason,
    }): Promise<readonly UnprocessedExecutionMessage[]> {
      const saved = await ownedExecution(execution);
      if (!saved.childRunId) return [];
      await options.inputs.close(saved.childRunId, reason);
      return readExecutionInputs({ execution: saved });
    },
    readExecutionInputs,
  };
}
