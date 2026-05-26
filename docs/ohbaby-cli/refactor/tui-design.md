# `ohbaby-cli` TUI 设计与验收标准

本文档在 `docs/ui/` 既有设计基础上，定义 `packages/ohbaby-cli/src/tui/` 的职责边界、内部拆分、样式/布局原则、键盘交互标准、验收标准与测试标准。

本文档是设计审核稿。Phase 0 已完成 `ohbaby-tui` 到 `ohbaby-cli` 的命名重构；后续按本文推进 TUI 的样式、布局与输入体验优化。

---

## 一、与既有 `docs/ui/` 的关系

`docs/ui/` 的以下结论继续保留：

- UI 只通过 `UiBackendClient` 消费 backend，不 import `ohbaby-agent` 内部模块。
- TUI store 是 SDK snapshot/events 的本地投影，业务真相在 backend。
- 颜色应继续沿用 `docs/ui/styles/` 已定义的 colors -> semantic tokens -> theme getter 三层设计，而不是在组件里散落颜色。
- SelectableList 这类 primitive 要区分“焦点项”和“当前项”，不能用同一个视觉符号表达两种语义。
- Prompt、Dialog、StatusBar、MessageList 的视觉呈现属于 UI surface。

需要修正的旧假设：

- 旧文档仍以 `packages/ohbaby-tui/` 为代码位置；Phase 0 后应统一为 `packages/ohbaby-cli/src/tui/`。
- 旧文档假设存在 `AppStateContext`、`useKeyboard`、`Ink TextInput`、`VirtualizedList` 等未来结构；当前代码尚未落地。新设计把它们视为演进方向，而不是 Phase 0 要求。
- 旧文档把 `styles/` 放在 UI 顶层语境；重命名后应落在 `src/tui/theme/`，因为它服务的是 Ink TUI，而不是所有 CLI surface。

---

## 二、`ohbaby-cli/src/` 的模块边界

`ohbaby-cli` 是 CLI 前端应用包，不等于 TUI。`tui/` 是其中的 interactive terminal surface。

建议目标结构：

```text
packages/ohbaby-cli/src/
├── index.ts          # 包公开入口，薄 re-export
├── tui/              # Ink 交互式终端 UI
├── stdout/           # 未来：非交互 stdout event sink
├── args/             # 未来：argv/help/version 解析，若从 agent 迁出
└── shared/           # 未来：tui/stdout 共享 formatter
```

### 2.1 Phase 0 只创建 `tui/`

Phase 0 只做：

- `packages/ohbaby-tui` -> `packages/ohbaby-cli`
- 原 `src/*` -> `src/tui/*`
- 新增 `src/index.ts` re-export `./tui/index.js`

不创建空的 `stdout/`、`args/`、`shared/` 目录。空目录无法被 Git 稳定表达，也会提前制造未使用抽象。

### 2.2 为什么不叫 `src/cli/`

包已经叫 `ohbaby-cli`，内部再出现 `src/cli/` 会延续“CLI composition root / CLI frontend / CLI args”混用问题。

若以后从 `packages/ohbaby-agent/src/cli/` 迁出非交互能力，建议按职责命名：

| 未来模块 | 职责 | 触发条件 |
|---|---|---|
| `stdout/` | 非交互 event sink、stdout/stderr 格式化 | `--prompt` 输出格式变复杂，或远端/headless surface 复用 |
| `args/` | argv/help/version 文本解析 | `ohbaby` 子命令增多，需要 CLI frontend 持有参数语义 |
| `shared/` | TUI 与 stdout 都要用的纯 formatter | 出现第二个真实消费者，不提前创建 |

---

## 三、`src/tui/` 的职责范围

`tui/` 的语义是 interactive terminal surface。它负责终端里的用户交互，不负责进程入口和非交互输出。

### Duties

- 渲染 SDK snapshot/events：消息、run 状态、permission、interaction、notice、command result。
- 管理 TUI 本地 store：把 SDK 数据投影为组件可消费状态。
- 处理终端键盘输入：Prompt 输入、completion、dialog navigation、global shortcuts。
- 展示 slash command UX：候选、hint、Tab 补全、exact command submission。
- 渲染 dialog：permission、model/session select-one、confirm。
- 管理 Ink 布局：header、transcript、dialog dock、prompt、footer/status。
- 管理 TUI 主题 token：颜色、状态语义、角色语义、选择态语义。

### Non-Duties

- 不解析 argv，不读取 stdin，不决定 exit code。
- 不实现 stdout 非交互渲染。
- 不 import `ohbaby-agent`、runtime、commands、lifecycle、session 或 provider。
- 不直接使用 Node 文件/进程能力（`node:fs`、`node:child_process` 等）。所有 IO 必须经由 SDK 协议或 client 方法；如需展示 cwd、git 状态等主机信息，应从 `UiSnapshot` 投影获取。
- 不维护 command catalog 真相；只缓存和展示 backend catalog。
- 不做业务参数校验；参数合法性由 backend command 负责。

---

## 四、TUI 内部拆分建议

Phase 0 不拆内部结构。Phase 1 之后按下面目标逐步整理：

```text
src/tui/
├── index.tsx
├── app.tsx
├── layout/
│   ├── app-shell.tsx
│   ├── transcript.tsx
│   └── dock.tsx
├── theme/
│   ├── colors.ts
│   ├── tokens.ts
│   ├── theme-manager.ts
│   └── index.ts
├── input/
│   ├── keymap.ts
│   ├── actions.ts
│   └── prompt-editor.ts
├── slash/
│   ├── types.ts
│   ├── resolve.ts
│   ├── completions.ts
│   └── hints.ts
├── store/
├── dialogs/
└── components/
```

### 4.1 `command/` 建议改名为 `slash/`

TUI 当前的 `command/` 实际只处理 slash 输入、补全和 hint。backend 和 SDK 已经有 `commands/command` 语义，继续叫 `command` 容易混淆。

Phase 1 建议改为 `slash/`：

- `resolve.ts`：把输入解析为 `OhbabySlashIntent`
- `completions.ts`：候选与 Tab 补全
- `hints.ts`：视觉 hint 文案
- `types.ts`：intent 与 busy/invalid reason

`slash/` 不重复实现 parser，也不新建本地 `parse.ts`。`resolve.ts` 直接 import `parseSlashInput`、`resolveCommand` 和 `filterCommandCatalog` from `ohbaby-sdk`，本地只追加 busy、invalid、message 等 TUI 维度的 intent 包装。

### 4.2 `input/` 先轻量，不照搬 pi

pi 的 keybindings、grapheme cursor、kill-ring、paste handling 很成熟，但直接照搬会过重。

ohbaby MVP 先定义轻量 action map：

| Action | 默认按键 | 说明 |
|---|---|---|
| `prompt.submit` | Enter | 提交输入 |
| `prompt.complete` | Tab | 接受补全或展开候选 |
| `prompt.clear` | Ctrl+U | 清空输入 |
| `select.up` | Up | 候选/列表上移 |
| `select.down` | Down | 候选/列表下移 |
| `select.confirm` | Enter | 选择当前项 |
| `select.cancel` | Esc | 取消 dialog |
| `run.abortOrExit` | Ctrl+C | permission -> abort run -> exit |
| `mode.cycle` | Shift+Tab | ask/plan/agent 循环 |

后续若 Prompt 需要多行、光标移动、粘贴、kill-ring，再局部吸收 pi 的实现思想。

迁移策略：`input/keymap.ts` 先负责全局快捷键（mode cycle、global abort、exit）和 action 命名。Dialog 内部仍然使用 Ink `useInput` 就近处理 Esc/Enter/方向键等局部交互，但绑定到 keymap 导出的 action 名，而不是散落裸键值。Prompt editor 因为要管理输入文本、候选导航、补全和历史，后续独立成 `prompt-editor.ts`。

---

## 五、样式设计原则

Ink 没有传统 CSS 文件，但仍然应使用 CSS 的工程思想：token、语义、状态、布局契约。

### 5.1 Theme Token

`docs/ui/styles/` 已经定义了 colors、semantic tokens、ThemeManager 和测试策略。`ohbaby-cli` 的实现应对接这份既有设计，而不是另起一套 token 分组。

TUI 内的物理落点建议为：

```text
theme/colors.ts         # 对应 docs/ui/styles/colors.md
theme/tokens.ts         # 对应 docs/ui/styles/tokens.md
theme/theme-manager.ts  # 对应 docs/ui/styles/theme-manager.md
theme/index.ts          # 对外导出 theme / SemanticTokens
```

如后续需要 Ink 专用 helper，可新增 `theme/ink.ts`，但它只包装现有 theme token，不定义新的语义分组。

组件不直接写裸颜色：

```tsx
// 不推荐
<Text color="cyan">ohbaby</Text>

// 推荐
<Text color={theme.message.assistant}>ohbaby</Text>
```

建议 token 分组：

| 分组 | 用途 |
|---|---|
| `text` | 主要文本、辅助文本、强调文本、链接文本 |
| `tool` | pending / running / completed / error / aborted |
| `diff` | added / removed / context / hunkHeader |
| `ui` | border / highlight / dimmed；slash prefix、layout divider、disabled 等也归入此组 |
| `status` | error / success / warning / info |
| `message` | user / assistant / system / tool role 色彩 |
| `dialog` | tone、focus、current、danger、footer 等选择态色彩 |

若后续发现 `slash` 或 `layout` 语义已经多到挤压 `ui` 分组，再通过更新 `docs/ui/styles/tokens.md` 的方式扩展；实现时不在 `tui-design.md` 里单方面新增冲突分组。

### 5.2 低噪声配色

当前代码大量使用 `cyan`、`green`、`yellow`、`red`。优化后应降低“所有东西都在喊”的感觉：

- 品牌和当前焦点用 primary accent。
- 成功/错误/警告只用于状态，不用于普通标签。
- session id、footer hint、catalog refresh 等低优先级信息用 muted。
- reasoning 和 tool detail 默认弱化，展开时再提高对比度。

### 5.3 视觉层次

借鉴 opencode 的 message/tool 分层，但在终端里保持克制：

- Header 只在空会话明显展示 logo；有消息后压缩成一行状态。
- User/assistant 消息用 role label + gutter，而不是大块装饰。
- Tool call 默认展示一行摘要，错误可多展示 2-4 行。
- Dialog 使用 dock 语义，固定在 prompt 上方，不和 transcript 混成一团。

---

## 六、布局设计原则

目标是建立 layout contract，而不是在 `app.tsx` 里临时堆 Box。

### 6.1 区域结构

```text
Header          可压缩
Transcript      主内容，可增长
DialogDock      有 permission/interaction 时出现
PromptDock      始终靠近底部
FooterStatus    一行，高价值状态
```

此处的 “Dock” 指固定相对位置的非滚动区域：`DialogDock` 紧贴 `PromptDock` 之上，`PromptDock` 紧贴 `FooterStatus` 之上，两者不参与 `Transcript` 的滚动。Dock 内组件高度由内容决定，但不会被 Transcript 推走。

### 6.2 宽度降级

必须支持 40 / 80 / 120 列宽：

| 宽度 | 规则 |
|---|---|
| 40 | 隐藏低价值 footer 文案；session id 截断；completion 只显示命令路径 |
| 80 | 展示常规状态、mode、permission、短 session |
| 120 | 可展示更多 command hint、tool summary、路径尾部 |

长文本策略：

- session id：保留前 8 + 后 4 或使用 title。
- 文件路径：目录部分左侧截断，保留 filename。
- command hint：固定最大列宽，超出截断。
- tool output：默认摘要，详细输出不直接撑开主列表。

### 6.3 焦点与禁用态

- dialog 存在时，Prompt 输入冻结，显示 disabled token。
- permission dialog 的默认焦点策略留到 Phase 3 按产品视角确认。候选方案是：写操作（edit / write / shell）默认落在“拒绝”或“询问每次”，读操作（read / glob / grep）默认落在“允许此次”；具体映射应由 `UiPermissionRequest` 的语义字段驱动。
- SelectableList 的 focus 与 current 必须分离：focus 是当前键盘位置，current 是已激活项。

---

## 七、命令与键盘交互原则

借鉴 kimi-code 的 intent 设计，但保持 ohbaby 的 backend catalog 模型。

```ts
type OhbabySlashIntent =
  | { readonly kind: "not-command" }
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "command"; readonly invocation: UiCommandInvocation }
  | { readonly kind: "blocked"; readonly commandName: string; readonly reason: "streaming" | "compacting" }
  | { readonly kind: "invalid"; readonly commandName: string; readonly reason: "unknown" };
```

规则：

- `slash/resolve.ts` 只解析意图，不直接调用 client。
- `Prompt` 负责输入状态，不负责 backend command 细节。
- `app.tsx` 或 action 层负责把 intent 分发到 `client.submitPrompt()` / `client.executeCommand()`。
- busy 状态从 `UiSnapshot` 派生，不维护第二份本地 busy。
- skill/plugin/mcp 命令不在 TUI 特判，统一来自 `UiCommandSpec.source`。

---

## 八、验收标准

### Phase 0 命名重构

完整执行清单见 [rename-tui-to-cli.md §4](rename-tui-to-cli.md)。本文只声明边界：

- 不改变运行行为、不改 SDK 契约、不拆 backend。
- `renderTerminalUi` 和 `OhbabyTerminalApp` 对外 export 名称不变。
- `packages/ohbaby-agent/src/bin.ts` 是唯一允许装配 backend client 与 `ohbaby-cli` TUI 的 composition root。

### Phase 1 Slash/Input

- TUI 不再维护与 SDK 重复的 slash parser。
- SDK `parseSlashInput()` 的 `parsed.path` 与 `resolveCommand()` 的匹配语义一致，不再硬编码 `segments.slice(0, 1)` 作为唯一 path。多段命令如 `/mode agent`、`/session list` 在补全候选与 hint 中显示正确命令路径。
- `Prompt` 提交路径通过 `OhbabySlashIntent` 分发。
- busy blocked 行为从 snapshot 派生。
- `command/` 改名为 `slash/` 后，backend `commands` 与 TUI slash 语义清楚分离。

### Phase 2 Theme

- 用户可见颜色全部来自 `theme/tokens.ts` 或 `theme/ink.ts`。
- 新增裸颜色字符串必须在 review 中说明理由。
- role/status/dialog/tool/slash token 均有单元测试覆盖。
- `Header`、`StatusBar`、`MessageList`、`Prompt`、`Completion`、`Dialog` 不再各自硬编码颜色。

### Phase 3 Layout

- 40 / 80 / 120 列宽下，Header、Transcript、Dialog、Prompt、Footer 不互相覆盖。
- 长 session id、长 command hint、长文件路径、长 tool summary 均截断或换行，不撑坏布局。
- dialog 出现时 Prompt 明确 disabled，键盘焦点只归当前 dialog。
- Footer 只展示高价值状态，不出现调试噪声。

---

## 九、测试标准

### 单元测试

- `theme/tokens.unit.test.ts`：每个 token 分组完整，状态枚举映射完整。
- `slash/resolve.unit.test.ts`：覆盖 not-command / message / command / blocked / invalid。
- `input/keymap.unit.test.ts`：覆盖默认 key -> action 映射，避免 Shift+Tab、Ctrl+C 语义漂移。

### Contract / Rendering 测试

使用 `ink-testing-library`：

- 40 列：长 session、长 command hint、dialog + prompt disabled。
- 80 列：常规聊天、completion 候选、status bar。
- 120 列：tool summary、较完整 command hints。

断言重点不是精确快照每个空格，而是：

- 关键文本存在。
- debug 文案不存在。
- 长文本被截断或换行。
- disabled/focus/current 的视觉符号可区分。

### Integration / Smoke

- 现有 TUI integration tests 迁移到 `ohbaby-cli` import。
- packaging smoke 同时 pack `ohbaby-sdk`、`ohbaby-cli`、`ohbaby-agent`。
- `ohbaby --help`、`ohbaby --version` 仍由 `ohbaby-agent` bin 通过。
- 交互 smoke 至少覆盖：permission dialog、abort、policy mode cycle、session picker。

---

## 十、实施顺序

1. Phase 0：命名与文档断链修复。
2. Phase 1：SDK slash 多段 path + TUI `slash/` intent。
3. Phase 2：theme tokens 落地并替换散落颜色。
4. Phase 3：layout contract、宽度降级、dialog/prompt dock。
5. Phase 4：completion、SelectableList、Prompt editor 体验增强。

任何 Phase 2/3 中发现的架构问题，优先用小范围局部调整解决，不重新打开包边界讨论。

---

## 十一、Implementation 文档约定

每个 Phase 使用一份 implementation 文档，统一放在 `docs/ohbaby-cli/refactor/`：

- `implement-phase-0-rename.md`
- `implement-phase-1-slash.md`
- `implement-phase-2-theme.md`
- `implement-phase-3-layout.md`

每份文档使用 checkbox 格式，每个 task 至少包含：修改文件、新建文件、测试命令、验收标准。Phase 0 的 implementation 文档应以 [rename-tui-to-cli.md §4](rename-tui-to-cli.md) 为唯一动作清单来源，避免重复维护两份迁移步骤。
