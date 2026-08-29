import type { DiagnosticEventDefinition, Logger } from "ohbaby-agent";

export function emitDiagnosticSafely<Input>(
  logger: Logger,
  definition: DiagnosticEventDefinition<Input>,
  input: NoInfer<Input>,
): void {
  try {
    logger.emit(definition, input);
  } catch {
    // Injected diagnostics must never change the server operation.
  }
}
