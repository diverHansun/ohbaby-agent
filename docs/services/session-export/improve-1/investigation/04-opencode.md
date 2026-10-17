# OpenCode 会话导出

来源：本地 `opencode/`，HEAD `15b24ae12ddb8b7ae3e923b286b4032761bee510`。只读源码与测试。

## 已证实事实

| 入口 | 格式、保存和内容规则 | 证据 |
|---|---|---|
| CLI | opencode session export [session] --sanitize；默认原始 JSON，正文写 stdout，提示写 stderr；不指定目标时选最近 50 个根会话。 | `packages/cli/src/commands/handlers/session/export.ts:11`；`commands/commands.ts:444` |
| TUI | /export 弹选项；默认 Markdown、thinking=true、tools=true、sanitize=false；仅 JSON 可 sanitize。 | `packages/tui/src/routes/session/index.tsx:1220`；`src/ui/dialog-export-options.tsx:28` |
| TUI 保存 | tmpdir()/session-{randomUUID}.md 或 json，也可复制；普通 writeFile，唯一性来自 UUID。 | `packages/tui/src/routes/session/index.tsx:1252`；`src/ui/dialog-export-result.tsx:28` |
| Web | 会话菜单 Rename、Export…、Delete；Archive 是独立按钮。 | `packages/app/src/home/sessions/view.tsx:782` |
| Web 保存 | Blob → object URL → a.download → revoke；原生平台调 saveFile 对话框。 | `packages/app/src/session/commands/export.ts:48` |

JSON schema 为 `{ info, messages }`，直接复用 Session.Info 和 SessionMessage.Info，见 `packages/schema/src/session-transfer.ts:7`。

## 不同端的内容范围

- **CLI/TUI**：走 `packages/core/src/session/transfer.ts:57` 的专用 export；`:165` 的 isSettled 要求 assistant 已有 completed 时间，shell/compaction 非 running，其他消息保留。error 等已结束消息也可导出。
- **Web/GUI**：`packages/app/src/session/commands/export.ts:10` 和 `packages/gui-extensions/src/context/export.ts:3` 并行读 session 和首批消息，然后每页 200 条继续翻页。没有 isSettled，也不走 sanitize。
- **历史**：`packages/core/src/session/store.ts:140` 的 messages 直接读取消息表，按 seq 排序，和供模型使用的 latest context 路径分开。compact 不意味着原始表记录被排除。
- **Markdown**：`packages/tui/src/routes/session/index.tsx:3552` 的 formatSessionTranscript 仅处理 user、shell、assistant；compaction、synthetic、system、skill 等被跳过。reasoning/tool 可开关，用户附件未列出，工具附件只写名字或 URI。
- **子会话**：每次只读一个 session ID，不递归导出子会话；parentID 可保留，导入时要求对应父会话已存在。见 `packages/core/src/session/transfer.ts:57` 和 `packages/protocol/src/groups/session.ts:253`。

因此，不能笼统说“OpenCode 只导出已完成消息”，也不能说 Markdown 和 JSON 内容等价。

## 文件名与 sanitize

- `packages/app/src/session/commands/export.ts:37` 优先 title/slug/ID，清洗为文件名；清洗为空会退回 session ID。纯中文标题会失去可读标题，但不会生成空文件名。
- `packages/core/src/session/transfer.ts:171` 的 sanitize 将正文、reasoning、工具输入输出、路径、metadata 等整段换成 `[redacted:类别:id]`。它不是只识别密码后遮住密码。
- `packages/core/test/session-create.test.ts:1453` 的测试保留一条 compaction error.message。因此 sanitize 也不能被概括为完整秘密检测。

## 测试证据

- `packages/core/test/session-create.test.ts:1240` 起：settled 过滤、import、providerState、sanitize、冲突 ID 不改变原会话。
- `packages/cli/test/import-export.test.ts:58`：stdout JSON、sanitize、非交互缺 session、找不到会话。
- `packages/app/src/session/commands/export.test.ts:7`：完整分页、去掉游标、文件名回退、原生保存成功/取消。

## 待核实

未运行参考仓测试，也未检查分页时会话不断增长的实际用户体验。源码中的多端差异已确认。

## 推断

多端自行收集历史会形成不同的内容规则。依据是 Web 的 message.list 与 CLI/TUI 的 SessionTransfer 两条独立链路；这正是 ohbaby 同一 Collector 方案要避免的差异。
