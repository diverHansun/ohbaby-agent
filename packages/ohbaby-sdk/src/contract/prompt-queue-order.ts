import type { UiPromptSubmission } from "./prompt.js";

/** Admission order stays stable across lease updates and moves a resubmission behind earlier admissions. */
export function compareUiPromptQueueOrder(
  left: UiPromptSubmission,
  right: UiPromptSubmission,
): number {
  return (
    Date.parse(left.acceptedAt ?? left.createdAt) -
      Date.parse(right.acceptedAt ?? right.createdAt) ||
    (left.admissionOrder ?? 0) - (right.admissionOrder ?? 0) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.promptId.localeCompare(right.promptId)
  );
}
