# 01 — 代码现状

日期: 2026-06-05
对象: `packages/ohbaby-cli/src/tui`

## 技术栈

- 渲染: **Ink 6 + React 19**（`render()` from `ink`）。
- 命令行入口: `yargs`。
- 着色: `chalk 5`。
- 后端契约: `ohbaby-sdk`（`CoreAPI`、`UiSnapshot`、事件类型）、`ohbaby-agent`。
- 测试: `vitest 2` + `ink-testing-library 4`，按 type 分（`*.unit.test.ts` / `*.contract.test.tsx` / `*.integration.test.ts`），脚本 `scripts/run-vitest-by-type.mjs`。

## 目录现状

```
tui/
  index.tsx                      渲染入口 renderTerminalUi()
  app.tsx                        主组件：订阅事件、装配布局、全局键盘
  components/
    header.tsx  logo.tsx  footer.tsx  status-bar.tsx
    message/message-list.tsx
    message/parts/tool-part.tsx
    prompt/index.tsx  prompt/completion.tsx
  dialogs/
    manager.tsx confirm.tsx permission-dialog.tsx
    model-dialog.tsx session-dialog.tsx select-one.tsx
  slash-commands/
    completions.ts hints.ts runtime.ts
  store/
    events.ts selectors.ts snapshot.ts
```

## 各模块职责与质量

### 健康（保留不动）

- **store/**：事件溯源。`events.ts` 把 `TuiEvent` reduce 进 `TuiStoreState`，`selectors.ts` 派生运行时标签/有效状态，`snapshot.ts` 定义内部类型。设计清晰，与渲染框架解耦。
- **slash-commands/**：`runtime.ts` 解析/解析 slash 输入，`completions.ts`/`hints.ts` 提供补全候选。逻辑独立、已有单测。
- **dialogs/manager.tsx**：编排 permission/interaction 队列，逻辑可保留，仅需套主题。

### 原始（本批次重做）

渲染层的具体问题：

1. **无 markdown**。`message-list.tsx` 直接把 `part.text` 塞进 `<Text>`，助手回复是纯文本，无标题/列表/代码块/加粗。
2. **工具结果被藏掉**。`message/parts/tool-part.tsx` 的 `formatOutput()` 无论输入一律返回 `"result hidden"`（L46-48）。工具调用只显示一行 `tool <name> (<status>)`，`input` JSON 截断到 180 字符。
3. **手写输入处理**。`prompt/index.tsx` 用 `useInput` 逐字符拼接字符串（L102-106），无光标移动、无多行、无粘贴优化、无输入历史。
4. **配色散落**。`color="cyan"` / `dimColor` 等硬编码散布在 header/footer/status-bar/message-list/completion/各 dialog 里，没有集中的主题或语义层。改配色要全局搜替换。
5. **无视觉层次**。消息用 `roleLabel()` 输出 `you`/`ohbaby`/`tool` 文字角色头（`message-list.tsx` L80-104），缺背景/竖线/前缀等装饰，用户消息和 AI 消息难区分。
6. **footer 提示行**写死英文（`footer.tsx`），与目标设计不符。
7. **状态行信息薄**。`status-bar.tsx` 仅 `status: <label>` + 可选 session，无 mode/permission/token。

## 数据契约现状（关键约束）

来源 `packages/ohbaby-sdk/src/snapshot.ts`：

```ts
type UiMessagePart =
  | { type: "text";        text: string }
  | { type: "reasoning";   text: string }
  | { type: "tool-call";   call: UiToolCall }
  | { type: "tool-result"; result: UiToolResult };

interface UiToolCall   { id; name; input: Record<string, unknown>;
                         status: "pending"|"running"|"completed"|"failed" }
interface UiToolResult { callId; output: string; error?: string }
```

**结论**：工具富渲染所需的数据（工具名、输入参数、状态、输出、错误）**已经全部在 snapshot 里**。当前 `"result hidden"` 是渲染层主动隐藏，不是数据缺失。

工具参数命名（来自 `packages/ohbaby-agent/src/tools/*`）：
- `edit`: `old_string` / `new_string` / `file_path` → 可生成 diff（本批次延后渲染 diff）。
- `bash`: `command`。
- `read` / `write` / `grep` / `glob`: `file_path` / `path` / `pattern` 等。

**缺口**：`UiSnapshot` 没有 token / cost / context-window 字段 → 状态行 token 估算本批次无法实现，已记入
`docs/problem-lists/2026-06-05-tui-status-bar-token-estimation.md`。

## app.tsx 现有行为（需保留）

- 订阅事件 → `store.dispatch`；`command.result.delivered` 且 `action.kind === "app.exit"` 时退出。
- `command.catalog.updated` 触发 `loadCatalog()`。
- 启动拉 `getSnapshot()` + `listCommands({surface:"tui"})`。
- 全局键：`Shift+Tab` 切权限模式；`Ctrl+C` 在有权限请求/运行中时 abort，否则 exit。

这些行为在重做时**必须保持等价**（契约测试覆盖）。
