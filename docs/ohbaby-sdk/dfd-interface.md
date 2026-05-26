# ohbaby-sdk 模块 dfd-interface.md

本文档描述 `ohbaby-sdk` 在 UI surface 与 backend adapter 之间的数据流和接口定义。

---

## 一、Context & Scope（上下文与范围）

SDK 位于 `ohbaby-agent` 和 `ohbaby-cli` 之间：

```
ohbaby-cli / stdout renderer / remote UI
        │
        │ UiBackendClient
        ▼
ohbaby-sdk DTO + parser + resolver
        ▲
        │ implements
ohbaby-agent adapter
```

本文档只描述 SDK 协议层的数据如何流动，不描述 backend 内部 Bus 或 TUI 组件实现。

---

## 二、Data Flow Description（数据流描述）

### 2.1 初始连接

1. UI surface 持有 `UiBackendClient`。
2. UI 调用 `getSnapshot()` 获取首屏状态。
3. UI 调用 `listCommands({ surface })` 获取当前 surface 可见 catalog。
4. UI 调用 `subscribeEvents(handler)` 接收增量事件。
5. UI 使用 snapshot 和 catalog 构建本地 store。

### 2.2 Prompt 提交

1. UI 收集用户输入。
2. UI 调用 `submitPrompt(text, options)`。
3. Backend adapter 接收请求并启动 run。
4. Backend 通过事件发布 run、message、runtime 增量。
5. UI 根据事件更新本地 store 并渲染。

### 2.3 Slash command 提交

1. UI 使用 `parseSlashInput()` 判断输入是否为 slash command。
2. UI 使用 `resolveCommand(catalog, parsed)` 做 exact match。
3. 若无法匹配，TUI surface 显示本地错误和 suggestion；IM/channel surface 可按策略转为普通 chat。
4. 匹配成功后 UI 构造 `UiCommandInvocation`。
5. UI 调用 `executeCommand(invocation)`。
6. Backend 通过 `command.started`、`command.result.delivered` 或 `command.failed` 回流结果。

### 2.4 Interaction round-trip

1. Command 执行中需要用户选择或确认。
2. Backend 发布 `interaction.requested`，包含 `interactionId`、`kind`、`subject` 和 options。
3. UI 根据语义渲染自己的 picker/dialog。
4. 用户完成选择后，UI 调用 `respondInteraction(interactionId, response)`。
5. Backend resume command，并继续通过事件回流结果。

### 2.5 Catalog 更新

1. Backend 因用户命令、MCP、plugin 或配置 reload 更新 catalog。
2. Backend 发布 `command.catalog.updated`，包含新版本号和原因。
3. UI 调用 `listCommands({ surface })` 拉取最新 catalog。
4. UI 替换本地 catalog，补全和提示立即使用新版本。

---

## 三、Interface Definition（接口定义）

### UiBackendClient

| 接口 | 数据流位置 | 语义 |
|------|------------|------|
| `getSnapshot()` | 初始连接 | 获取 UI 首屏状态 |
| `subscribeEvents(handler)` | 所有异步回流 | 订阅 SDK 事件 |
| `listCommands(query)` | 初始连接 / catalog 更新 | 获取指定 surface 的命令目录 |
| `submitPrompt(text, options)` | Prompt 提交 | 提交用户 prompt |
| `executeCommand(invocation)` | Command 提交 | 提交已解析命令 |
| `respondPermission(id, response)` | Permission 回填 | 响应权限请求 |
| `respondInteraction(id, response)` | Interaction 回填 | 响应语义化交互 |
| `abortRun(runId?)` | 用户中断 | 请求中断运行 |

### Parser / Resolver

| 函数 | 输入 | 输出 |
|------|------|------|
| `parseSlashInput(input)` | 原始输入文本 | slash 词法结果或 null |
| `resolveCommand(catalog, parsed)` | catalog + 词法结果 | resolved command 或错误 |
| `filterCommandCatalog(catalog, partial)` | catalog + partial input | 补全候选 |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | 责任 |
|------|--------|------|
| Snapshot | backend adapter | 保证反映当前 backend 状态 |
| Catalog | backend CommandService | 保证分类、可见性、alias 唯一性 |
| Parsed slash input | SDK parser | 保留输入结构，不判断业务合法性 |
| Resolved command | SDK resolver | 按 catalog 做确定匹配 |
| Command result event | backend adapter | 将 command 输出转为 SDK 事件 |
| Interaction response | UI surface | 只表达用户选择，不执行业务 |

---

## 五、错误处理策略

| 场景 | 处理 |
|------|------|
| Unknown command | TUI 严格报错并给 suggestion；IM/channel 可 unknown-as-chat |
| Ambiguous alias | Backend catalog 构建失败，不下发歧义 alias |
| Invalid args | Backend command 发布 `command.failed`，code 为 `INVALID_ARGS` |
| Interaction canceled | UI 调用 `respondInteraction` 表示 cancel，backend 决定取消或降级 |

---

## 六、文档自检

- [x] 先描述了数据流，再描述接口。
- [x] 每个接口都能映射到具体数据流。
- [x] Catalog、interaction、command result 的所有权明确。
