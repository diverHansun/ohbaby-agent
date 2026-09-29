import type { Message, UpdateMessagePatch } from "./types.js";

/** Merge request facts under the store's existing message write owner. */
export function applyMessagePatch(
  message: Message,
  patch: UpdateMessagePatch,
): Message {
  if (!patch.modelRequests || message.role !== "assistant")
    return { ...message, ...patch };
  const records = new Map(
    message.modelRequests?.map((request) => [request.requestId, request]),
  );
  for (const request of patch.modelRequests) {
    if (request.runId !== message.runId || request.messageId !== message.id)
      throw new Error("Model request owner does not match assistant message");
    const previous = records.get(request.requestId);
    if (
      previous?.inputIds !== undefined &&
      request.inputIds !== undefined &&
      JSON.stringify(previous.inputIds) !== JSON.stringify(request.inputIds)
    )
      throw new Error("Model request input membership is immutable");
    if (previous?.endedAt !== undefined) continue;
    records.set(request.requestId, {
      ...previous,
      ...request,
      ...(previous?.inputIds === undefined
        ? {}
        : { inputIds: previous.inputIds }),
    });
  }
  return { ...message, ...patch, modelRequests: [...records.values()] };
}
