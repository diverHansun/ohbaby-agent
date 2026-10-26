import type {
  ReasoningConfig,
  ReasoningIntent,
  LLMClientInstance,
} from "ohbaby-llm";
import type { RunModel } from "../run-model.js";
import { RunManager as RunManagerImpl } from "../../runtime/run-manager/manager.js";
import type { CreateRunOptions } from "../../runtime/run-manager/types.js";
import {
  AgentService as AgentServiceImpl,
  type AgentServiceOptions,
} from "../../agents/service.js";
import type { StartSessionParams } from "../../agents/types.js";
import {
  SessionSubagentHost as SessionSubagentHostImpl,
  type SessionSubagentHostOptions,
} from "../../agents/subagent-host.js";
import {
  createUiRuntimeComposition as createComposition,
  type UiRuntimeCompositionOptions,
} from "../../adapters/ui-runtime/composition.js";
import type { UiRuntimeComposition } from "../../adapters/ui-runtime/types.js";
import { createRunModel } from "../../adapters/ui-runtime/run-model.js";
import { testRunModel, TestLifecycle } from "./model-fixtures.js";

type OptionalModel<T extends { readonly runModel: RunModel }> = Omit<
  T,
  "runModel"
> & { readonly runModel?: RunModel };
export class TestRunManager extends RunManagerImpl {
  private readonly fixtureModel?: RunModel;
  constructor(deps: ConstructorParameters<typeof RunManagerImpl>[0]) {
    super(deps);
    this.fixtureModel =
      deps.lifecycle instanceof TestLifecycle
        ? deps.lifecycle.fixtureModel
        : undefined;
  }
  override create(
    options: OptionalModel<CreateRunOptions>,
  ): ReturnType<RunManagerImpl["create"]> {
    return super.create({
      ...options,
      runModel:
        options.runModel ?? this.fixtureModel ?? testRunModel(options.modelId),
    });
  }
}
export class TestAgentService extends AgentServiceImpl {
  private readonly model: RunModel;
  constructor(
    options: AgentServiceOptions & {
      readonly modelId: string;
      readonly getReasoning?: () =>
        | ReasoningConfig
        | ReasoningIntent
        | undefined;
    },
  ) {
    super(options);
    const model = testRunModel(options.modelId);
    this.model = {
      ...model,
      client: {
        ...model.client,
        config: { ...model.client.config, reasoning: options.getReasoning?.() },
      },
    };
  }
  override startSession(
    input: OptionalModel<StartSessionParams>,
  ): ReturnType<AgentServiceImpl["startSession"]> {
    return super.startSession({
      ...input,
      runModel: input.runModel ?? this.model,
    });
  }
}
export class TestSessionSubagentHost extends SessionSubagentHostImpl {
  constructor(
    options: Omit<SessionSubagentHostOptions, "getParentRunModel"> & {
      readonly modelId: string;
      readonly getParentRunModel?: SessionSubagentHostOptions["getParentRunModel"];
    },
  ) {
    const model = testRunModel(options.modelId);
    super({
      ...options,
      getParentRunModel: options.getParentRunModel ?? ((): RunModel => model),
    });
  }
}
export type TestUiRuntimeCompositionOptions = Omit<
  UiRuntimeCompositionOptions,
  "resolveRunModel"
> & {
  readonly llmClient: LLMClientInstance;
  readonly resolveRunModel?: UiRuntimeCompositionOptions["resolveRunModel"];
};
export type TestUiRuntimeComposition = Omit<
  UiRuntimeComposition,
  "startSession" | "runManager"
> & {
  startSession(
    input: OptionalModel<StartSessionParams>,
  ): ReturnType<UiRuntimeComposition["startSession"]>;
  readonly runManager: Omit<RunManagerImpl, "create"> & {
    create(
      input: OptionalModel<CreateRunOptions>,
    ): ReturnType<RunManagerImpl["create"]>;
  };
};
export async function createTestUiRuntimeComposition(
  options: TestUiRuntimeCompositionOptions,
): Promise<TestUiRuntimeComposition> {
  const { llmClient, ...rest } = options;
  const runModel = createRunModel("fixture", llmClient);
  const runtime = await createComposition({
    ...rest,
    resolveRunModel:
      rest.resolveRunModel ??
      ((): Promise<RunModel> => Promise.resolve(runModel)),
  });
  const create = runtime.runManager.create.bind(runtime.runManager);
  const runManager = runtime.runManager;
  const fixtureManager = Object.assign(runManager, {
    create(
      input: OptionalModel<CreateRunOptions>,
    ): ReturnType<RunManagerImpl["create"]> {
      return create({ ...input, runModel: input.runModel ?? runModel });
    },
  });
  return {
    ...runtime,
    runManager: fixtureManager,
    startSession: (input) =>
      runtime.startSession({ ...input, runModel: input.runModel ?? runModel }),
  };
}
