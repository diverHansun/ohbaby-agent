import type { CapacityKind } from "./concurrency.js";
import { withResources, type ResourceAccess } from "./resources.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

export interface ResolvedToolAccess {
  readonly resources: readonly ResourceAccess[];
  readonly params?: Record<string, unknown>;
}
export interface ToolAdmission {
  readonly cleanupOwner?: "tool";
  /** After cancellation, local request settlement cannot prove remote work stopped. */
  readonly settlementConfirmsCleanup?: false;
  readonly capacity?: CapacityKind;
  /** No existence, permission or content checks here: predecessors have not run. */
  readonly plan?: (
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => readonly ResourceAccess[] | Promise<readonly ResourceAccess[]>;
  readonly resolve?: (
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => ResolvedToolAccess | Promise<ResolvedToolAccess>;
}

// Registration is keyed by the actual implementation object, never by model input,
// tool name, source label, category, or a serialized capability claim.
const admissions = new WeakMap<Tool, ToolAdmission>();
export function trustedToolAdmission(tool: Tool): ToolAdmission | undefined {
  return admissions.get(tool);
}
export function withToolAdmission(tool: Tool, admission: ToolAdmission): Tool {
  admissions.set(tool, admission);
  if (admission.resolve) {
    const execute = tool.execute.bind(tool);
    const resolve = admission.resolve;
    tool.execute = async (params, context): Promise<ToolExecutionResult> => {
      const access = await resolve(params, context);
      return withResources(
        access.resources,
        (lease) =>
          Promise.resolve(
            execute(access.params ?? params, {
              ...context,
              resourceLease: lease,
            }),
          ),
        { signal: context.signal, lease: context.resourceLease },
      );
    };
  }
  return tool;
}

export const independentToolAdmission: ToolAdmission = { plan: () => [] };
