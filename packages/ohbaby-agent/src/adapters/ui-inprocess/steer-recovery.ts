import type { UiUnconsumedSteer } from "ohbaby-sdk";
import type { MessageManager } from "../../core/message/index.js";
import type { CurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import type {
  PromptSubmissionRecord,
  PromptSubmissionStore,
} from "../../runtime/prompt-scheduler/types.js";
import type {
  RunLedger,
  RunLedgerRecord,
} from "../../runtime/run-ledger/index.js";

function isClosed(run: RunLedgerRecord): boolean {
  return (
    run.inputsClosedAt !== undefined ||
    (run.status !== "pending" && run.status !== "running")
  );
}

/** Recovery is derived from durable inputs, not the loaded transcript window. */
export async function projectUnconsumedSteers(options: {
  readonly sessionId: string;
  readonly scopeKey: string;
  readonly inputs: CurrentRunInputStore;
  readonly prompts: PromptSubmissionStore;
  readonly runs: RunLedger;
  readonly messages: MessageManager;
  readonly assertRecoveryReady?: () => void;
}): Promise<readonly UiUnconsumedSteer[]> {
  const { sessionId, scopeKey, inputs, prompts, runs, messages } = options;
  async function successfulRequest(
    prompt: PromptSubmissionRecord,
  ): Promise<boolean> {
    if (!prompt.runId) return false;
    let before: string | undefined;
    do {
      const page = await messages.listPageByRun(sessionId, prompt.runId, {
        before,
        limit: 200,
        scope: { contextScopeId: undefined },
      });
      if (
        page.messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.modelRequests?.some(
              (request) =>
                request.purpose === "agent-step" &&
                request.outcome === "success",
            ),
        )
      )
        return true;
      before = page.hasMore ? page.nextCursor : undefined;
    } while (before);
    return false;
  }
  async function effectiveChild(
    prompt: PromptSubmissionRecord,
  ): Promise<boolean> {
    if (prompt.sessionId !== sessionId)
      throw new Error("Resent prompt session conflict");
    if (
      prompt.status === "queued" ||
      prompt.status === "retained" ||
      prompt.status === "starting" ||
      prompt.status === "running"
    )
      return true;
    if (prompt.status !== "steered") return successfulRequest(prompt);
    if (!prompt.steerReceipt) throw new Error("Steered prompt receipt missing");
    const input = await inputs.getInput(prompt.steerReceipt.inputId);
    if (
      input?.sessionId !== sessionId ||
      input.contextScopeId !== undefined ||
      input.source !== "user-steer" ||
      input.sourceId !== prompt.promptId ||
      input.messageId !== prompt.userMessageId
    )
      throw new Error("Steered prompt input missing or out of scope");
    const run = await runs.get(input.runId);
    if (run?.sessionId !== sessionId)
      throw new Error("Steered prompt run missing or out of scope");
    if (input.processedRequestId === undefined) {
      const message = (
        await messages.listByIds(sessionId, [input.messageId])
      ).at(0);
      if (
        message?.info.role !== "user" ||
        message.info.contextScopeId !== undefined
      )
        throw new Error(
          "Steered prompt original message missing or out of scope",
        );
    }
    // A closed, unprocessed steered child owns its own recovery entry. Keeping
    // its parent hidden also preserves one entry across repeated resend chains.
    return true;
  }
  const result: UiUnconsumedSteer[] = [];
  const candidates = await inputs.listUnconsumedSteers(sessionId);
  if (candidates.length) options.assertRecoveryReady?.();
  for (const input of candidates) {
    if (input.contextScopeId !== undefined) continue;
    const run = await runs.get(input.runId);
    if (run?.sessionId !== sessionId)
      throw new Error("Steered input run missing or out of scope");
    if (input.closedAt === undefined && !isClosed(run)) continue;
    const children = await prompts.listResendChildren(scopeKey, input.sourceId);
    let suppressed = false;
    for (const child of children) {
      if (await effectiveChild(child)) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;
    const message = (await messages.listByIds(sessionId, [input.messageId])).at(
      0,
    );
    if (
      message?.info.role !== "user" ||
      message.info.contextScopeId !== undefined
    )
      throw new Error("Steered input original message missing or out of scope");
    result.push({
      inputId: input.inputId,
      promptId: input.sourceId,
      messageId: input.messageId,
      text: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      state:
        input.firstAttemptRequestId === undefined
          ? "unconsumed"
          : "unconfirmed",
    });
  }
  return result;
}
