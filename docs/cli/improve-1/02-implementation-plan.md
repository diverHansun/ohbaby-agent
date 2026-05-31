# 02 · 实施方案与计划

> CLI 模块改进 · 执行篇  
> 日期: 2026-05-30  

---

## 1. 总体策略

三个核心改动：
- **包结构层**：把进程入口与 CLI IO（`bin.ts` + `cli/`）从 `ohbaby-agent` 迁入 `ohbaby-cli`，翻转依赖方向，`ohbaby-cli` 成为真正的前端。详见 [05 CLI 模块迁移](./05-cli-module-migration.md)。
- **通信层**：引入 RPC 代理边界，用 `CoreAPI` 替代 `TuiBackendClient`。
- **入口层**：用 yargs 多子命令替代手写参数解析。

> 入口迁移后，前端不再被后端动态 `import`；而是前端提供可注入 host loader，默认 bin 再动态加载后端 `buildCoreAPIImpl` 并通过 `createRPC` 取得 `CoreAPI` 代理。原 `bin.ts` 里的 `await import("ohbaby-cli")` 与后端对前端的 external 项随之删除。

改动方向：

```
改前（入口在后端，后端动态 import 前端 —— 依赖倒置）：
  [ohbaby-agent] bin.ts → parseCliArgs (手写) → createPersistentUiBackendClient
                        → await import("ohbaby-cli") → TUI/stdout

改后（入口在前端，前端依赖后端 —— 依赖翻正）：
  [ohbaby-cli] bin.ts → yargs subcommands → injected/default agent loader → createRPC → CoreAPI
           ├── $0        → 交互模式 (terminal command) → renderTerminalUi(同包直接调用)
           ├── run       → 非交互模式 (run command)     → stdout-renderer(同包)
           └── serve     → daemon 模式 (占位)
```

---

## 2. 执行阶段

### Phase 1：SDK 增加 RPC 类型和代理工具

**目标**：在 `ohbaby-sdk` 中定义 `CoreAPI` 接口和 `createRPC` 工具函数。

#### 1.1 新增文件：`packages/ohbaby-sdk/src/rpc/types.ts`

```typescript
import type {
  SubmitPromptOptions,
  UiCommandCatalog,
  UiCommandInvocation,
  UiCommandSurface,
  UiCompactSessionOptions,
  UiCompactSessionResult,
  UiEventHandler,
  UiInteractionResponse,
  UiPermissionResponse,
  UiSnapshot,
  UiUnsubscribe,
} from "../index.js";

/** TUI/前端 → 后端：前端可调用的方法 */
export interface CoreAPI {
  getSnapshot(): Promise<UiSnapshot>;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
  executeCommand(invocation: UiCommandInvocation): Promise<void>;
  listCommands(query: { surface: UiCommandSurface }): Promise<UiCommandCatalog>;
  respondPermission(
    requestId: string,
    response: UiPermissionResponse,
  ): Promise<void>;
  respondInteraction(
    interactionId: string,
    response: UiInteractionResponse,
  ): Promise<void>;
  abortRun(runId?: string): Promise<void>;
  compactSession(
    options?: UiCompactSessionOptions,
  ): Promise<UiCompactSessionResult>;
}

/** 后端 → TUI/前端：后端推事件给前端 */
export interface SDKAPI {
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
}
```

#### 1.2 新增文件：`packages/ohbaby-sdk/src/rpc/proxy.ts`

参考 kimi-code `agent-core/src/rpc/client.ts:31-103` 的 `createRPC` 实现：

```typescript
/**
 * 创建同进程 RPC 代理对。
 *
 * 返回两个函数：
 * - createProxy(sdkImpl) → CoreAPI proxy 给 TUI 用
 * - createImpl(coreImpl) → 连接后端实现
 *
 * 每个方法调用经过 JSON 序列化/反序列化（setTimeout 0），
 * 确保前后端不共享对象引用。
 */
export function createRPC<API, CallbackAPI>(): {
  createProxy: (callbacks: CallbackAPI) => API;
  connectImpl: (impl: API) => void;
} { /* ... */ }
```

**设计要点**：
- JSON 序列化边界：`setTimeout(() => JSON.parse(JSON.stringify(data)), 0)` 确保异步 + 值拷贝
- 错误序列化：后端异常被捕获、序列化、在前端重新抛出
- `subscribeEvents` 不进 RPC 代理——事件回调是本地注册操作，直接透传 handler

#### 1.3 修改文件：`packages/ohbaby-sdk/src/index.ts`

新增导出：
```typescript
export type { CoreAPI, SDKAPI } from "./rpc/types.js";
export { createRPC } from "./rpc/proxy.js";
```

**影响范围**：纯增量。SDK 现有导出不变。

**验证**：
- `pnpm --filter ohbaby-sdk build` 编译通过
- `pnpm --filter ohbaby-sdk test` 单测通过

---

### Phase 2：后端适配——创建 CoreAPI 实现

**目标**：agent 提供 `buildCoreAPIImpl(args)` 工厂函数，替代 `createPersistentUiBackendClient`。

#### 2.1 新增文件：`packages/ohbaby-agent/src/host/core-api-factory.ts`

> 放在后端 `src/host/`（而非 `src/cli/`）——因为 `cli/` 将随迁移迁出到前端（见 [05](./05-cli-module-migration.md)），而 `buildCoreAPIImpl` 是**接缝的后端侧**，必须留在后端。它从 `ohbaby-agent` 的入口导出（`export { buildCoreAPIImpl } from "./host/core-api-factory.js"`），供前端 `ohbaby-cli` 静态 import。

```typescript
import type { CoreAPI, SDKAPI, UiSnapshot } from "ohbaby-sdk";
import { createPersistentUiBackendClient } from "../adapters/ui-persistent.js";

export interface CliOptions {
  mode?: "plan" | "auto";
  permission?: "default" | "full-access";
}

function initialSnapshot(opts: CliOptions): UiSnapshot | undefined {
  if (!opts.mode && !opts.permission) return undefined;
  return {
    activeSessionId: null,
    permission: {
      level: opts.permission ?? "default",
      mode: opts.mode ?? "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

export function buildCoreAPIImpl(opts: CliOptions): {
  core: CoreAPI;
  callbacks: SDKAPI;
  dispose: () => Promise<void>;
} {
  const client = createPersistentUiBackendClient({
    initialSnapshot: initialSnapshot(opts),
  });

  return {
    core: {
      getSnapshot: () => client.getSnapshot(),
      submitPrompt: (text, options) => client.submitPrompt(text, options),
      executeCommand: (invocation) => client.executeCommand(invocation),
      listCommands: (query) => client.listCommands(query) as Promise<any>,
      respondPermission: (id, resp) => client.respondPermission(id, resp),
      respondInteraction: (id, resp) => client.respondInteraction?.(id, resp) ?? Promise.resolve(),
      abortRun: (runId) => client.abortRun(runId),
      compactSession: (opts) => client.compactSession?.(opts) ?? Promise.resolve({ status: "idle" }),
    },
    callbacks: {
      subscribeEvents: (handler) => client.subscribeEvents(handler as any),
    },
    dispose: async () => {
      // 必须释放 MCP 子进程 —— 等价于当前 bin.ts 的 disposeNonInteractiveResources
      // McpManager 在后端 (src/mcp)，factory 直接 import 即可，不必"从外部传入"
      await McpManager.disposeAll();
      closePersistentUiBackendDatabase();
    },
  };
}
```

**设计要点**：
- `buildCoreAPIImpl` 是代理层——内部继续使用 `createPersistentUiBackendClient`，对外暴露 `CoreAPI`
- Phase 2 先建立后端 `CoreAPI` 接缝；Phase 4 删除 `TuiBackendClient`，TUI 改收 `CoreAPI + subscribeEvents`。
- `listCommands` 的类型 cast 是因为当前返回类型是联合类型（已在 commands 改进中解决）

#### 2.2 / 2.3 / 2.4 `cli/exit-codes.ts`、`cli/stdin.ts`、`cli/stdout-renderer.ts`

逻辑不变，但**随迁移搬到 `ohbaby-cli`**（前端 IO，run 命令在前端继续使用）。见 [05](./05-cli-module-migration.md)。

**验证**：
- `pnpm --filter ohbaby-agent build` 编译通过
- 现有 adapter 单测通过（adapter 逻辑未变）

---

### Phase 3：yargs 多子命令——替换手写 parser

**目标**：用 yargs 替代 `cli/args.ts`，每个子命令独立文件。

#### 3.1 新增目录：`packages/ohbaby-cli/src/cli/commands/`

> 入口位于**前端包** `ohbaby-cli`（迁移后），参照 opencode `packages/opencode/src/cli/cmd/` 结构。`buildCoreAPIImpl` 由可注入 host loader 提供；默认 bin 动态加载后端 `ohbaby-agent`。`renderTerminalUi` 是同包模块，直接调用（不再动态 import）。

**文件：`cli/commands/terminal.ts`** — `$0` 子命令（默认 TUI 模式）

```typescript
import type { CommandModule } from "yargs";
import { buildCoreAPIImpl } from "ohbaby-agent";      // 后端工厂（接缝后端侧）
import { renderTerminalUi } from "../../tui/index.js"; // 同包，直接 import

export const TerminalCommand: CommandModule = {
  command: "$0",
  describe: "start the interactive terminal UI",
  handler: async (args) => {
    const { core, callbacks } = buildCoreAPIImpl({
      mode: args.mode as "plan" | "auto",
      permission: args.permission as "default" | "full-access",
    });
    renderTerminalUi({
      client: core,
      subscribeEvents: callbacks.subscribeEvents,
    });
  },
};
```

**文件：`cli/commands/run.ts`** — `run` 子命令（非交互模式）

```typescript
import type { CommandModule } from "yargs";
import { buildCoreAPIImpl } from "ohbaby-agent";        // 后端工厂
import { createStdoutRenderer } from "../stdout-renderer.js"; // 同包（迁移后）
import { readStdin } from "../stdin.js";                // 同包（迁移后）
import { EXIT_CODES } from "../exit-codes.js";          // 同包（迁移后）

export const RunCommand: CommandModule = {
  command: "run [prompt..]",
  describe: "run a prompt in non-interactive mode",
  builder: (yargs) =>
    yargs.positional("prompt", {
      describe: "the prompt text to send",
      type: "string",
    }),
  handler: async (args) => {
    const promptFromArg = (args.prompt as string[] | undefined)
      ?.join(" ")
      .trim();
    const prompt = promptFromArg
      ?? (process.stdin.isTTY ? "" : (await readStdin()).trim());
    if (prompt.length === 0) {
      throw new Error("run requires a prompt or piped stdin");
    }

    const { core, callbacks, dispose } = buildCoreAPIImpl({
      mode: args.mode as "plan" | "auto",
      permission: args.permission as "default" | "full-access",
    });

    const renderer = createStdoutRenderer();
    const unsub = callbacks.subscribeEvents((event) => renderer.handle(event));

    try {
      await core.submitPrompt(prompt);
      process.exitCode = EXIT_CODES.ok;
    } finally {
      unsub();
      await dispose();
    }
  },
};
```

**文件：`cli/commands/serve.ts`** — `serve` 子命令（占位）

```typescript
import type { CommandModule } from "yargs";

export const ServeCommand: CommandModule = {
  command: "serve",
  describe: "start daemon for remote frontends (ACP)",
  handler: async () => {
    process.stderr.write("serve mode is not yet implemented\n");
    process.exit(1);
  },
};
```

#### 3.2 重写文件：`packages/ohbaby-cli/src/bin.ts`

> `bin.ts` 迁入前端包 `ohbaby-cli`，`bin` 字段也随之从 `ohbaby-agent` 移到 `ohbaby-cli`（见 [05](./05-cli-module-migration.md)）。进程级初始化（环境加载）从后端 `ohbaby-agent` 导入。

```typescript
#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadRuntimeEnvIntoProcessEnv } from "ohbaby-agent"; // 后端导出的进程初始化
import { TerminalCommand } from "./cli/commands/terminal.js";
import { RunCommand } from "./cli/commands/run.js";
import { ServeCommand } from "./cli/commands/serve.js";

const VERSION = "0.1.0";

async function main(argv: string[]) {
  await loadRuntimeEnvIntoProcessEnv();

  await yargs(hideBin(argv))
    .scriptName("ohbaby")
    .option("mode", {
      choices: ["plan", "auto"] as const,
      describe: "set initial permission mode",
    })
    .option("permission", {
      choices: ["default", "full-access"] as const,
      describe: "set initial permission level",
    })
    .command(TerminalCommand)
    .command(RunCommand)
    .command(ServeCommand)
    .help()
    .version(VERSION)
    .strict()
    .parse();
}

main(process.argv);
```

#### 3.3 删除文件

| 文件 | 原因 |
|------|------|
| `cli/args.ts` | 被 yargs 替代——直接删除，不迁移到前端 |
| `cli/args.unit.test.ts` | 同上（yargs 入口验收见 04） |

**验证**：
- `pnpm --filter ohbaby-agent build` 编译通过
- `node bin.js --help` 输出正确的 yargs 生成的帮助信息
- `node bin.js --version` 输出版本号
- `node bin.js -p "hello"` → 报错 `Unknown argument: -p`（不再支持短选项，需要 `run` 子命令）
- `node bin.js run "hello"` → 正确执行非交互模式

---

### Phase 4：前端适配——ohbaby-cli 的 TUI 改用 CoreAPI

**目标**：TUI 不再依赖 `TuiBackendClient`，改用 `CoreAPI`。

> **注意被替换对象的真实形状**：`TuiBackendClient`（`store/snapshot.ts`）并非独立的 9 方法接口，而是 `Omit<UiBackendClient, …> & { …覆盖 }`——继承自完整的 `UiBackendClient`。Phase 4 替换的是这个 `Omit<UiBackendClient>` 基底，级联面（dialog/app/prompt）以此为准评估，而非仅 9 个方法。

#### 4.1 修改文件：`packages/ohbaby-cli/src/tui/index.tsx`

```typescript
import type { CoreAPI, UiEventHandler } from "ohbaby-sdk";

export interface TerminalUiOptions {
  readonly client: CoreAPI;
  readonly subscribeEvents: (handler: UiEventHandler) => () => void;
}

export function renderTerminalUi(options: TerminalUiOptions): void {
  // 内部直接使用 CoreAPI，事件订阅由 subscribeEvents 独立传入
}
```

#### 4.2 修改文件：`packages/ohbaby-cli/src/tui/store/snapshot.ts`

- 删除 `TuiBackendClient` 类型
- 新增 `TerminalClient` 类型（包装 CoreAPI + subscribeEvents）

#### 4.3 级联改动

| 文件 | 改动 |
|------|------|
| `app.tsx` | `client: TuiBackendClient` → `client: CoreAPI`；`subscribeEvents` 改用 props 传入 |
| `app.contract.test.tsx` | 测试 mock 改用 CoreAPI |
| `components/prompt/index.tsx` | 从 context 取 CoreAPI 而非 TuiBackendClient |
| `dialogs/manager.tsx` | `DialogManagerProps.client` 类型更新 |
| `dialogs/permission-dialog.tsx` | `client: TuiBackendClient` prop → `CoreAPI` |
| `dialogs/confirm.tsx` | 同上 |
| `dialogs/model-dialog.tsx` | 同上 |
| `dialogs/session-dialog.tsx` | 同上 |
| `dialogs/select-one.tsx` | 同上 |
| `index.tsx` | `TerminalUiOptions` 保持同步 |
| `store/snapshot.ts` | 删除 `TuiBackendClient`，新增 `TerminalClient` wrapper |
| `tests/integration/tui/main-chain.integration.test.tsx` | mock 改用 CoreAPI |

**注意**：包名保持 `ohbaby-cli` 不变（不改名，理由见 [01 问题 4](./01-problem-analysis.md)）。本 Phase 仅做 TUI 改用 `CoreAPI` 的类型替换。

---

## 3. 执行顺序

本文档的 Phase 1–4 嵌入 [05 CLI 模块迁移](./05-cli-module-migration.md) 的统一路线图中。推荐顺序：

```
Phase 1 (SDK: CoreAPI + createRPC)
  → Phase 2 (后端: buildCoreAPIImpl，置于 src/host/，从 index 导出)
  → 包迁移 (05: bin.ts + cli/ 迁入 ohbaby-cli，翻转依赖，删动态 import/external)
  → Phase 3 (前端: yargs 入口，落在 ohbaby-cli)
  → Phase 4 (前端: TUI 改用 CoreAPI)
  → 全量验证
```

依赖关系：契约（1）与后端工厂（2）先行，建立接缝；入口随后迁过接缝（05）；yargs（3）与 TUI 改造（4）在迁移后的前端包内完成。

---

## 4. 不改动的文件（明确排除）

| 文件 | 原因 |
|------|------|
| `adapters/ui-inprocess.ts` | 后端核心适配器，留后端（factory 内部继续使用） |
| `adapters/ui-persistent.ts` | 同上 |

> `cli/exit-codes.ts`、`cli/stdin.ts`、`cli/stdout-renderer.ts` 逻辑不变，但**位置变化**——随迁移搬到 `ohbaby-cli`（见 [05](./05-cli-module-migration.md)），不在"不改动"之列。

---

## 5. 时间估算

| Phase | 改动量 | 预计时间 | 风险 |
|-------|--------|----------|------|
| Phase 1 | SDK 新增 2 文件 + 修改 1 文件 | 2h | 低（纯增量） |
| Phase 2 | 新增 1 文件（factory.ts） | 1.5h | 低（内部胶水代码） |
| Phase 3 | 新增 3 文件 + 重写 1 文件 + 删除 2 文件 | 3h | 中（需要验证所有 CLI 入口路径） |
| Phase 4 | 修改 ~12 文件（含 6 个 dialog + 2 个 store + 2 个测试 + app/index） | 4h | 中（类型替换级联改动多） |
| 验证 | 全量测试 | 2h | 低 |

**总计**：约 14 小时。
