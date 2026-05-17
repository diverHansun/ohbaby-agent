import type {
  ToolCommandContext,
  ToolCommandContextOptions,
  ToolExecutionContext,
} from "../../core/tool-scheduler/index.js";

export interface ToolRuntimeContext extends ToolExecutionContext {
  resolvePath?(inputPath: string): string;
  resolvePathForExisting(inputPath: string): Promise<string>;
  resolvePathForWrite(inputPath: string): Promise<string>;
  resolveCommandContext?(
    options?: ToolCommandContextOptions,
  ): ToolCommandContext;
}

function missingContextMethod(methodName: string): Error {
  return new Error(
    `ToolExecutionContext is missing ${methodName}; wire the tool execution context bridge before running builtin tools.`,
  );
}

export function resolvePath(
  context: ToolExecutionContext,
  inputPath: string,
): string {
  if (context.environment) {
    return context.environment.resolvePath(inputPath);
  }

  const resolver = (context as Partial<ToolRuntimeContext>).resolvePath;
  if (!resolver) {
    throw missingContextMethod("resolvePath()");
  }

  return resolver.call(context, inputPath);
}

export async function resolvePathForExisting(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<string> {
  if (context.environment) {
    return context.environment.resolvePathForExisting(inputPath);
  }

  const resolver = (context as Partial<ToolRuntimeContext>)
    .resolvePathForExisting;
  if (!resolver) {
    throw missingContextMethod("resolvePathForExisting()");
  }

  return resolver.call(context, inputPath);
}

export async function resolvePathForWrite(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<string> {
  if (context.environment) {
    return context.environment.resolvePathForWrite(inputPath);
  }

  const resolver = (context as Partial<ToolRuntimeContext>).resolvePathForWrite;
  if (!resolver) {
    throw missingContextMethod("resolvePathForWrite()");
  }

  return resolver.call(context, inputPath);
}

export function resolveCommandContext(
  context: ToolExecutionContext,
  options?: ToolCommandContextOptions,
): ToolCommandContext {
  if (context.environment) {
    return context.environment.resolveCommandContext(options);
  }

  const resolver = (context as Partial<ToolRuntimeContext>)
    .resolveCommandContext;
  if (!resolver) {
    throw missingContextMethod("resolveCommandContext()");
  }

  return resolver.call(context, options);
}
