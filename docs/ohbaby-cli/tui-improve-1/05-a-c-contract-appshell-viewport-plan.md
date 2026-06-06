# 05 — A+C 契约、AppShell 与 Viewport 实施方案

日期: 2026-06-06
状态: 待维护者审核

本文档是 `tui-improve-1` 的最终讨论收口文档。它覆盖并修订早期文档中关于
“SDK 零改动”“token 延后”“viewport 延后”的旧口径。

## 1. 总体方案

采用 **A+C**:

- **Contract-first**: 先补 SDK/agent 契约，再让 TUI 消费字段。TUI 不自行估算
  context window token。
- **AppShell 增量重构**: 以 opencode 式页面壳为目标，统一内容宽度、prompt dock、
  status bar、message flow、status panel。
- **部分 viewport/scroll shell 重写**: 引入 shell-level viewport metrics 和
  scrollback renderer，但不在本批次实现完整虚拟滚动引擎。

本批次目标不是只换皮，也不是完整重写 TUI runtime，而是把 UI 结构升级到可持续演进
的 shell 架构。

### A+C 护栏

A+C 不按“大爆炸”执行，而拆成两条可独立交付的链：

- **契约链**: SDK → agent → TUI data layer。该链负责 `UiContextWindowUsage`、
  `CoreAPI.getContextWindowUsage`、`context.window.updated` 和 message lifecycle。
- **前端链**: AppShell → MessageFlow → PromptDock → logo/tool/reasoning/status panel。
  该链不依赖 token 估算实现，可以在 context window 数据为空时先完成 UI 结构。

实施时必须在 agent context window service 完成后设置门禁：用真实 session 验证
`ContextUsage -> UiContextWindowUsage` 的映射口径，尤其确认分母是完整模型 context
window，而不是 input budget。该门禁通过后再把 usage 接入 status bar 和 `/status`。

## 2. 本批次范围

### 做

1. SDK 增加 context window usage DTO、snapshot 字段、事件类型、query API。
2. SDK 增加 message lifecycle 可选字段，支持 TUI 精确判断单条 assistant message
   是否完成。
3. agent 增加 session 级 context window usage 服务，内存缓存，不持久化。
4. agent 在 run context prepared 和 compact 后更新当前 session 的 context window
   usage。
5. CLI TUI store 增加 session 级 context window usage 缓存与 selector。
6. CLI TUI 新增 `AppShell`、viewport metrics、`MessageFlow`、`PromptDock`、
   `StatusPanel`。
7. 空会话显示 `OHBABY` ASCII/ANSI logo，不显示 tip，不显示模型。
8. prompt 运行时显示背景块；历史用户消息只显示左竖线。
9. status bar 右侧显示当前 session 的 context window usage，例如
   `38.4K / 1M (4%)`。
10. `/status` 输出轻边框多行 panel，包含 runtime、session、model、tools、
    context window 等信息。
11. tool call 采用 opencode/kimi-code 风格单行显示：运行中左侧 spinner，完成后
    只留工具名与摘要，不使用 `✓` 或 `✗`。
12. reasoning 默认灰色可见；对应 assistant message 完成后自动折叠为一行
    `Thought` 摘要。

### 不做

- 费用/cost 展示。
- 草稿输入 token 展示。
- TUI 本地 token 估算 API/export。
- 完整虚拟列表、应用内滚动条、历史搜索、鼠标滚动、overlay stack。
- 工具 body 展开、diff 渲染、`Ctrl+O` 展开。
- 持久化 usage 缓存。
- header、prompt、status bar 中常驻显示模型。
- footer tip 行。
- severity 分级、复杂 progress bar 或复杂 CSS/样式分支。

### 技术债记录

- `cli-highlight` v1 可接受，但维护活跃度不高。必须封装在
  `packages/ohbaby-cli/src/tui/render/highlight.ts`，后续若替换为更活跃的语法高亮
  方案，只改该文件。
- 工具自动分组、frecency 排序、自定义主题文件不进 v1。
- 新增组件禁止写硬编码颜色，必须走 theme token。

## 3. SDK 契约

新增文件建议:

```text
packages/ohbaby-sdk/src/context-window.ts
```

核心 DTO:

```ts
export interface UiContextWindowUsage {
  readonly sessionId: string;
  readonly modelId: string;
  readonly currentTokens: number;
  readonly contextWindowTokens: number;
  readonly contextWindowRatio: number;
  readonly estimatedAt: string;
}
```

命名使用 `contextWindow`，避免与 broader context 或
`packages/ohbaby-agent/src/snapshot/` 模块混淆。旧 `context` 字段可保留一版兼容，
但新代码优先读写 `contextWindow`。

legacy `context` alias 的移除条件：

- `contextWindow` 在一个 minor 版本内稳定可用；
- TUI、`/status`、测试与真实 smoke 全部只读取 `contextWindow`；
- 没有外部消费者继续依赖旧字段。

满足条件后，下一个 minor 删除旧 `context` alias。

`UiSnapshot` 增加:

```ts
contextWindowUsages?: readonly UiContextWindowUsage[];
```

`CoreAPI` 增加 query:

```ts
getContextWindowUsage(input: {
  sessionId: string;
}): Promise<UiContextWindowUsage | null>;
```

该 API 只返回数据，不 publish 事件。TUI 在启动或 session 切换时调用它，成功后在
本地 dispatch `context.window.updated`。

新增事件:

```ts
{
  type: "context.window.updated";
  usage: UiContextWindowUsage;
}
```

`UiMessage` 增加可选 lifecycle 字段:

```ts
interface UiMessage {
  readonly id: string;
  readonly role: UiMessageRole;
  readonly parts: readonly UiMessagePart[];
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly completedAt?: string;
  readonly status?: "streaming" | "completed" | "error";
  readonly finishReason?: string;
}
```

reasoning 折叠只能基于 message 自己的 lifecycle 字段，不能基于全局 runtime
`running/idle`。

## 4. agent 侧设计

新增服务建议:

```text
packages/ohbaby-agent/src/core/context/context-window-usage.ts
```

并从 agent 的 public export 暴露必要类型/函数。

职责:

1. 从 `ContextUsage` 或 context manager 当前估算结果生成 `UiContextWindowUsage`。
2. 使用模型 profile 的完整 context window 作为分母。
3. 计算 `contextWindowRatio = currentTokens / contextWindowTokens`。
4. 不复用 `ContextUsage.usageRatio` 作为 UI 百分比，因为它可能是 input budget 口径。
5. 按 `sessionId` 维护进程内 memory cache。
6. 返回 `null` 表示当前 session 不可用或模型窗口未知。

运行时更新:

- `run.context.prepared` 到达时，映射 usage 并 publish
  `context.window.updated`。
- compact 后如 context 重新估算，也更新同一 session 的缓存。
- refresh 失败不清空旧值；由调用方发 warning notice。

查询更新:

- `getContextWindowUsage({ sessionId })` 只接受 `sessionId`。
- 后端自行解析 session 对应 project/root/model。
- query 不 publish，只返回。

`/status` 数据输出增加:

```ts
{
  subject: "status",
  status: ...,
  session: ...,
  model: ...,
  tools: ...,
  contextWindow: UiContextWindowUsage | null,
  context?: ... // legacy alias, temporary
}
```

无数据时 `/status` panel 显示 `Context unavailable`。

## 5. CLI TUI store 与数据流

`TuiStoreState` 增加 session 级 usage 缓存。内部形态可以是 map，也可以在 snapshot
归一化为数组；selector 对外隐藏实现。

必需 selector:

```ts
selectActiveContextWindowUsage(state): UiContextWindowUsage | null
```

显示策略:

- 只显示 `usage.sessionId === activeSessionId` 的数据。
- session 切换后，如果目标 session 有自己的缓存，先显示它自己的旧值。
- 如果目标 session 没有缓存，右侧留空。
- 不能显示其他 session 的旧值。
- refresh 失败时，当前 session 有旧缓存则保留旧缓存并发 warning notice；没有旧缓存则留空并发 warning notice。

格式化放在纯函数:

```text
packages/ohbaby-cli/src/tui/render/usage.ts
```

格式:

```text
38.4K / 1M (4%)
```

规则:

- `K/M` 使用大写。
- percent 使用整数。
- `0 < ratio < 1%` 显示 `<1%`。
- `contextWindowTokens <= 0` 或缺失时不输出字符串。

## 6. AppShell 与 viewport/scroll shell

新增建议目录:

```text
packages/ohbaby-cli/src/tui/layout/
  metrics.ts
  app-shell.tsx
  content-column.tsx
  message-flow.tsx
```

`metrics.ts` 输出:

```ts
interface TuiLayoutMetrics {
  readonly columns: number;
  readonly rows: number;
  readonly contentWidth: number;
  readonly horizontalPadding: number;
  readonly isCompact: boolean;
}
```

建议规则:

- `isCompact = columns < 80`。
- compact 下 `horizontalPadding = 2`。
- 非 compact 下 `horizontalPadding = 4`。
- `contentWidth = min(132, max(24, columns - horizontalPadding * 2))`。
- 所有 message、prompt、status、panel、completion、logo 都使用同一
  `contentWidth`。

本批次仍保留 Ink `<Static>` 与终端原生 scrollback，但通过 `MessageFlow` 统一
历史消息、notice 与 command output 的宽度和缩进。这里的 scrollback 是终端能力，
不是自定义滚动组件；暂不实现自定义 scroll position、滚动条或虚拟列表。

`AppShell` 使用 `useStdout().stdout.columns` 读取终端宽度，计算 metrics 后通过
layout context 下发。各渲染组件只消费 `contentWidth` 或扣除 gutter/indent 后的
`partWidth`，不在组件内部各自重新读终端宽度。

## 7. TUI 视觉结构

### Empty State

- 显示 `OHBABY` ASCII/ANSI logo。
- 不显示 tip 行。
- 不显示模型。
- logo 通过 `renderOhbabyLogo()` 生成 ANSI 行。运行时默认使用静态 ANSI 行，
  不引入 `figlet` 运行时依赖。如需要 `figlet`，只作为开发期或生成期工具，用来更新
  静态 logo 文本。

### PromptDock

当前输入是底部突出块:

```text
> ask anything...

auto · default · session_abc                    38.4K / 1M (4%)
```

规则:

- prompt 符号只使用 `>`。
- mode 只显示 `auto` 或 `plan`，不显示 `ask/build`。
- status 行不显示模型。
- status 右侧无数据时留空。
- slash completion 出现在 prompt dock 下方，使用同一 `contentWidth`。

### Message Flow

- 历史用户消息: 只有左竖线，无背景块，无 `you` 字样。
- assistant 消息: 直接 markdown，无 `ohbaby` 字样。
- 当前输入比历史消息更突出；历史更安静。
- reasoning:
  - message streaming 时默认灰色展开。
  - message completed/error 后折叠为一行 `Thought`。
  - 旧数据没有 lifecycle 字段时，按 completed 处理，默认折叠。

### Tool Line

运行中:

```text
⠙ Bash    pnpm test
```

完成:

```text
  Bash    pnpm test
```

失败:

```text
  Edit    src/foo.ts  permission denied
```

规则:

- 不使用 `✓`、`✗`。
- running spinner 只在运行中显示，但工具行始终保留同宽度 leading slot，避免
  running -> completed 时文字左移。
- 完成后不保留图标，只留工具名与摘要。
- tool result 不单独输出一行；成功结果默认不显示 body。
- 失败 result 合并到工具行的短错误摘要。
- 若终端不支持 braille spinner，可回退到 ASCII spinner；用户 gutter 可回退到
  `|`。prompt 本身固定使用 ASCII `>`。

### StatusPanel

`/status` 渲染为轻边框多行 panel，作为 transcript 中的一条 command output。

第一版字段:

```text
Status

Runtime        idle
Session        abc123
Permission     auto / default
Model          deepseek-v4-pro
Context        38.4K / 1M (4%)
Tools          3 MCP connected
Project        D:\Projects\Code-cli\ohbaby-agent
```

无 context window 时:

```text
Context        Context unavailable
```

不做 severity、不做 progress bar、不做费用。

## 8. 实施顺序

后续开发使用临时分支，建议名:

```text
codex/tui-improve-1-a-c
```

阶段:

1. **Baseline**: 建分支，跑现有单测/契约测试/集成测试，记录基线失败。
2. **SDK contract**: 增加 `UiContextWindowUsage`、message lifecycle、事件类型、
   `CoreAPI.getContextWindowUsage`。
3. **agent context window**: 增加 context window usage service、memory cache、
   runtime event mapping、`/status` data 字段。
4. **Real-session mapping gate**: 使用真实 session 验证
   `ContextUsage -> UiContextWindowUsage`，确认完整 context window 口径正确。
5. **TUI data layer**: store event reducer、snapshot normalize、selector、
   `render/usage.ts`。
6. **AppShell**: layout metrics、app shell、content column、message flow、prompt dock 接入。
7. **Message render**: user gutter、assistant markdown、tool line、reasoning fold。
8. **StatusPanel**: `/status` command output renderer 与轻边框样式。
9. **Logo**: OHBABY ANSI logo renderer 与 empty state。
10. **Verification**: unit、contract、integration、真实 API e2e、子代理审查。

每个阶段都应保持可运行，不把所有风险堆到最后。

## 9. 测试与验收

### Unit

- `context-window-usage` mapping:
  - full context window ratio 正确。
  - 不使用 input budget ratio。
  - unknown model/window 返回 null。
- `render/usage.ts`:
  - `38.4K / 1M (4%)`。
  - `<1%`。
  - 缺失/非法窗口留空。
- tool line renderer:
  - running 有 spinner。
  - completed 无图标，但保留 leading slot 宽度。
  - failed 无 `✗`，有短错误。
- ANSI + Ink integration:
  - `render/` 产出的 ANSI 行在 Ink `Text` 中不会被二次折行破坏 ANSI 序列。
  - `visibleWidth(line) <= partWidth` 是组件契约。
- reasoning selector/renderer:
  - streaming 展开。
  - completed 折叠。
  - legacy message 折叠。

### Contract

- status bar 只显示 active session usage。
- session 切换不会显示其他 session 的旧值。
- `/status` panel 使用 `contextWindow` 字段。
- 无 context window 时显示 `Context unavailable`。
- prompt mode 只出现 `auto/plan`，不出现 `ask/build`。
- history 不出现 `you/ohbaby` 角色头。

### Integration

- runtime `run.context.prepared` 能产生 `context.window.updated`。
- `getContextWindowUsage({ sessionId })` 成功返回当前 session usage。
- 真实 session 映射验证通过：`ContextUsage.currentTokens` 能映射到
  `UiContextWindowUsage.currentTokens`，分母来自模型完整 context window。
- query 失败时 TUI 保留当前 session 旧缓存并发 warning notice。
- `/status` command data 包含 `contextWindow`，旧 `context` alias 保持兼容。

### Real API E2E

使用根目录 `.env` 中真实 API key，沿用项目现有真实 smoke 机制。

必须覆盖:

- 启动 TUI，空会话 logo 与 prompt dock 正常。
- 发送普通消息，运行中 reasoning 展开，完成后折叠为 `Thought`。
- 触发工具调用，运行中有 spinner，完成后只留工具名摘要。
- status bar 出现当前 session context window usage。
- `/status` 出现轻边框 panel 与 context window 行。

### 子代理验收

实施完成、测试通过后，使用子代理做独立审查:

- 对照本文档逐项验收。
- 运行 unit/contract/integration/e2e。
- 检查 SDK/agent/CLI 字段语义是否一致。
- 检查 TUI 是否存在本地 token 估算、费用展示、`✓/✗`、`ask/build`、
  `you/ohbaby` 等违背决策的残留。

## 10. Definition of Done

- 本文档第 2 节“做”全部完成。
- 新旧文档不再保留相反口径。
- 单元测试、契约测试、集成测试通过。
- 真实 API e2e 通过，或失败原因已明确并经维护者接受。
- 子代理审查通过或问题已修复。
- 未实现任何“不做”列表中的功能。
