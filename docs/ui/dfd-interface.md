# ui 模块 dfd-interface.md

本文档描述 `ui` 模块与外部模块的数据流和接口定义。

---

## 一、Context & Scope（上下文与范围）

UI 是 `ohbaby-cli` frontend surface，只通过 `UiBackendClient` 与 backend 通信：

```
ohbaby-agent/bin.ts
   │ injects
   ▼
renderTerminalUi({ client })
   │
   ├─ getSnapshot()
   ├─ listCommands({ surface: "tui" })
   ├─ subscribeEvents()
   ├─ submitPrompt()
   ├─ executeCommand()
   └─ respondPermission/respondInteraction()
```

本文档不描述 backend 内部 Bus，也不描述 CLI stdout renderer。

---

## 二、Data Flow Description（数据流描述）

### 2.1 TUI 启动

1. `bin.ts` 创建 `UiBackendClient`。
2. `bin.ts` 调用 `renderTerminalUi({ client })`。
3. TUI 调用 `getSnapshot()` 初始化本地 store。
4. TUI 调用 `listCommands({ surface: "tui" })` 获取 catalog。
5. TUI 调用 `subscribeEvents()` 接收增量。

### 2.2 普通 prompt

1. 用户输入普通文本。
2. TUI 判断不是 slash command。
3. TUI 调用 `submitPrompt(text, { sessionId })`。
4. Backend 通过 message/run/runtime events 回流。
5. TUI reducer 更新 store，组件重新渲染。

### 2.3 Slash command

1. 用户输入 `/model switch anthropic claude-opus-4-7`。
2. TUI 调用 SDK parser/resolver。
3. Resolver exact match 到 `model.switch`。
4. TUI 构造 `UiCommandInvocation`。
5. TUI 调用 `executeCommand(invocation)`。
6. Backend 通过 command events 回流结果。

### 2.4 输入 hints 和 Tab 补全

1. 用户输入 `/model` 但尚未 Enter。
2. TUI 使用 catalog 展示子命令/参数 hints。
3. 用户按 Tab。
4. TUI 补全下一 segment，例如 `list`、`current`、`switch`。
5. 输入 hints 不调用 backend command。

### 2.5 Model selection interaction

1. 用户输入 `/model` 并 Enter。
2. TUI 提交 command invocation。
3. Backend 发布 `interaction.requested { kind: "select-one", subject: "model" }`。
4. TUI 打开 provider + model selector。
5. 用户选择某个 option。
6. TUI 调用 `respondInteraction(interactionId, { kind: "accepted", choiceId })`。
7. Backend 完成模型切换并发布 command result。

### 2.6 Session selection interaction

`/session` Enter 的流程与 model selection 类似，subject 为 `session`。

---

## 三、Interface Definition（接口定义）

### UI 对外入口

| 接口 | 语义 |
|------|------|
| `renderTerminalUi({ client })` | 启动 TUI |

### UI 依赖的 SDK 接口

| 接口 | 用途 |
|------|------|
| `getSnapshot()` | 首屏状态 |
| `listCommands()` | 命令 catalog |
| `subscribeEvents()` | 增量事件 |
| `submitPrompt()` | 提交普通 prompt |
| `executeCommand()` | 提交 resolved command |
| `respondPermission()` | 权限响应 |
| `respondInteraction()` | interaction 响应 |
| `abortRun()` | 中断运行 |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | UI 责任 |
|------|--------|---------|
| Snapshot | backend | 投影到本地 store |
| Command catalog | backend | 缓存、补全、展示 |
| PromptState | UI | 完整拥有 |
| DialogState | UI | 完整拥有 |
| Backend business state | backend | 只通过 SDK 请求修改 |
| Render output | UI | 完整拥有 |

---

## 五、错误处理策略

| 场景 | UI 行为 |
|------|---------|
| unknown slash | TUI 严格报错并显示 suggestion |
| ambiguous completion | 展示候选，不执行 |
| command.failed | 渲染错误消息 |
| interaction canceled | 调用 `respondInteraction` 返回 cancel |
| command.catalog.updated | useStream 标记 catalogInvalidation，useCatalog 重新拉取 catalog |
| stream.gap | 暂停普通 delta，调用 getSnapshot/listCommands/getMessages 重建 TuiStore，清空 pending 后恢复消费 |

---

## 六、文档自检

- [x] 数据流只通过 SDK。
- [x] 输入 hints 与 command execution 分离。
- [x] interaction round-trip 明确。
