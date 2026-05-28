# Tool metadata 白名单投影

本文档定义 context improve-2 的 tool metadata 投影契约。结论：**raw metadata 必须持久化，模型上下文只能看到中央白名单投影后的最小执行事实**。

---

## 设计原则

1. raw metadata 属于审计事实，存放在 message store 的 tool part 状态中。
2. 模型可见 metadata 属于上下文投影，由 `core/context/serializer.ts` 统一决定。
3. 不允许各工具自行决定把完整 metadata 拼进 output。
4. 白名单只保留模型下一步继续工作必需的信息。
5. 不把 permission/preflight、pid、resolvedPaths、shell、完整 diff、内部路径扫描细节等状态泄漏给模型。

---

## 最小白名单

| 工具 | 模型可见字段 | 理由 |
|------|-------------|------|
| `bash` | `exitCode`, `signal`, `truncated` | 空输出失败命令必须让模型知道失败原因；截断会影响下一步判断。 |
| `read` | `path`, `mtimeMs`, `hasMore`, `nextOffset`, `lineCount` | `edit/write` 需要 `mtimeMs`；分页读取需要续读信息。 |
| `write` | `path`, `mtimeMs`, `created`, `dryRun` | 后续编辑或覆盖需要新 mtime；dry run 不能误当真实写入。 |
| `edit` | `path`, `mtimeMs`, `replacementCount`, `dryRun` | 后续编辑需要新 mtime；替换数量影响结果判断。 |
| `list` / `glob` / `grep` | `count`, `truncated`, `skippedBinaryFiles`, `skippedLargeFiles` | 截断和跳过信息影响是否继续搜索。 |
| `web_search` / `web_fetch` | `count`, `successCount`, `failedCount`, `truncated` | 模型需要知道检索/抓取是否完整。 |
| `task` / subagent | `sessionId`, `agentName`, `success`, `error` | 父 agent 需要能引用子会话并判断任务是否成功。 |
| `agent_*` long task | `taskId`, `sessionId`, `status`, `pendingInputCount`, `error` | 长任务工具需要可恢复、可轮询、可关闭。 |
| MCP tools | `server`, `tool`, `isError`, `contentTypes`, `structuredContent` | MCP `structuredContent` 常是唯一结构化结果；错误状态也需要进入模型上下文。 |
| `skill` / skill resources | 暂无额外字段 | 当前 output 已包含 base directory、scope、output dir、files；真实 e2e 证明缺口后再加。 |

---

## 禁止投影字段

- permission / preflight / approval internals
- `pid`, `cwd`, `shell`, `shellKind`, `resolvedPaths`, `roots`, `cdTargets`
- 完整 diff；如果模型需要 diff，应由 tool output 明确展示并受截断策略控制
- `todos` 等可变 session state 快照
- 大型 `files` 列表、完整 `loaded` 列表、完整 raw web result payload
- provider/API key、环境变量、凭据、鉴权 header

---

## 投影格式

推荐由 serializer 在 tool result content 后追加稳定、短小的 JSON block：

```text
<tool_metadata>
{"mtimeMs":1234567890,"hasMore":true,"nextOffset":201}
</tool_metadata>
```

约束：

- JSON 必须只包含白名单字段。
- 空对象不输出 block。
- 字段顺序稳定，方便快照测试。
- 大字段必须先截断或改为摘要字段，不允许把完整 raw metadata 塞进 block。

---

## 验收要点

- `read -> edit/write` 经过 DB round-trip 后，下一步模型输入仍包含 `mtimeMs`。
- `bash false` 和无输出失败命令经过 DB round-trip 后，下一步模型输入仍包含 `exitCode`。
- MCP tool result 经过 DB round-trip 后，下一步模型输入仍包含 `structuredContent`。
- raw metadata 中的禁止字段不会出现在 `serializeForLlm` 输出中。
- 白名单逻辑集中在 context serializer 或其相邻 helper 中，不分散到各 tool 实现。
