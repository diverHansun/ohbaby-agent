# 03 · 参考设计模式

> Commands 模块改进 · 借鉴篇  
> 来源: opencode (`D:\Projects\Code-cli\opencode`), kimi-code (`D:\Projects\Code-cli\kimi-code`)  
> 日期: 2026-05-30  

---

## 1. kimi-code：单数组命令注册的简洁性

### 1.1 核心设计

**文件**：`apps/kimi-code/src/tui/commands/registry.ts`

```typescript
const BUILTIN_SLASH_COMMANDS = [
  {
    name: "yolo",
    aliases: ["yes"],
    description: "Toggle auto-approve mode",
    priority: 100,
    availability: "always",
  },
  {
    name: "model",
    aliases: [],
    description: "Switch LLM model",
    priority: 100,
    availability: "always",
  },
  {
    name: "sessions",
    aliases: ["resume"],
    description: "Browse and resume sessions",
    priority: 80,
    availability: "always",
  },
  // ... 共 23 条命令
] as const satisfies readonly KimiSlashCommand[];
```

注意：使用 `as const satisfies` 确保类型安全的同时保留字面量类型推断。

### 1.2 设计要点

**一条命令 = 一个对象**。所有命令在同一个数组中声明，新增命令只需加一个对象，无需在多个文件间跳转。

**priority 字段控制排序**：
- 高优先级命令（100：yolo, model）排在下拉菜单前面
- 低优先级命令（20：exit）排在末尾
- 排序由数据驱动，不是硬编码的 switch 顺序

**availability 字段控制可用性**：
- `"always"`：随时可用
- `"idle-only"`：仅空闲时可用（流式输出时自动屏蔽）
- 函数形式：`(args) => SlashCommandAvailability` 做动态判断

**aliases 平铺在命令定义上**：
```typescript
{ name: "exit", aliases: ["quit", "q"], ... }
// 用户输入 /quit → 等同于 /exit
// 用户输入 /q    → 等同于 /exit
```
别名和主名在同一处维护，不会出现"别名在别处定义，改了主名忘了改别名"的 bug。

### 1.3 解析与分发

**`parse.ts`**（12 行）：只做词法解析——把 `/model kimi-thinking` 拆成 `{ name: "model", args: "kimi-thinking" }`。

**`resolve.ts`**（115 行）：做语义解析——查注册表，返回 discriminated union：
```typescript
type SlashCommandIntent =
  | { kind: "not-command" }                           // 不以 / 开头
  | { kind: "builtin"; command: KimiSlashCommand; name: string; args: string }  // 匹配内置命令
  | { kind: "skill"; commandName: string; skillName: string; args: string; input: string } // 匹配 skill
  | { kind: "message"; input: string }                // 以 / 开头但不匹配 → 当普通消息
  | { kind: "blocked"; reason: string }               // 匹配但当前被阻塞
  | { kind: "invalid" }                               // 不匹配任何命令
```

**分发**（`kimi-tui.ts:1367`）：一个平面的 switch/case：
```typescript
switch (name) {
  case "yolo": return this.handleYolo();
  case "model": return this.handleModelCommand(args);
  case "sessions": return this.handleSessionsCommand();
  // ... 22 个 case
}
```

### 1.4 对 ohbaby 的启示

1. **`priority` 和 `availability` 是命令的固有属性**，可以考虑在未来加入 `UiCommandSpec`
2. **aliases 作为命令定义的一部分**，ohbaby 已经做到了（`catalog.ts` 中的 `aliases` 字段）
3. **命令注册表的单点真理原则**：ohbaby 的 `BUILTIN_COMMANDS` 已经是单数组，这个方向正确

---

## 2. opencode：Yargs 声明式 CLI + 命令分离

### 2.1 双层命令体系

opencode 有**两套独立的命令系统**：

**进程级命令**（`packages/opencode/src/index.ts`）：
```typescript
yargs(hideBin(process.argv))
  .command(AcpCommand)       // Agent Client Protocol
  .command(McpCommand)       // MCP tools
  .command(TuiThreadCommand) // $0 [project] — 主 TUI 入口
  .command(RunCommand)       // run [message..] — headless 模式
  .command(GenerateCommand)  // generate
  // ... 15+ 子命令
  .parse();
```

每个子命令是独立的 `CommandModule` 对象文件，包含 `command`、`describe`、`builder`、`handler`。

**TUI 内命令**（`app.tsx:403-738`）：
```typescript
command.register(() => [
  {
    title: "New Session",
    value: "session.new",
    slash: { name: "new", aliases: [] },
    category: "Session",
    onSelect: () => { /* ... */ },
  },
  {
    title: "Switch Model",
    value: "model.switch",
    slash: { name: "models", aliases: [] },
    category: "Agent",
    onSelect: () => { /* ... */ },
  },
  // ... ~35 条 TUI 命令
]);
```

注意：`command.register` 接受一个**返回数组的函数**，不是回调式 `cb()` 逐个注册。每个命令对象可以有 `keybind`（快捷键）、`hidden`（隐藏）、`suggested`（推荐标记）、`enabled`（动态启用/禁用）等额外字段。

### 2.2 设计要点

**进程级 vs TUI 级的关注点分离**：
- 进程级命令处理"怎么启动"（run、serve、debug、export）
- TUI 级命令处理"启动后干什么"（切换 session、换模型、改权限）

ohbaby 的 `bin.ts` 处理进程级，`BUILTIN_COMMANDS` 处理 TUI 级，分层一致。

**每个子命令是独立文件**——`RunCommand` 一个文件、`GenerateCommand` 一个文件。新增子命令不碰已有代码。ohbaby 的 `BUILTIN_COMMANDS` 数组 + `builtin.ts` handler map 也是类似的效果。

**TUI 命令的 `onSelect` 回调是行为绑定**——命令定义和命令行为在同一个位置，不需要跨文件追踪。

### 2.3 对 ohbaby 的启示

1. **进程级 CLI 参数应该用成熟库**（yargs/Commander.js）而非手写 parser。ohbaby 的 `cli/args.ts` 可以借鉴
2. **TUI 命令注册应该声明式**——opencode 的 `command.register(cb)` 和 ohbaby 的 `BUILTIN_COMMANDS` 都是声明式，方向正确
3. **命令的 handler 和定义可以分离（ohbaby 做法）也可以合并（opencode 做法）**——两者各有利弊，ohbaby 的选择（分离）适合当前阶段

---

## 3. 两个项目的核心共识：类型契约在 SDK

| 维度 | opencode | kimi-code | ohbaby（改后目标） |
|------|----------|-----------|---------------------|
| 命令类型定义位置 | `@opencode-ai/sdk` (OpenAPI 自动生成) | `agent-core/rpc/core-api.ts` | `ohbaby-sdk/command/types.ts` |
| 解析函数位置 | TUI 层 | TUI 层 | `ohbaby-sdk/command/` ← CLI 通过 import 使用 |
| CLI 是否直接引用 SDK 类型 | 是 | 是 | **是（改后）** |
| 后端是否重复定义命令类型 | 否 | 否 | **否（改后）** |
| 前后端通信方式 | Worker RPC + Hono HTTP | 同进程 typed RPC proxy | 同进程 typed RPC proxy（待 CLI 改进实施） |

### 3.1 三角分工模型

三个项目（无论前端技术栈是 Ink/SolidJS/pi-tui）的共同模式：

```
┌──────────────────────────────┐
│  SDK (共享契约)                │
│  · 类型定义 (UiCommandSpec)    │
│  · 解析函数 (parse/resolve)    │
│  · 通信接口 (CoreAPI/SDKAPI)  │
└──────┬───────────┬───────────┘
       │           │
       ▼           ▼
┌──────────┐ ┌──────────┐
│ 后端      │ │ 前端      │
│ · 执行    │ │ · 渲染    │
│ · handler │ │ · 补全    │
│ · 业务    │ │ · 展示    │
└──────────┘ └──────────┘
```

- **SDK**：只定义形状和转换规则，不执行业务逻辑。是"诚实中间人"
- **后端**：接收已解析的命令调用，执行 handler，发布事件
- **前端**：捕获用户输入，调用 SDK 解析，发送给后端执行，渲染结果

> **"前端"在 ohbaby 中即 `ohbaby-cli` 包。** 它对齐 kimi-code 的 `apps/kimi-code`：除命令解析/补全/渲染外，迁移后还持有进程入口与非交互渲染（见 [cli/improve-1/05 CLI 模块迁移](../../cli/improve-1/05-cli-module-migration.md)）。命令的**执行**始终留在后端 `ohbaby-agent`；前端只依赖 SDK 的命令契约（类型 + `parseSlashInput`/`resolveCommand`），不重复定义。

### 3.2 关键原则

1. **"一条命令"的知识在代码中只出现一次**。定义在 SDK 或后端的 registry 中，前端不重复定义
2. **TUI 是"瘦客户端"**——它没有自己的类型体系或解析逻辑，只是用户按键到后端调用的翻译层
3. **解析逻辑和类型定义共处一地**——要么都在 SDK，要么都在 TUI（如果 TUI 是唯一消费者）。不应该各有一份
