# cli 模块 architecture.md

本文档描述 `cli` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的职责边界。

---

## 一、Architecture Overview（总体架构）

CLI 采用 composition root 结构：

```
用户进程: ohbaby [-p "..."]
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ packages/ohbaby-agent/src/bin.ts                         │
│ 1. parse argv / stdin                                    │
│ 2. create InProcessBackendAdapter → UiBackendClient      │
│ 3a. interactive → renderTerminalUi({ client })           │
│ 3b. non-interactive → subscribeEvents + stdout sink      │
│                      + submitPrompt(...)                 │
└─────────────────────────────────────────────────────────┘
        │                                 │
        ▼                                 ▼
┌─────────────────────┐        ┌─────────────────────┐
│ ohbaby-agent backend │        │ ohbaby-tui / stdout  │
│ CommandService       │        │ frontend surfaces    │
│ lifecycle/session    │        │ render events        │
└─────────────────────┘        └─────────────────────┘
```

CLI 不再包含 `cli/commands` 子模块。旧职责迁移如下：

| 原职责 | 新归属 |
|--------|--------|
| slash parser | `ohbaby-sdk` 的 `parseSlashInput()` |
| command resolver | `ohbaby-sdk` 的 `resolveCommand()` |
| CommandResult 终端渲染 | TUI command runtime 或 stdout renderer |
| interactive selector | `ohbaby-tui` DialogManager |
| table/list formatter | surface 私有渲染工具 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Composition Root

CLI 是唯一组装 backend 与 frontend 的位置。

**理由**：
- 让 `ohbaby-agent` core 和 `ohbaby-tui` 保持单向依赖 SDK。
- 方便未来把 in-process adapter 替换为 HTTP/WebSocket adapter。
- 保持包依赖图清晰，避免 UI/backend 互相 import。

### 2. Event Sink

非交互模式使用 stdout event sink，而不是直接调用 lifecycle。

**理由**：
- 非交互 CLI 也是一个 UI surface。
- prompt、command、permission、runtime 事件使用同一协议。
- 避免出现 TUI 走 SDK、CLI 绕过 SDK 的双轨行为。

### 3. 未使用的模式

**未引入顶层 orchestrator 包**：V1 中 `bin.ts` 作为组合根即可。未来如果需要独立发布多个入口，再抽出 thin orchestrator。

**未保留 cli/commands 子模块**：parser/resolver 已上移 SDK，renderer 属于 surface，继续保留会制造错误依赖。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

建议结构：

```
packages/ohbaby-agent/src/
├── bin.ts                     # 唯一组合根
├── cli/
│   ├── args.ts                # argv 解析
│   ├── stdin.ts               # stdin 读取
│   ├── exit-codes.ts          # 退出码
│   ├── errors.ts              # CLI 错误
│   └── stdout-renderer.ts     # 非交互 event sink
└── adapters/
    └── ui-inprocess.ts        # UiBackendClient 实现，连接 CommandService/InteractionBroker/StreamBridge
```

### 对外稳定接口

- `bin.ts` 暴露的可执行入口。
- `parseArgs()` 可作为测试辅助。
- `EXIT_CODES`。

### 内部实现

- stdout renderer 的具体文本格式。
- stdin 读取方式。
- signal 处理细节。
- in-process adapter 如何把 SDK client 方法映射到 backend 内部模块。

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: 只有 bin.ts 可跨包组合

**当前选择**：允许 `bin.ts` 同时 import backend adapter 和 `ohbaby-tui`。

**代价**：`ohbaby-agent` package 的入口层知道 TUI package 的存在。

**理由**：这是 composition root 的合理例外，换来 V1 的简单发布模型。

### 约束 2: 非交互也走 SDK

**当前选择**：`ohbaby -p` 调用 `client.submitPrompt()` 并消费 events。

**代价**：需要维护一个 stdout event sink。

**理由**：所有 surface 共享同一协议，避免业务路径分叉。

### 约束 3: CLI 不拥有 command grammar

**当前选择**：删除 `cli/commands` 作为活动设计。

**代价**：旧文档和测试需要迁移。

**理由**：命令语法是跨 surface 契约，应位于 SDK。
