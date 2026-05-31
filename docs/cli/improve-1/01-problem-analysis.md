# 01 · 代码现状与问题分析

> CLI 模块改进 · 问题诊断篇  
> 日期: 2026-05-30  

---

## 1. 当前架构全景

```
ohbaby-agent/src/
├── bin.ts                   ← 进程入口：参数解析 → 模式分发 → TUI/非交互
├── cli/
│   ├── args.ts              ← ⚠️ 手写 CLI 参数解析器 (139 行)
│   ├── args.unit.test.ts
│   ├── exit-codes.ts        ← 进程退出码常量
│   ├── stdin.ts             ← 管道输入读取
│   ├── stdout-renderer.ts   ← 非交互模式事件→文本渲染
│   └── stdout-renderer.contract.test.ts
└── adapters/
    ├── ui-persistent.ts     ← 创建 Persistent UiBackendClient
    └── ui-inprocess.ts      ← 创建 InProcess UiBackendClient（20+ 方法）

ohbaby-cli (TUI 包)
├── src/tui/
│   ├── index.tsx            ← renderTerminalUi()
│   ├── app.tsx              ← ⚠️ 接收 TuiBackendClient 直接对象
│   └── store/snapshot.ts    ← ⚠️ TuiBackendClient 类型定义

通信路径：
  bin.ts
    → createPersistentUiBackendClient()  // 创建胖接口对象
    → import("ohbaby-cli")               // 动态加载 TUI
    → renderTerminalUi({ client })       // 把整个对象传给 TUI
  
  TUI 拿到的 client 有 20+ 个方法，可以调任何后端功能
  无序列化边界，TUI 和后端共享对象引用
```

---

## 2. 按 SWE 原则逐项诊断

### 问题 1：手写 CLI 参数解析器 —— KISS 过度、可扩展性差

**位置**：`packages/ohbaby-agent/src/cli/args.ts:26-105`

当前实现是一个 while-loop + if-else 链，处理 5 个参数（`--prompt`, `--mode`, `--permission`, `--help`, `--version`）。每个参数需要约 20 行代码。

**对比参考项目**：

| | ohbaby (手写) | kimi-code (Commander.js) | opencode (yargs) |
|---|---|---|---|
| 参数定义方式 | while-loop if-else | `.option()` 声明式 | `.option()` 声明式 |
| 代码行数 | 139 行 | ~6 行/参数 | ~4 行/参数 |
| `--help` 自动生成 | 手写 `renderHelp()` | 自动 | 自动 |
| 新增参数成本 | 加 20 行 if-else | 加 1 行 `.option()` | 加 1 行 `.option()` |
| 子命令支持 | 不支持 | 支持 `.command()` | 支持 `.command()` |

当后续需要加 `--format json`、`--session <id>`、`--verbose` 时，手写 parser 会继续膨胀。

**SWE 依据**：references/03 DRY——"不要重复造轮子"。CLI 参数解析是已被 Commander.js/yargs 充分解决的通用问题，手写实现是制造偶然复杂度。

---

### 问题 2：前端直接持有后端胖接口对象 —— 缺少序列化边界

**位置**：`packages/ohbaby-agent/src/bin.ts:70-89`

```typescript
const client = createPersistentUiBackendClient({ initialSnapshot });

if (/* non-interactive */) {
  client.subscribeEvents(renderer.handle);
  await client.submitPrompt(prompt);
} else {
  const { renderTerminalUi } = await import("ohbaby-cli");
  renderTerminalUi({ client });  // ← TUI 拿到整个后端对象
}
```

**问题**：
- `TuiBackendClient` 有 9 个方法（`getSnapshot`、`submitPrompt`、`executeCommand`、`listCommands`、`respondPermission`、`respondInteraction`、`abortRun`、`compactSession`、`subscribeEvents`），TUI 可以调任何后端功能。无权限控制、无调用限制
- TUI 和后端共享同一个事件总线（`subscribeEvents` 注册的回调在同一个事件循环中执行）
- 无法支持远程前端——因为通信依赖同进程对象引用

**对比参考项目**：

| | ohbaby | kimi-code | opencode |
|---|---|---|---|
| 前后端通信 | 直接对象引用 | 类型化 RPC 代理 (`createRPC`) | Worker RPC + HTTP |
| 序列化边界 | 无 | JSON 序列化/反序列化 | postMessage 序列化 |
| 接口契约 | `TuiBackendClient` (9 方法) | `CoreAPI` (10+ 方法) + `SDKAPI` (4 方法) | SDK 自动生成 HTTP client |
| 远程前端支持 | 不支持 | 架构上支持（RPC 可换传输层） | 原生支持（HTTP Server） |

**SWE 依据**：references/02 耦合——"模块之间通过窄而稳定的接口交互，内部实现可以独立变化"。直接对象引用是最高耦合形式。references/05 六边形架构——"核心通过端口（接口）与外界交互，外界通过适配器接到端口上"。当前 TUI 拿到的不是端口，而是整个实现。

---

### 问题 3：bin.ts 承担了太多职责

**位置**：`packages/ohbaby-agent/src/bin.ts:44-91`

当前 `runOhbabyCli()` 一个函数做了：
1. 参数解析（`parseCliArgs`）
2. 环境加载（`loadRuntimeEnvIntoProcessEnv`）
3. 后端客户端创建（`createPersistentUiBackendClient`）
4. 模式分发（prompt/interactive 分支）
5. 非交互渲染器创建（`createStdoutRenderer`）
6. 资源清理（`disposeNonInteractiveResources`）
7. TUI 动态加载（`import("ohbaby-cli")`）

**SWE 依据**：references/02 SRP——"一个模块应该只有一个变化的原因"。当需要加一种新模式（如 `serve`）、或换一种渲染方式、或换一种参数解析库时，都要改这个函数。

**opencode 的做法**：每个子命令是独立的 `CommandModule` 文件，新增模式不碰已有代码。

---

### 问题 4：依赖方向倒置 + CLI 入口错位 —— `ohbaby-cli` 不是一个真正的前端

**位置**：`packages/ohbaby-agent/package.json:56`（`ohbaby-cli` 作为依赖）、`packages/ohbaby-agent/src/bin.ts:88`（`await import("ohbaby-cli")`）、`packages/ohbaby-agent/src/cli/`（args/stdin/stdout-renderer/exit-codes）

当前包的职责切分是错的，表现为两层：

**4a. 依赖方向倒置（🔴）**：`ohbaby-agent`（后端核心）依赖 `ohbaby-cli`（前端），并通过 `bin.ts` 里的动态 `import("ohbaby-cli")` 反向"够到"前端。稳定的后端核心依赖易变的 UI——违反稳定依赖原则（references/02）与 DIP。为了绕开这个倒置，入口只能用动态 import 懒加载本不该依赖的前端，连带产生 `tsup.config.ts` external、运行期模块解析等一串脆弱点。

**4b. CLI 入口错位（🔴）**：真正的 CLI 入口——进程引导（`bin.ts`）、参数解析（`cli/args.ts`）、管道输入（`cli/stdin.ts`）、非交互渲染（`cli/stdout-renderer.ts`）——全部住在**后端包** `ohbaby-agent` 里；而名为 `cli` 的包里只有 TUI 渲染。结果是 `ohbaby-cli` 既不是完整前端（缺入口），后端又被迫兼任 "CLI composition layer"（见 `ohbaby-agent/package.json:4` 的 description）。

**对比参考项目**：opencode 的 CLI 入口包（`packages/opencode`）、kimi-code 的前端 app（`apps/kimi-code`，含 `main.ts` + `cli/` + `tui/`）都是**前端持有进程入口、依赖后端核心**。ohbaby 的方向恰好反了。

**SWE 依据**：references/02 稳定依赖原则 + 关注点分离——前端（渲染 + 输入 + 进程引导）与后端（执行 + 业务）应是两个包，依赖从前端指向后端。

**方案**：把 `bin.ts` + `cli/` 迁入 `ohbaby-cli`，翻转依赖方向（`ohbaby-cli → ohbaby-agent`），删除动态 import。`ohbaby-cli` 由此成为对齐 kimi-code 的真正前端包——名副其实，**无需改名**。详见 [05 CLI 模块迁移](./05-cli-module-migration.md)。

> 注：早期曾考虑把包重命名为 `ohbaby-terminal` 来消除"名不副实"。但根因是入口错位而非名字——迁移使 `ohbaby-cli` 真的成为 CLI 前端后，名字即准确，改名理由消失。命名体系（web/app/…）待 `ohbaby-web` 真正落地、家族 ≥2 成员时再统一决定（可逆决策，YAGNI）。

---

## 3. 问题优先级矩阵

| # | 问题 | 严重性 | 可优化性 | 影响包 | 修复代价 |
|---|------|--------|----------|--------|----------|
| 1 | 手写 CLI 解析器 | 🟡 设计级 | 🍒 低垂 | cli（迁移后） | ~3h |
| 2 | 无 RPC 边界（直接对象引用） | 🔴 架构级 | 🎯 战略 | sdk, agent, cli | ~6h |
| 3 | bin.ts 职责过多 | 🟡 设计级 | 🍒 低垂 | cli（迁移后） | ~2h |
| 4 | 依赖倒置 + CLI 入口错位 | 🔴 架构级 | 🎯 战略 | agent, cli | ~5h |

**Problem 2 与 Problem 4 是同一条接缝的两面**：Problem 4 把前端/后端拆成正确的两个包并翻转依赖，Problem 2 在这条接缝上换成 RPC 契约。建议先建契约与后端工厂（Problem 2 的 Phase 1/2），再把入口迁过接缝（Problem 4），最后 yargs（Problem 1）与 TUI 改用 CoreAPI（Problem 2 收尾）。Problem 1/3 在迁移后自然落在 `ohbaby-cli` 内。统一路线图见 [05 CLI 模块迁移](./05-cli-module-migration.md)。

---

## 4. 逻辑保留、但位置变化的部分

以下文件的**逻辑保留不删**，但随迁移（见 [05](./05-cli-module-migration.md)）**搬到 `ohbaby-cli`**（它们都是前端 IO 关注点）：

1. **`cli/stdin.ts`**：管道输入读取，简单纯粹、不依赖框架。逻辑不变，迁入 `ohbaby-cli`。
2. **`cli/exit-codes.ts`**：进程退出码常量，干净无依赖。逻辑不变，迁入 `ohbaby-cli`。
3. **`cli/stdout-renderer.ts`**：非交互模式事件→文本渲染，职责单一。逻辑不变，迁入 `ohbaby-cli`。

以下文件**留在后端 `ohbaby-agent`**：

4. **`adapters/ui-inprocess.ts` / `ui-persistent.ts`**：内部重构为返回 CoreAPI 实现，但不删除、不迁移——它们是后端核心（接缝的后端侧）。
