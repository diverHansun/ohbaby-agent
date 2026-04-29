# Prompt — 输入框组件概述

## 一、定位

Prompt 是用户与应用交互的主要入口，负责文本输入、slash command 提交、普通 prompt 提交、历史导航和 inline 自动补全。它固定在 DefaultLayout 底部（StatusBar 上方），是用户最频繁交互的组件。

对应职责追溯：goals-duty.md D4（Slash 输入体验）。

## 二、组件结构

```text
Prompt
├── TextInput（基于 Ink TextInput）
└── Completion（Inline 自动补全建议）
```

Prompt 不自行实现文本缓冲区。基础文本编辑功能依赖 Ink 的 TextInput。

## 三、核心功能

### 3.1 文本输入与提交

- 用户在输入框中输入文本。
- 按 Enter 提交输入，由 `useInput(client)` 处理。
- 提交后清空输入框。

### 3.2 输入分流

`useInput` 根据输入内容分流：

| 输入格式 | 处理路径 |
|---|---|
| 能被 `parseSlashInput()` 识别并 `resolveCommand()` 成功 | `client.executeCommand(invocation)` |
| 普通文本 | `client.submitPrompt(text, { sessionId })` |
| slash resolve 失败 | 本地显示错误和 suggestion，不调用 backend |

Prompt 本身不直接调用 lifecycle、commands 或 cli/commands 模块。

### 3.3 历史导航

通过 `useHistory` hook 实现：

| 按键 | 行为 |
|---|---|
| Up | 显示上一条历史记录 |
| Down | 显示下一条历史记录 |

### 3.4 Tab 自动补全（Inline 模式）

Tab 补全仅用于 slash 命令，不用于普通文本补全。

- 数据来源：TuiStore catalog
- 过滤函数：SDK `filterCommandCatalog()`
- 显示方式：在光标后显示单个灰色建议文本

详见 [completion.md](./completion.md)。

### 3.5 输入 Hints

当用户输入 `/model` 但尚未 Enter 时，Prompt 可以展示当前命令路径的子命令/参数提示。Hints 由 `useInput.getHints()` 提供，纯本地计算，不调用 backend。

**重要边界**：父命令的 Enter 行为由 backend `parentBehavior` 字段声明并通过 `interaction.requested` 触发；Prompt/TUI 不本地决定 `/model` 或 `/session` 是否打开 selector。

## 四、冻结状态

当 `AppStateContext.dialog.current !== null` 时（有弹窗显示），Prompt 进入冻结状态：

- 不响应键盘输入。
- 显示为灰色/不可用样式。
- 弹窗关闭后自动恢复。

实现方式：Prompt 读取 `AppStateContext.dialog.current`，当其非 null 时跳过所有输入处理。

## 五、Hook 依赖

| Hook | 职责 |
|---|---|
| useInput | 输入提交、命令分流、补全获取、hints |
| useHistory | 历史记录导航 |
| useKeypress | 键盘事件监听 |

## 六、Context / Store 依赖

| 依赖 | 用途 |
|---|---|
| AppStateContext `dialog.current` | 冻结状态判断 |
| TuiStore catalog/runtime（通过 useInput 内部 selector） | 补全、resolve、activeSessionId |

Prompt 不直接读取旧 ConfigContext 或 SessionContext。

## 七、视觉结构

```text
> user input here                     ← 正常状态，带 > 提示符
> user input here /mo|del             ← 补全状态，'del' 为灰色建议
                                      ← 冻结状态，灰色不可用
```

提示符 `>` 前缀固定显示，表示输入就绪。冻结时提示符也变为灰色。

## 八、设计约束

1. **不自行实现 TextBuffer**：依赖 Ink TextInput。
2. **不处理业务逻辑**：提交逻辑委托给 useInput。
3. **补全仅限 slash 命令**：不做通用文本补全。
4. **单实例**：整个应用只有一个 Prompt 实例。

## 九、文档自检

- [x] 提交流程已对齐 SDK parser/resolver + client 调用。
- [x] 不再引用 cli/commands 或 lifecycle。
- [x] 补全和 hints 的数据来源已改为 TuiStore catalog。
- [x] 已明确 parentBehavior 由 backend 决定。
