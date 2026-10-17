# session-export 模块 data-model.md

本文档定义导出过程中用到的核心概念，以及 JSONL 文件的格式。这里统一的是"用什么概念来讨论导出"，字段名在实现阶段可以微调。如果改了字段名，要同步更新本文和 [test.md](./test.md)。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话解释 |
|---|---|
| **ExportDocument** | 一次导出的中间数据：会话头 + 按时间排好的导出消息列表。HTML 和 JSONL 都从它渲染 |
| **ExportHeader** | 会话的元数据、导出时间、统计信息、格式版本 |
| **ExportMessage** | 一条可导出的消息：角色、时间、模型、状态，以及一组 ExportPart |
| **ExportPart** | 消息里的一段内容，只有三种：正文 `text`、思考 `reasoning`、工具 `tool` |
| **ExportResult** | 模块对外的产物：建议文件名、MIME 类型、文件内容（字符串） |

这些概念都是**一次性的值对象**：每次导出时生成，用完就丢，不落库，也没有生命周期。所以本文不写 Entity 和生命周期两节。

---

## 二、从数据库到导出数据的映射

数据来源是 `session` 表，以及该会话**主上下文**（`contextScopeId` 为空）里的全部 message 和 part，**包括已经 compact 掉的**。

### 2.1 消息级

| 源数据 | 导出处理 |
|---|---|
| `UserMessage` | 导出成 `role: "user"`。`system`（注入的系统提示）和 `tools`（工具开关）**不导出** |
| `UserMessage` 且 `runtimeInput.kind` 不是 `user-steer`（子代理结果、状态的回填） | 导出成 `role: "system"`，带 `runtimeInput: "subagent-result" \| "subagent-status"`。这和 UI 的处理一致 |
| `AssistantMessage` | 导出成 `role: "assistant"`，带 `model`、`status`、`finish`、`error`、`usage`、`usageComplete` |
| `AssistantMessage` 且 agent 是 `context`、带 `context-summary` part | 导出成 `role: "assistant"`，加 `kind: "compaction-summary"`，摘要正文**也导出**。UI 只显示一行 "Compacted…"，导出要保留全文 |
| `SystemMessage`（abort / error / info） | 导出成 `role: "system"`，带 `kind` |
| 过滤后一个 part 都不剩的消息 | 跳过 |

### 2.2 Part 级

| 源 part | 导出处理 |
|---|---|
| `text` | 导出。正文优先用 `metadata.displayText`，没有就用 `text`。这条和 UI 一致：用户输入经过展开时，导出用户实际看到的那段文字 |
| `text` 且是 model-context（`synthetic` + `model-context:runtime:v1`） | **不导出** |
| `reasoning` | 导出 `text`，带 `endReason` |
| `tool` | 导出 `tool`、`callId`、`status`、`input`、`output`、`error`，不导出 `raw` |
| `tool` 且工具名是 `select_tools` 或 `todo_read` | **不导出**。这是内部工具，UI 上也不显示 |
| `tool` 且工具名是 `todo_write` | 导出。UI 不把它当成工具调用显示，但它记录了 AI 当时的计划，属于讨论内容 |
| `model-state` | **不导出**。里面是加密的思考内容、签名和接口地址 |
| 任意 part 带 `time.compacted` | 照常导出，加 `compacted: true` |

part 的顺序优先使用有限数值 `metadata.sourceOrder`，否则使用 `orderIndex`；相同值保持原顺序。

**字段映射是白名单式的**：只取上表列出的字段，不把 message 或 part 对象整个复制过去。以后新增的 part 类型和字段，默认都不会被导出。

**synthetic 不等于不导出**：compact 摘要本身也是 synthetic 的 text part，照样导出。只有 model-context 这一种 synthetic part 被去掉。

### 2.3 统计

- **费用**：HTML 和 JSONL 均不提供费用、单价或估算金额字段；token 数量不换算成金额。这不涉及删改会话正文或工具输入输出中用户自己的财务内容。
- **token**：优先把每条助手消息里 `modelRequests[].usage` 加起来。没有请求记录时，用 carrier part 上的 `metadata.tokenUsage`。usage 从原始 parts 读取，再过滤内容，避免 carrier 是 model-state 时丢失统计。`total = input + output`，reasoning 已包含在 output 中，不再重复相加。未报告的 usage 不伪造为 0：消息省略 usage，汇总无已知值时省略 tokens；汇总同时记录 `usageCoverage: { known, unknown }`（可导出助手消息数），known 表示该消息全部请求都有 usage，unknown 包含完全缺失和部分缺失；消息上的 `usageComplete` 对应这一判断。部分已知数值仍计入 tokens，所以不能把它当作完整账单。reasoning 在任一已知请求未报告时省略。
- **models**：所有助手消息里出现过的 `providerId/modelId`，去重后按第一次出现的顺序排列。
- **messageCount**：导出的消息条数。

### 2.4 与底层诊断记录的边界

当前 JSONL 是讨论记录的白名单投影，不是数据库备份或完整执行日志。现有数据库还保存了模型请求记录（请求标识、步骤、尝试、开始/首字/结束时间、结果、输入归属、usage）、运行台账、prompt 接纳和重提记录、工具执行观察信息、子代理执行与快照索引。后续可以基于这些数据另做诊断导出，但本版不增加这些字段。

这些记录不等于完整事件历史：message/part 和请求观察会更新已有记录；server 的事件回放只保留有容量限制的内存缓冲。进程诊断日志默认位于 `~/.ohbaby/logs`（可由 `OHBABY_HOME` / `OHBABY_LOG_DIR` 改变），仅记录已埋点事件，默认 `info` 级别，并实行轮转和过期清理；它不会完整保存请求正文、响应正文和每个流式片段。已有记录能导出，但未持久化的历史不能事后恢复。若需要完整执行时间线，须另行设计持久化事件记录及保留策略。

---

## 三、JSONL 格式（v1）

### 3.1 整体结构

- UTF-8 编码，每行一个 JSON 对象，换行符是 `\n`，文件最后有一个换行。
- 中文直接写进文件，不转成 `\uXXXX`。
- 第 1 行固定是 header，第 2 行起每行一条 message，按 `time.created` 升序排列。时间相同时，按数据库里的插入顺序排。

### 3.2 header 行

```json
{
  "type": "session",
  "format": "ohbaby.session-export",
  "version": 1,
  "exportedAt": "2026-10-17T07:30:12.000Z",
  "app": { "name": "ohbaby", "version": "x.y.z" },
  "session": {
    "id": "...", "title": "...", "projectRoot": "/abs/path",
    "agent": "build", "status": "active",
    "createdAt": "...", "updatedAt": "..."
  },
  "stats": {
    "messageCount": 42,
    "models": ["deepseek/deepseek-v4.1-flash"],
    "tokens": { "input": 100, "output": 25, "reasoning": 8, "total": 125 },
    "usageCoverage": { "known": 1, "unknown": 2 }
  }
}
```

### 3.3 message 行

```json
{
  "type": "message",
  "id": "...",
  "role": "assistant",
  "kind": "compaction-summary",
  "time": { "created": "...", "completed": "..." },
  "model": { "providerId": "deepseek", "modelId": "deepseek-v4.1-flash" },
  "status": "completed",
  "finish": "stop",
  "usage": { "input": 100, "output": 25, "reasoning": 8, "total": 125 },
  "usageComplete": true,
  "parts": [
    { "type": "reasoning", "text": "...", "endReason": "normal" },
    { "type": "tool", "tool": "bash", "callId": "...", "status": "completed",
      "input": { "command": "ls" }, "output": "...", "compacted": true },
    { "type": "text", "text": "..." }
  ]
}
```

- 时间一律用 ISO 8601 UTC 字符串。
- 可选字段没有值时**省略**，不写成 `null`。
- `kind` 只在两种消息上出现：compact 摘要（`compaction-summary`），以及系统消息（`abort` / `error` / `info`）。
- 助手消息 `status` 取 `running | completed | error | aborted`，失败时包含白名单错误字段 `name` 和可选 `message`。
- `compaction-summary` 助手消息视为 `completed`，即使核心消息没有 `time.completed`；导出不会据此伪造完成时间。
- 工具 `status` 取 `pending | running | completed | error | aborted` 之一。会话还在运行时导出，可能会出现 `pending` 和 `running`。
- MCP 工具返回的图片已经以 `![Image](data:...)` 的形式写在 output 文本里。JSONL 原样导出，不另外处理。HTML 里怎么显示见 architecture §4.3。

### 3.4 版本规则

- 只增加可选字段时，`version` 不变。
- 删字段、改字段含义、改行结构时，`version` 加 1。

---

## 四、HTML 展示内容

HTML 和 JSONL 用同一份 ExportDocument，**内容范围完全一致**，区别只在展示方式：

| 内容 | 展示方式 |
|---|---|
| 页面顶部 | 标题、导出时间、消息数、token 统计；项目路径、创建时间、模型等完整元数据收进默认折叠的 Session details |
| 用户和助手的正文 | 按 Markdown 渲染 |
| 思考过程 | 默认折叠，可以展开 |
| 工具调用 | 默认显示工具名、输入摘要和非正常完成状态；窄屏隐藏摘要，展开后保留完整输入、输出、错误与 Call ID |
| MCP 图片 | 只有 png、jpeg、gif、webp 的 data URI 会显示成图片，SVG 不显示 |
| compact 掉的内容 | 较柔和的正文颜色、虚线和 "compacted" 标签，不降低整块透明度 |
| compact 摘要 | 单独一块"上下文摘要"，默认折叠 |
| 系统消息 | 独立正文分段，以缩进和细线区分，保留完整内容 |
| 页面底部 | 一行提醒："可能包含命令输出、文件内容等敏感信息，分享前请检查" |

页面结构和安全约束见 [architecture.md](./architecture.md)。

---

## 五、自检

- 所有概念都能用一句话讲清楚。
- ExportResult 是 [dfd-interface.md](./dfd-interface.md) 里对外接口的返回值。ExportDocument 是两个渲染器共同的输入。没有用不上的概念。
- 没有为导入预先设计任何结构。只留了一个 `version` 字段。
