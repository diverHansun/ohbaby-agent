import type { LLMClientInstance } from "ohbaby-llm";
import { createRunModel } from "../../adapters/ui-runtime/run-model.js";
import { createContextManager as createContextManagerImpl } from "../context/context-manager.js";
import type {
  ContextManager,
  ContextManagerOptions,
  ContextAssemblyOptions,
  CompactOptions,
  PrepareTurnInput,
  CreateRunPromptSnapshotInput,
  TokenCounter,
  ContextLLMClient,
} from "../context/types.js";
import { Lifecycle as LifecycleImpl } from "../lifecycle/lifecycle.js";
import type {
  LifecycleDeps,
  LifecycleSessionParams,
} from "../lifecycle/types.js";
import type { ContextModel, RunModel } from "../run-model.js";

type WithOptionalModel<T extends { readonly runModel: ContextModel }> = Omit<
  T,
  "runModel"
> & { readonly runModel?: T["runModel"] };

export type TestPrepareTurnInput = WithOptionalModel<PrepareTurnInput>;
export type TestCompactOptions = WithOptionalModel<CompactOptions>;
export type TestLifecycleSessionParams =
  WithOptionalModel<LifecycleSessionParams>;

export type TestContextManager = Omit<
  ContextManager,
  | "assemble"
  | "getUsage"
  | "compact"
  | "prepareTurn"
  | "createRunPromptSnapshot"
  | "updateCalibrationFactor"
> & {
  updateCalibrationFactor(
    sessionId: string,
    actual: number,
    heuristic: number,
    scopeId?: string,
    runModel?: ContextModel,
  ): void;
  assemble(
    sessionId: string,
    directory: string,
    input: WithOptionalModel<ContextAssemblyOptions>,
  ): ReturnType<ContextManager["assemble"]>;
  getUsage(
    input: WithOptionalModel<Parameters<ContextManager["getUsage"]>[0]>,
  ): ReturnType<ContextManager["getUsage"]>;
  compact(
    sessionId: string,
    input: TestCompactOptions,
  ): ReturnType<ContextManager["compact"]>;
  prepareTurn(
    input: TestPrepareTurnInput,
  ): ReturnType<ContextManager["prepareTurn"]>;
  createRunPromptSnapshot(
    input: WithOptionalModel<CreateRunPromptSnapshotInput>,
  ): ReturnType<ContextManager["createRunPromptSnapshot"]>;
};

/** Adapts existing single-model scenarios while the production API stays per-call. */
export function bindTestContextModel(
  manager: ContextManager,
  runModel: ContextModel,
): TestContextManager {
  const bound: TestContextManager = {
    ...manager,
    updateCalibrationFactor: (sessionId, actual, heuristic, scopeId) => {
      manager.updateCalibrationFactor(
        sessionId,
        actual,
        heuristic,
        scopeId,
        runModel,
      );
    },
    assemble: (sessionId, directory, input) =>
      manager.assemble(sessionId, directory, { ...input, runModel }),
    getUsage: (input) => manager.getUsage({ ...input, runModel }),
    compact: (sessionId, input) =>
      manager.compact(sessionId, { ...input, runModel }),
    prepareTurn: (input) => manager.prepareTurn({ ...input, runModel }),
    createRunPromptSnapshot: (input) =>
      manager.createRunPromptSnapshot({ ...input, runModel }),
  };
  fixtureModels.set(bound, runModel);
  return bound;
}

export type TestContextManagerOptions = ContextManagerOptions & {
  readonly tokenCounter: TokenCounter;
  readonly llmClient: ContextLLMClient;
};

const fixtureModels = new WeakMap<ContextManager, ContextModel>();

export function createTestContextManager(
  options: TestContextManagerOptions,
): TestContextManager {
  const { tokenCounter, llmClient, ...settings } = options;
  return bindTestContextModel(createContextManagerImpl(settings), {
    entryId: "fixture",
    tokenCounter,
    summaryClient: llmClient,
  });
}

export class TestLifecycle extends LifecycleImpl {
  readonly fixtureModel: RunModel;
  constructor(
    options: LifecycleDeps & { readonly llmClient: LLMClientInstance },
  ) {
    const { llmClient, ...deps } = options;
    super({
      ...deps,
      contextManager: {
        ...deps.contextManager,
        updateCalibrationFactor: (sessionId, actual, heuristic, scopeId) => {
          const fixture = deps.contextManager as TestContextManager;
          if (scopeId === undefined)
            fixture.updateCalibrationFactor(sessionId, actual, heuristic);
          else
            fixture.updateCalibrationFactor(
              sessionId,
              actual,
              heuristic,
              scopeId,
            );
        },
      },
    });
    this.fixtureModel = {
      ...createRunModel("fixture", llmClient),
      ...fixtureModels.get(deps.contextManager),
    };
  }
  override run(
    params: TestLifecycleSessionParams,
    ...rest: Parameters<LifecycleImpl["run"]> extends [unknown, ...infer R]
      ? R
      : never
  ): ReturnType<LifecycleImpl["run"]> {
    return super.run(
      { ...params, runModel: params.runModel ?? this.fixtureModel },
      ...rest,
    );
  }
}

/** For orchestration tests whose fake lifecycle never calls a provider. */
export function testRunModel(model = "test-model"): RunModel {
  return createRunModel("fixture", {
    config: {
      provider: "test",
      model,
      baseUrl: "http://localhost",
      interfaceProvider: "openai-compatible",
      maxTokens: 8192,
    },
    provider: {
      id: "test",
      kind: "openai-compatible",
      client: {},
      streamResponse(): ReturnType<
        LLMClientInstance["provider"]["streamResponse"]
      > {
        throw new Error("Unexpected provider call in orchestration fixture");
      },
      isAbortError: () => false,
    },
  });
}
