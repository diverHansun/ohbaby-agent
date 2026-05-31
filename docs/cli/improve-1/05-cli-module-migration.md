# 05 · CLI 模块迁移：`ohbaby-cli` 成为真正的前端（方案 A）

> CLI 模块改进 · 包结构迁移设计篇
> 日期: 2026-05-30
> 状态: 设计已定，待 codex 撰写实施计划
> 关系: 本文是 [01 问题分析](./01-problem-analysis.md) 问题 4 的解决方案，并为 [02 实施方案](./02-implementation-plan.md) 的 Phase 1–4 提供包结构前提。

---

## 1. 背景与决策

### 1.1 根因（见 [01 问题 4](./01-problem-analysis.md)）

当前包职责切分有两层结构性错误：

- **依赖方向倒置**：`ohbaby-agent`（后端核心）依赖 `ohbaby-cli`（前端），并在 `bin.ts:88` 通过 `await import("ohbaby-cli")` 反向加载前端。稳定核心依赖易变 UI，违反稳定依赖原则与 DIP（references/02）。
- **CLI 入口错位**：进程入口（`bin.ts`）、参数解析（`cli/args.ts`）、管道输入（`cli/stdin.ts`）、非交互渲染（`cli/stdout-renderer.ts`）全部住在后端包；而名为 `cli` 的包里只有 TUI 渲染。后端被迫兼任 "CLI composition layer"（见 `ohbaby-agent/package.json:4`）。

### 1.2 决策：方案 A —— 迁移而非改名

把进程入口与 CLI IO 从 `ohbaby-agent` **迁入** `ohbaby-cli`，**翻转依赖方向**（`ohbaby-cli → ohbaby-agent`），让 `ohbaby-cli` 成为对齐 kimi-code `apps/kimi-code` 的真正前端包。

**为什么不改名**：早期曾考虑改名为 `ohbaby-terminal` 来消除"名不副实"。但根因是入口错位，不是名字——迁移后 `ohbaby-cli` 真的成为完整 CLI 前端（入口 + 参数 + 非交互渲染 + TUI），名字即准确。命名体系（web/app/…）待 `ohbaby-web` 真正落地、家族 ≥2 成员时再统一决定（可逆决策，YAGNI）。**改名任务已取消**（原 `docs/problem-lists/rename-ohbaby-cli.md` 已删除）。

### 1.3 参考依据

| | opencode | kimi-code | ohbaby（迁移后目标） |
|---|---|---|---|
| 前端包 | `packages/opencode`（CLI 入口包） | `apps/kimi-code`（`main.ts`+`cli/`+`tui/`） | `ohbaby-cli`（`bin.ts`+`cli/`+`tui/`） |
| 后端核心 | `packages/core` | `packages/agent-core` | `ohbaby-agent` |
| 契约 | `packages/sdk` | `packages/node-sdk` | `ohbaby-sdk` |
| 依赖方向 | cli → core | app → agent-core | **cli → agent**（翻转后） |
| 入口归属 | 前端 | 前端 | **前端**（迁移后） |

两个参考项目的共同规律：**前端持有进程入口、依赖后端核心；后端不依赖前端。** ohbaby 当前恰好反了，方案 A 把它扳正。

---

## 2. 目标拓扑

### 2.1 迁移前（依赖倒置）

```
ohbaby-agent (后端核心 + 进程入口 + cli IO)  ──依赖──▶  ohbaby-cli (只有 tui)  ──▶  ohbaby-sdk
       │  bin.ts: await import("ohbaby-cli")   ▲_____________________________________|
       └ 持有 bin: ohbaby                       后端"向上"够到前端 —— 方向反了
```

### 2.2 迁移后（依赖翻正）

```
ohbaby-cli  =  终端前端（bin + cli/{args→yargs, stdin, stdout-renderer, exit-codes} + tui）   ← 持有 bin: ohbaby
     │ 依赖（静态）
     ▼
ohbaby-agent  =  纯后端核心（adapters / commands / agents / mcp / runtime / session / permission / …）
     │ 依赖
     ▼
ohbaby-sdk  =  契约（UI 类型 + CoreAPI/SDKAPI + createRPC + 命令 parse/resolve）
```

命名边界：

- `ohbaby-cli/src/cli/commands/` 是 yargs 启动命令层，只处理进入 TUI 之前的 `$0`、`run`、`serve`。
- `ohbaby-cli/src/tui/command/` 继续保留，它是 TUI 内 slash command 的补全/解析 UI 适配层，继续通过 SDK resolver 处理 `/models`、`/sessions`、`/permission` 等启动后的输入。它不能被 yargs 的 `cli/commands/` 替代。

### 2.3 三包职责

- **`ohbaby-cli`（前端）**：捕获用户输入与进程参数、引导进程、渲染（TUI 交互渲染 + 非交互 stdout 渲染）。通过 SDK 契约与后端对话。
- **`ohbaby-agent`（后端核心）**：执行 prompt / 命令、管理 session / 权限 / MCP / 工具，发布事件。暴露 `buildCoreAPIImpl`（接缝后端侧）+ 进程级初始化工具。
- **`ohbaby-sdk`（契约）**：类型、`CoreAPI`/`SDKAPI`、`createRPC`、命令解析函数。前后端唯一共享面。

> **依赖 ≠ 紧耦合**：`ohbaby-cli → ohbaby-agent` 的包依赖仅用于**同进程引导**（前端 import 后端工厂把它启动起来）。真正的运行时通信走 SDK 的 `CoreAPI` 契约。将来要换成跨进程/HTTP 时，前端不再 import 后端，改为用同一份 `CoreAPI` 契约连接远端——UI 代码零改动（见 §4.3）。

---

## 3. 文件搬迁清单

### 3.1 迁入 `ohbaby-cli`（逻辑不变，仅位置变）

| 源（`ohbaby-agent/src/`） | 目标（`ohbaby-cli/src/`） | 说明 |
|---|---|---|
| `bin.ts` | `bin.ts` | 进程入口；重写为 yargs（[02 Phase 3](./02-implementation-plan.md)） |
| `cli/stdin.ts` | `cli/stdin.ts` | 管道输入 |
| `cli/stdout-renderer.ts` | `cli/stdout-renderer.ts` | 非交互渲染 |
| `cli/stdout-renderer.contract.test.ts` | `cli/stdout-renderer.contract.test.ts` | 随源文件迁移 |
| `cli/exit-codes.ts` | `cli/exit-codes.ts` | 退出码常量 |

> 迁入的文件若 import 了**留在后端**的模块（如 `utils/project-env` 的 `loadRuntimeEnvIntoProcessEnv`），其 import 必须从相对路径改为从包入口 `"ohbaby-agent"` 引入；后端需在 `index.ts` 导出这些符号。已确认：后端除 `bin.ts` 外无任何代码引用 `cli/` 下文件，**迁出不产生依赖环**。

### 3.2 留在 `ohbaby-agent`（后端核心，不迁移）

| 路径 | 原因 |
|---|---|
| `adapters/`（ui-inprocess / ui-persistent / ui-runtime / ui-state） | 构造后端 `CoreAPI` 实现，接缝后端侧 |
| `commands/`（catalog / builtin / service / run-context / events） | 命令**执行**是后端能力（见 [commands/improve-1](../../commands/improve-1/01-problem-analysis.md)） |
| `agents/`、`mcp/`、`runtime/`、`session?`、`permission/`、`tools/`、`snapshot/`、`config/`、`core/`、`bus/`、`project/`、`sandbox/`、`services/`、`shell/`、`skill/`、`utils/` | 纯后端核心 |
| `index.ts` | 后端公共出口（新增导出 `buildCoreAPIImpl`、`loadRuntimeEnvIntoProcessEnv`） |

### 3.3 删除（不迁移）

| 文件 | 原因 |
|---|---|
| `cli/args.ts` | 被 yargs 替代（[02 Phase 3](./02-implementation-plan.md)） |
| `cli/args.unit.test.ts` | 同上 |
| `bin.unit.test.ts` | bin.ts 迁出并重写；yargs 入口由 [04 §3](./04-testing-and-acceptance.md) 验收 |

### 3.4 新增

| 文件 | 包 | 内容 |
|---|---|---|
| `host/core-api-factory.ts` | agent | `buildCoreAPIImpl`（[02 Phase 2](./02-implementation-plan.md)）；置于 `host/` 而非 `cli/`，因 `cli/` 迁出 |
| `cli/commands/{terminal,run,serve}.ts` | cli | yargs 子命令（[02 Phase 3](./02-implementation-plan.md)） |
| `rpc/types.ts`、`rpc/proxy.ts` | sdk | `CoreAPI`/`SDKAPI` + `createRPC`（[02 Phase 1](./02-implementation-plan.md)） |

---

## 4. 接缝设计（同进程 RPC，留跨进程口子）

### 4.1 后端侧：`buildCoreAPIImpl`

后端在 `host/core-api-factory.ts` 暴露工厂，封装：后端客户端构造、`CoreAPI` 实现、事件订阅（`SDKAPI`）、资源释放（`dispose`）。从 `ohbaby-agent` 入口导出。详见 [02 Phase 2](./02-implementation-plan.md)。

### 4.2 前端侧：`bin.ts` 接线

```
[ohbaby-cli] bin.ts
  → loadRuntimeEnvIntoProcessEnv()        // 从 ohbaby-agent 导入
  → yargs 解析 → 选择子命令
  → buildCoreAPIImpl(opts)                // 从 ohbaby-agent 导入（同进程引导）
  → createRPC 包装 → CoreAPI 代理         // 从 ohbaby-sdk 导入
  → terminal: renderTerminalUi(core)      // 同包 tui
    或 run:    stdout-renderer 消费事件     // 同包 cli/
```

### 4.3 同进程现在、跨进程将来

- **现在（同进程）**：前端静态 `import { buildCoreAPIImpl } from "ohbaby-agent"`，在本进程启动后端，`createRPC` 提供 JSON 序列化边界（值拷贝，消除对象引用耦合）。
- **将来（跨进程/HTTP）**：把"获取 CoreAPI"的方式从"import 后端工厂"换成"用 SDK 契约连接远端 server"。**前端 UI/渲染代码不变**，只换 `bin.ts` 里"如何取得 CoreAPI"这一处接线。

> **`serve` 的归属（避免把后端 server 塞进前端包）**：`serve` 子命令在前端 `ohbaby-cli` 里**只做 yargs 注册 + 薄启动器**，真正的 headless server 循环属于**后端**——应由 `ohbaby-agent` 暴露 `startServer()`（未来），前端 `serve` handler 只调用它。当前阶段 `serve` 仅为占位（打印 not-implemented），不实现 server，避免前端重新host后端循环、把刚拆开的耦合又绑回去。

> 这正是把接缝抽成 `CoreAPI` 契约（而非直接传后端对象）的价值：传输层可换，契约不变。

---

## 5. 依赖与配置影响面（完整清单）

> 因**保留包名 `ohbaby-cli`**，基于路径名的别名（vitest react 解析、tsconfig path 映射）大多无需改动——影响集中在**依赖方向**与**入口归属**，而非路径重命名。逐项如下：

| # | 文件 | 改动 | 漏改后果 |
|---|------|------|---------|
| 1 | `packages/ohbaby-agent/package.json` | 删除 `bin` 字段；从 deps 移除 `ohbaby-cli`；移除已死的 `commander`（手写 `args.ts` 删除后无消费者） | 残留反向依赖 / 双入口 / 死依赖 |
| 2 | `packages/ohbaby-cli/package.json` | 新增 `bin: { ohbaby: "./dist/bin.js" }`；deps 增 `ohbaby-agent`、`yargs`；devDeps 增 `@types/yargs` | 无可执行入口 / 解析失败 / 类型缺失 |
| 3 | `packages/ohbaby-agent/tsconfig.json` | 移除对 `../ohbaby-cli` 的 project reference | 构建图含反向引用，`tsc -b` 可能成环 |
| 4 | `packages/ohbaby-cli/tsconfig.json` | 新增对 `../ohbaby-agent` 的 project reference | 类型解析失败 |
| 5 | `packages/ohbaby-agent/tsup.config.ts` | 从 `external` 移除 `ohbaby-cli`；`entry` 移除 `src/bin.ts` | 试图打包已不存在的依赖 |
| 6 | `packages/ohbaby-cli/tsup.config.ts` | `entry` 增 `src/bin.ts`；`external` 增 `ohbaby-agent` | bin 未产出 / 后端被错误内联 |
| 7 | `tsconfig.json`（根） | 校验两包 references 顺序（被依赖者在前） | 增量构建顺序错误 |
| 8 | `tsconfig.base.json` | 校验 `ohbaby-cli` / `ohbaby-agent` path 映射齐全（名未变，通常无需改） | 类型解析 |
| 9 | `vitest.config.ts` / `vitest.e2e.config.ts` | 名未变，`ohbaby-cli` / `ohbaby-agent` alias 与 react 解析路径基本保留；校验即可 | 测试解析 |
| 10 | `packages/ohbaby-agent/src/utils/index.ts` | **新增导出** `loadRuntimeEnvIntoProcessEnv`（当前定义在 `utils/project-env.ts:28`，但 `utils/index.ts` 未 re-export，故从包入口不可达）；前端 `bin.ts` 依赖它 | 前端 import 失败 |
| 11 | `packages/ohbaby-agent/src/index.ts` + 新建 `src/host/` 出口 | 导出 `buildCoreAPIImpl`（`export … from "./host/core-api-factory.js"`）；`host/` 是新目录，index 当前无 host re-export | 前端取不到后端工厂 |
| 12 | `tests/integration/cli/packaging-smoke.integration.test.ts` | **重写**（不是"保持通过"）：当前硬编码旧拓扑——断言 `bin` 属于 `ohbaby-agent`、`--help` 含手写文案 `"Usage: ohbaby [options]"` 与 `"-p, --prompt"`、`--version` 取 agent 版本（见该文件 ~L262/L291-300/L314）。yargs + bin 迁移后这些断言全失效，需改为：bin 属 `ohbaby-cli`、yargs 帮助文案、`run` 子命令语法、版本取 cli 包 | 打包验收假阳/假阴 |
| 13 | `tests/integration/cli/prompt-process.integration.test.ts` | spawn `ohbaby` bin，断言旧 `-p`/prompt 进程行为；按 yargs `run` 子命令调整 | 测试失败 |
| 14 | `tests/integration/tui/persistent-display.integration.test.tsx`、`tests/smoke/tui-real-provider.smoke.test.tsx`、`tests/integration/tui/main-chain.integration.test.tsx` | Phase 4 CoreAPI 替换影响这些（import `OhbabyTerminalApp` / `TuiBackendClient`）；mock 改 CoreAPI | 测试失败 |
| 15 | `pnpm-lock.yaml` | `pnpm install` 重新生成（依赖图改变） | lock 与 manifest 不一致 |
| 16 | `README.md`、`packages/*/README.md`、`package.json` description | 更新"agent 依赖 cli"等描述为翻转后的方向 | 文档误导 |

---

## 6. 统一路线图（与 01–04、commands/improve-1 对齐）

```
[commands/improve-1]  类型/解析去重到 SDK（独立轨，前端将依赖 SDK 命令契约）

[cli/improve-1]
  Phase 1  SDK: CoreAPI/SDKAPI + createRPC
    → Phase 2  后端: buildCoreAPIImpl（src/host/，从 index 导出）
    → 迁移(本文): bin.ts + cli/ 迁入 ohbaby-cli；翻转依赖；删动态 import + tsup external
    → Phase 3  前端: yargs 入口（落在 ohbaby-cli）
    → Phase 4  前端: TUI 改用 CoreAPI
    → 全量验证（§8 + 04）
```

**为何这个顺序**：先建契约（1）与后端工厂（2）形成干净接缝，再把入口迁过接缝（迁移），避免搬一个还耦合着直接对象引用的入口；yargs（3）与 TUI 改造（4）在迁移后的前端包内自然落位。

---

## 7. 风险与回滚

| 风险 | 说明 | 缓解 |
|------|------|------|
| 依赖环 | 后端遗留 import 已迁出的文件 → `agent → cli` 与 `cli → agent` 成环 | 已确认后端除 bin.ts 外无 `cli/` 引用；迁移后 `rg` 复查（[04 §7 检查 8/10](./04-testing-and-acceptance.md)） |
| 运行期解析 | "编译通过 ≠ 运行通过"，尤其入口与依赖图变动 | 必须真实启动 `ohbaby` + 跑 `packaging-smoke`（§8） |
| react 单实例 | TUI 依赖 vitest 的 react 解析 alias；包名未变故路径保留，但仍需校验 | §8 跑全量 TUI/e2e 测试 |
| 迁入文件的 import | 迁入文件引用后端 `utils/project-env` 等 → 需改为从 `ohbaby-agent` 入口 import，且后端要导出 | 迁移时统一 repoint + 导出 |

**回滚**：迁移是纯结构移动（`git mv` 保留历史 + 配置改动），无数据/契约破坏。出问题 `git revert` 即可；与 Phase 1/2（纯增量）解耦，可独立回退。

---

## 8. 验证清单

- [ ] 三包编译：`pnpm --filter ohbaby-sdk build`、`--filter ohbaby-agent build`、`--filter ohbaby-cli build` 全通过
- [ ] 依赖方向：`rg "ohbaby-cli" packages/ohbaby-agent/package.json` 空；`rg "ohbaby-agent" packages/ohbaby-cli/package.json` 命中
- [ ] `bin` 归属：`ohbaby-agent/package.json` 无 `bin`；`ohbaby-cli/package.json` 有
- [ ] 无反向动态 import：`rg 'import\("ohbaby-cli"\)' packages/` 空
- [ ] 无依赖环：`tsc -b` 通过 + 人工确认 `agent/src` 无 `from "ohbaby-cli"`、且无相对引用 `from "./cli/"` / `from "../cli/"`（迁出后不得再有）
- [ ] **运行期**：真实启动 `ohbaby`（TUI 起得来）、`ohbaby run "..."`、`echo ... | ohbaby run`
- [ ] `packaging-smoke.integration.test.ts` **重写后**通过（断言 bin 属 `ohbaby-cli`、yargs 帮助、`run` 语法、cli 包版本——见 §5 行 12）
- [ ] MCP 释放：`ohbaby run` 结束后无遗留 MCP 子进程（验证 factory `dispose` 调了 `McpManager.disposeAll()`）
- [ ] 全量：`pnpm test`（含 TUI 契约 / 集成 / e2e）通过
- [ ] `pnpm install` 后 `pnpm-lock.yaml` 干净（无悬挂依赖）

---

## 9. 不做的事（YAGNI 护栏）

- **不改名**：包名保持 `ohbaby-cli`。
- **不在前端内部再拆 tui 子包/空抽象层**：`tui/` 留在原地与新迁入的 `cli/` 做邻居即可。用户已明确"不要单独把 tui 拿出来"。等真有非 TUI 的终端关注点（键位/剪贴板/能力探测）再分。
- **不提前实现 `serve`/HTTP 跨进程**：仅留占位与契约口子（§4.3）。同进程优先。
- **不动 commands 后端三层架构**：命令执行留后端，前端只触发 + 用 SDK 解析。
