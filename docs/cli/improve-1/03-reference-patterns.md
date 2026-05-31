# 03 · 参考设计模式

> CLI 模块改进 · 借鉴篇  
> 来源: opencode (`D:\Projects\Code-cli\opencode`), kimi-code (`D:\Projects\Code-cli\kimi-code`)  
> 日期: 2026-05-30  

---

## 1. kimi-code：同进程 RPC 代理模式

### 1.1 核心设计

**文件**：`packages/agent-core/src/rpc/client.ts`（108 行）

kimi-code 的 `createRPC` 是整个前后端通信的基础设施：

```typescript
// 创建一对 RPC client，Left 和 Right 是双向的
export function createRPC<Left, Right>(): [RPCClient<Left, Right>, RPCClient<Right, Left>] {
  // ...
  function simulateNetwork<T>(data: T): Promise<T> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const serialized = JSON.stringify(data);
        // 处理 undefined 边界情况：
        // JSON.stringify(undefined) → undefined, 不是 "undefined"
        resolve(serialized === undefined ? (undefined as T) : JSON.parse(serialized));
      }, 0);
    });
  }
  // 每个方法调用经过：序列化 → setTimeout → 反序列化 → 执行 → 序列化 → setTimeout → 反序列化
}
```

**关键设计点**：

1. **JSON 序列化边界**：`simulateNetwork()` 通过 `JSON.stringify/parse` 确保跨边界的对象是值拷贝。还处理了 `undefined` 边界情况（`JSON.stringify(undefined)` → `undefined`，不是字符串）

2. **`bindAllFunctions` 遍历原型链**：`client.ts:70-90` 遍历原型链绑定所有方法——如果 CoreAPI 实现用了 class，这个模式确保 `this` 在跨越 RPC 后仍然正确

3. **错误透传**：后端异常被 `toKimiErrorPayload()` 序列化，在前端 `fromKimiErrorPayload()` 重新抛出

4. **AbortSignal 支持**：每个 RPC 调用可以传入 `signal`，支持取消

5. **双向接口**：`createRPC<CoreAPI, SDKAPI>()` 创建双向通道

### 1.2 CoreAPI 接口设计

**文件**：`packages/agent-core/src/rpc/core-api.ts`（273 行）

```typescript
export interface CoreAPI extends SessionAPIWithId {
  // 全局操作
  getCoreInfo: () => Promise<CoreInfo>;
  getKimiConfig: () => Promise<KimiConfig>;
  setKimiConfig: (patch: KimiConfigPatch) => Promise<void>;

  // Session 生命周期
  createSession: (payload: CreateSessionPayload) => Promise<ResumeSessionResult>;
  closeSession: (payload: CloseSessionPayload) => Promise<void>;
  resumeSession: (payload: ResumeSessionPayload) => Promise<ResumeSessionResult>;
  forkSession: (payload: ForkSessionPayload) => Promise<ResumeSessionResult>;
  listSessions: () => Promise<SessionMeta[]>;
}

export interface SessionAPI {
  renameSession: (payload: RenameSessionPayload) => Promise<void>;
  listSkills: () => Promise<SkillSummary[]>;
  generateAgentsMd: (payload: AgentsMdPayload) => Promise<AgentsMdResult>;
}

export interface AgentAPI {
  prompt: (input: PromptInput) => Promise<void>;
  steer: (input: PromptInput) => Promise<void>;
  cancel: () => Promise<void>;
  setModel: (payload: SetModelPayload) => Promise<void>;
  setPermission: (payload: SetPermissionPayload) => Promise<void>;
  // ...
}
```

**设计要点**：
- `CoreAPI` 通过 `WithAgentId`/`WithSessionId` 类型包装器逐层注入 `agentId`/`sessionId`——方法在各层自动获得父作用域的 ID，调用方不需要传
- 每个操作都有明确的 payload 类型，而非散装参数
- `prompt` 和 `steer` 返回 `void`——结果通过事件异步推送
- 注意：接口中方法返回的不是 `Promise<>`——`Promise` 包装在 `RPCMethods<T>` 类型转换层（`client.ts:21-25`），接口本身保持同步签名

### 1.3 对 ohbaby 的启示

1. **JSON 序列化边界是低成本高收益的设计**：kimi-code 的 `simulateNetwork()` 只需要 6 行代码，但消除了对象引用耦合
2. **CoreAPI 不需要完全照搬 kimi-code 的三层嵌套**：ohbaby 的 session 管理更简单，8 个方法平铺就够了
3. **subscribeEvents 不进 RPC 是正确的**：kimi-code 也是这个模式——`emitEvent` 在 SDKAPI 中，但实际是通过注册的 listener 回调触发

---

## 2. opencode：yargs 多子命令 + CommandModule 模式

### 2.1 核心设计

**文件**：`packages/opencode/src/index.ts`（247 行）

opencode 的 CLI 入口是所有 yargs 命令的注册中心：

```typescript
const cli = yargs(args)
  .scriptName("opencode")
  .option("print-logs", { type: "boolean" })
  .option("log-level", { choices: ["DEBUG", "INFO", "WARN", "ERROR"] })
  .middleware(async (opts) => {
    // 全局初始化：日志、环境变量、数据库迁移
  })
  .command(RunCommand)           // run [message..]
  .command(GenerateCommand)      // generate
  .command(TuiThreadCommand)     // $0 [project] — 主 TUI 入口
  .command(ServeCommand)         // serve
  .command(AcpCommand)           // agent client protocol
  .command(DebugCommand)         // debug [subcommand]
  // ... 20+ 子命令
  .strict()
  .parse();
```

### 2.2 每个子命令是独立文件

**run.ts** 示例结构：
```typescript
import type { CommandModule } from "yargs";

export const RunCommand: CommandModule = {
  command: "run [message..]",
  describe: "send a prompt to opencode",
  builder: (yargs) =>
    yargs
      .positional("message", { describe: "the prompt text" })
      .option("command", { type: "string" })
      .option("continue", { type: "boolean" })
      .option("session", { type: "string" }),
  handler: async (args) => {
    // 1. 获取配置
    // 2. 创建或获取 session
    // 3. 发送 prompt
    // 4. 订阅事件流
    // 5. 输出结果
  },
};
```

**设计要点**：
- 每个命令是 `CommandModule` 对象：`command` + `describe` + `builder` + `handler`
- 全局 `--print-logs` / `--log-level` / `--pure` 通过 `.option()` 在顶层注册，所有子命令继承
- `.middleware()` 处理所有子命令共享的初始化逻辑（日志、环境变量、数据库迁移）
- 新增子命令 = 新增一个文件 + 在 `index.ts` 加一行 `.command()`

### 2.3 对 ohbaby 的启示

1. **全局 option 用 `.option()` 在顶层注册**：`--mode` / `--permission` 对所有子命令生效，不需要在每个子命令中重复
2. **middleware 适合放 `loadRuntimeEnvIntoProcessEnv`**：一次注册，所有子命令执行前自动调用
3. **占位子命令（如 serve）可以先定义**：handler 里面 `process.exit(1)` 即可，接口先占好
4. **不需要 opencode 那样的 20+ 子命令**：ohbaby 当前 3 个（$0, run, serve）就够了。YAGNI

---

## 3. 两个项目的共同模式：前端持有入口，后端核心独立

| | opencode | kimi-code | ohbaby（迁移后目标） |
|---|---|---|---|
| 前端包 | `packages/opencode` | `apps/kimi-code` | `ohbaby-cli`（含 `cli/` 入口 + `tui/` 渲染） |
| CLI 入口位置 | `packages/opencode/src/index.ts` | `apps/kimi-code/src/main.ts` | `packages/ohbaby-cli/src/bin.ts`（迁移后） |
| CLI 用哪个库 | yargs | Commander.js | yargs（学习 opencode） |
| 依赖方向 | cli → core | app → agent-core | **ohbaby-cli → ohbaby-agent**（翻转后） |
| 前后端通信 | Worker RPC + Hono HTTP | 同进程 typed RPC proxy | 同进程 RPC proxy（学习 kimi-code） |
| 参数解析风格 | 多子命令 (`command()`) | 单命令 + options (`.option()`) | 多子命令（学习 opencode） |

**核心规律**：
- 前端包同时持有**进程入口**与**渲染**（TUI/stdout），依赖指向后端核心——后端不依赖前端
- 参数解析用成熟库而非手写
- 前后端有明确的接口契约（RPC/HTTP），不共享对象引用

> ohbaby 迁移把入口与 IO 从 `ohbaby-agent` 迁入 `ohbaby-cli`，正是对齐这一规律。详见 [05 CLI 模块迁移](./05-cli-module-migration.md)。
