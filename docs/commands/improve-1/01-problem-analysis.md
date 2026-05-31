# 01 · 代码现状与问题分析

> Commands 模块改进 · 问题诊断篇  
> 日期: 2026-05-30  

---

## 1. 当前架构全景

```
ohbaby-sdk (共享契约层)
├── command/
│   ├── types.ts          ← UiCommandSpec 等 14 个类型 (108 行)
│   ├── parse.ts           ← parseSlashInput  ⚠️ 无生产消费者
│   └── resolve.ts         ← resolveCommand   ⚠️ 无生产消费者
│                           filterCommandCatalog ⚠️ 无生产消费者
│
ohbaby-agent (后端)
├── commands/
│   ├── catalog.ts         ← BUILTIN_COMMANDS (14 条命令, 208 行)
│   ├── builtin.ts         ← createBuiltinHandlers (15 个 handler, 433 行)
│   ├── service.ts         ← createCommandService (编排层, 190 行)
│   ├── types.ts           ← CommandHandler, CommandRunContext 等
│   ├── events.ts          ← CommandsEvent (总线事件, Zod schema)
│   ├── run-context.ts     ← 桥接 handler → 总线 (68 行)
│   ├── catalog.unit.test.ts
│   └── service.unit.test.ts
└── cli/
    ├── args.ts            ← 手写 CLI 参数解析 (139 行)
    └── stdout-renderer.ts ← 非交互模式渲染 (70 行)
│
ohbaby-cli (TUI 前端)
├── tui/command/
│   ├── runtime.ts         ← parseSlashInput   ⚠️ 重复实现 (373 行)
│   │                       resolveCommand    ⚠️ 重复实现
│   │                       filterCommandCatalog ⚠️ 重复实现
│   │                       applySlashCompletion ⚠️ 重复实现
│   ├── completions.ts     ← Tab 补全包装 (31 行)
│   ├── hints.ts           ← 提示格式化 (22 行)
│   └── runtime.unit.test.ts
├── tui/store/
│   ├── snapshot.ts        ← TuiCommandSpec    ⚠️ 影子类型 (149 行)
│   │                       TuiCommandCatalog  ⚠️ 影子类型
│   │                       TuiCommandInvocation
│   ├── events.ts          ← 事件 reducer (889 行)
│   ├── events.unit.test.ts
│   └── selectors.ts
└── tui/components/prompt/
    └── index.tsx          ← 消费命令解析结果 (234 行)
```

⚠️ = 问题点

---

## 2. 按 SWE 原则逐项诊断

### 问题 1：类型重复 —— DRY 违反

**位置**：
- `packages/ohbaby-sdk/src/command/types.ts:14` — `UiCommandSpec` (11 字段，7 必填 + 4 可选)
- `packages/ohbaby-cli/src/tui/store/snapshot.ts:28` — `TuiCommandSpec` (10 字段，3 必填 + 7 可选)

**字段对比**：

| 字段 | UiCommandSpec (SDK) | TuiCommandSpec (CLI) |
|------|---------------------|----------------------|
| `id` | `string` (必填) | `string` (必填) |
| `path` | `readonly string[]` (必填) | `readonly string[]` (必填) |
| `description` | `string` (必填) | `string` (必填) |
| `argumentMode` | `UiCommandArgumentMode` (必填) | `UiCommandArgumentMode` (可选) |
| `source` | `UiCommandSource` (必填) | `UiCommandSource` (可选) |
| `surfaces` | `readonly UiCommandSurface[]` (必填) | `readonly string[]` (可选) |
| `category` | `string` (必填) | `string` (可选) |
| `parentBehavior` | `UiCommandParentBehavior` (可选) | `UiCommandParentBehavior` (可选) |
| `acceptsArguments` | `boolean` (可选) | `boolean` (可选) |
| `title` | **缺失** | `string` (可选) |
| `aliases` | `readonly (readonly string[])[]` (可选) | `readonly (readonly string[])[]` (可选) |
| `argsHint` | `string` (可选) | **缺失** |

**核心问题**：两者表达的是**同一个概念**（"一条可执行的命令"），但字段不完全相同。CLI 的 `TuiCommandSpec` 是对 `UiCommandSpec` 的**不完整镜像**。

**数据流中的类型转换**：

```
后端 catalog.ts
  BUILTIN_COMMANDS: UiCommandSpec[]
      │
      ▼ listCommands({ surface: "tui" })
CLI app.tsx
  normalizeCommandCatalog(): UiCommandSpec → TuiCommandSpec
      │
      ▼ setCatalog()
CLI store.events.ts
  TuiCommandCatalog
      │
      ▼ 用户输入 /model list
CLI command/runtime.ts
  resolveCommand() → ResolveCommandResult
      │
      ▼ 构建 invocation
CLI prompt/index.tsx
  client.executeCommand(invocation: UiCommandInvocation)
```

每一步类型转换都是**偶然复杂度**——它不解决任何业务问题，只是在两个"几乎相同"的类型之间搬运数据。

**SWE 依据**：references/03 DRY——"系统中的每一项知识都应当有单一、明确、权威的表示"。`TuiCommandSpec` 是同一份"命令"知识的第二份表示。改动命令结构时，必须同时修改两个类型定义。

---

### 问题 2：命令解析逻辑重复 —— DRY 违反 + 幽灵代码

**位置**：

| 函数 | SDK 位置 | CLI 位置 | 生产消费者 |
|------|----------|----------|------------|
| `parseSlashInput` | `sdk/command/parse.ts:87` | `cli/tui/command/runtime.ts:41` | **仅 CLI** |
| `resolveCommand` | `sdk/command/resolve.ts:79` | `cli/tui/command/runtime.ts:79` | **仅 CLI** |
| `filterCommandCatalog` | `sdk/command/resolve.ts:134` | `cli/tui/command/runtime.ts:120` | **仅 CLI** |
| `applySlashCompletion` | (SDK 无此函数) | `cli/tui/command/runtime.ts:147` | **仅 CLI** |

**SDK 的 parse/resolve 是幽灵代码**——它们存在、有单元测试、但零生产消费者。CLI 自己重新实现了一套。

**两套实现的差异**：

| 维度 | SDK parse.ts | CLI runtime.ts |
|------|-------------|----------------|
| 返回类型 | `UiParsedSlashInput \| null` | `ParsedSlashInput` (总是返回，靠 `kind` 区分) |
| tokenizer | while-loop (~56 行) | for-loop (~53 行) |
| 文件总长度 | 109 行 | 373 行（含大量辅助函数） |
| path 提取 | 固定取 `segments[0]` | `inferDisplayPathLength()` 动态推断 (1 或 2 段) |
| 引号处理 | 支持 `"` 和 `'` + 转义 `\` | 支持 `"` 和 `'` |
| resolve 逻辑 | 基于 `parentBehavior` 跳过 | 基于 `acceptsArguments` 决定是否接受额外 token |
| 补全排序 | 按 path 长度排序 | 自定义 `candidateRank()` 多级排序 |

**为什么这是问题**：

1. **新语法需要改两处**。如果要支持 `--flag` 参数解析，必须在 SDK 和 CLI 两套 tokenizer 中各实现一遍
2. **两套逻辑已经分叉了**——SDK 固定取 1 个 path segment，CLI 可以取 2 个（因为 `/model list` 需要 2 段）。resolver 也不同：SDK 用 `parentBehavior` 跳过匹配，CLI 用 `acceptsArguments` 判断是否接受额外 token。这意味着**同一输入在两套 resolver 下可能产生不同结果**，是一个隐蔽的 bug 源
3. **认知负担**——新开发者看到两个同名函数必须搞清楚"哪个是活的？为什么有两个？"

**SWE 依据**：references/00 哲学——幽灵代码是典型的偶然复杂度。"代码主要是写给人读的"，看到两份同名函数，读者必须停下来搞清差异。

---

### 问题 3：`listCommands` 返回类型不一致 —— 最小惊讶原则违反

**位置**：`packages/ohbaby-cli/src/tui/store/snapshot.ts:114-118`

```typescript
readonly listCommands: (query: {
  readonly surface: UiCommandSurface;
}) => Promise<
  UiCommandCatalog | TuiCommandCatalog | readonly TuiCommandSpec[]
>;
```

返回类型是**三个的联合**。调用方在 `app.tsx` 中需要做防御性处理：

```typescript
// app.tsx 中实际的处理逻辑（简化）
const raw = await client.listCommands({ surface: "tui" });
if (Array.isArray(raw)) {
  // raw 是 TuiCommandSpec[]
} else {
  // raw 是 UiCommandCatalog | TuiCommandCatalog
}
```

**SWE 依据**：references/03 最小惊讶原则——"接口的行为应当符合使用者最自然的预期"。一个叫 `listCommands` 的方法返回三种可能的类型，调用方被迫做类型守卫。实际上所有路径最终都归一化到同一个结构。

---

### 问题 4：`title` 字段缺失 —— 信息隐藏位置错误

**位置**：`TuiCommandSpec` 有 `title?: string`，`UiCommandSpec` 没有。

CLI 的 `TuiCommandSpec` 比 SDK 的 `UiCommandSpec` 多了一个 `title?: string` 字段。这是用来在 TUI 下拉菜单中显示人类可读标题的（如 `/session.compact` 显示为 "Compact Session"）。

**为什么这是问题**：`title` 是**命令的固有属性**——`/session.compact` 的标题在任何前端（TUI、Web、CLI）都应该是 "Compact Session"。它不是 CLI 特有的渲染需求。把 `title` 放在 CLI 的类型中意味着：
- 后端不知道这个属性
- 其他前端（未来 Web/App）需要自己再定义一遍
- 命令定义分散在两个包之间

**SWE 依据**：references/03 DRY——"系统中的每一项知识都应当有单一、明确、权威的表示"。`title` 是命令定义的一部分（每个命令都有一个人读的标题），这项知识应该放在唯一的权威来源（SDK 的 `UiCommandSpec`）中，而不是让每个前端各自定义。

---

## 3. 问题优先级矩阵

| # | 问题 | 严重性 | 可优化性 | 影响包 | 修复代价 |
|---|------|--------|----------|--------|----------|
| 1 | 类型重复 (UiCommandSpec vs TuiCommandSpec) | 🟡 设计级 | 🍒 低垂果实 | sdk, cli, agent | ~2h |
| 2 | 解析逻辑重复 (parse/resolve 两套) | 🔴 架构级 | 🍒 低垂果实 | sdk, cli | ~3h |
| 3 | listCommands 返回类型不一致 | 🟡 设计级 | 🍒 低垂果实 | cli | ~30min |
| 4 | title 字段缺失 | 🟢 代码级 | 🍒 低垂果实 | sdk, agent | ~15min |

全部四项都是**低垂果实**——代价低、收益高、无外部依赖、可以独立验证。

---

## 4. 不改动的部分（有意保留）

以下设计决策是**有意识的权衡**，本次不修改：

1. **catalog → builtin → service 三层架构**：职责分离清晰（定义/实现/编排），每层可独立测试。kimi-code 虽然更扁平（一个数组 + 一个 switch），但 ohbaby 的三层架构在功能增长时有更好的扩展性。保留。

2. **`CommandServiceOptions` 的 10+ 注入点**：当前看起来"多"，但每个注入点都有实际消费者。后续如果要进一步简化，可以按"核心"和"扩展"分组，但这属于另一个改进主题。

3. **手写 CLI 参数解析器 (`cli/args.ts`)**：这属于 CLI 模块改进的范畴，不在 commands 改进范围内。
