# Kimi Code 会话导出

来源：本地 `kimi-code/`，HEAD `cbd754049a114ee36d1b27675c82819e4963c692`。只读源码与测试，未运行该仓测试。

## 已证实事实：可读 Markdown

| 主题 | 事实 | 证据 |
|---|---|---|
| 入口 | /export 是 /export-md 的别名；另有 /export-debug-zip。 | `apps/kimi-code/src/tui/commands/registry.ts:407-417` |
| 数据源 | handleExportMdCommand 调 session.getContext()。 | `apps/kimi-code/src/tui/commands/session.ts:108-150` |
| 路径 | 默认 workDir/kimi-export-{id8}-{UTC秒时间戳}.md；显式路径用进程 cwd 解析；递归建父目录。 | 同文件 `:123-145` |
| 防覆盖 | writeFile 没有 wx；秒级时间戳不保证同秒不会覆盖。 | 同文件 `:141` |
| 内容 | YAML 会话头，用户 turn 分组，思考和工具结果用 details 折叠；保留调用参数和 call ID。 | `apps/kimi-code/src/tui/utils/export-markdown.ts:41-95,166-174,189-254` |
| 媒体 | image/audio/video 留占位符，不嵌附件；hidden thinking 不导出。 | 同文件 `:41-57` |
| 过滤 | origin 为 injection、system_trigger、compaction_summary、hook_result、cron_job、cron_missed 的消息排除；用户提交 hook 文本也排除。 | 同文件 `:97-151`；`message-replay.ts:242-248` |
| 统计 | frontmatter 的 message_count 来自原 history，而正文经过过滤，两者不一定相等。 | `export-markdown.ts:207-210,238,246-251` |
| HTML 边界 | 生成的是含 details 的 Markdown，没有独立 HTML viewer；文本和工具 summary 没有按可执行 HTML 的安全要求统一转义。 | 同文件的 formatter |

## compact 后为什么不是完整历史

调用链为：

1. `packages/node-sdk/src/sdk-rpc-client-v2.ts:1856-1868` 的 getContext。
2. `packages/klient/src/core/facade/agent.ts:134-139` 读 contextMemoryService。
3. `packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts:48-50` 返回 contextMemoryKey。
4. `contextOps.ts:101-106` 在 compact 后替换 memory。
5. `compactionHandoff.ts:86-124` 形成保留的用户消息、摘要和 continuation，不保留全部旧 assistant/tool 原文。
6. 摘要 origin 为 compaction_summary，又被 Markdown exporter 过滤。

因此，准确表述是“compact 后部分旧用户消息可能还在，但旧助手/工具原文不完整”，不是所有旧消息一概消失。

## 已证实事实：诊断 ZIP 与 Web

- CLI `kimi export [sessionId] -o path -y` 默认含 global log，可关闭；TUI /export-debug-zip 也调用 SDK exportSession 并打开 global log。证据：`apps/kimi-code/src/cli/sub/export.ts:62-134`；`src/tui/commands/session.ts:152-175`。
- service 先 flush 活跃 session 日志和 agent wire，再收集 session 目录、manifest、可选 global/Web/desktop 日志，排除 file-history blob。证据：`packages/agent-core-v2/src/app/sessionExport/sessionExportService.ts:53-140,195-255`。
- ZIP 流使用临时目录、pipeline、abort 和句柄清理，最终 rename；这个 rename 不能保证目标不被覆盖。证据：同目录 `zip.ts:76-104,159-221`。
- Web 源码已迁出该仓；仍可检查 server 的 `POST /sessions/{session_id}/export`，它返回 ZIP，含 Content-Disposition、Content-Length、no-store，并在取消后清理临时文件。证据：根 AGENTS.md；`packages/kap-server/src/routes/sessionExport.ts:40-178`。
- 预构建 Web bundle 的菜单与 /export 调上述 ZIP 接口，再 Blob 下载。证据：`apps/kimi-code/dist-web/assets/index-CiJ6FDOC.js:51,584,1073-1126`。这是编译产物证据，不宜当可维护源码引用。

## 测试证据

- `apps/kimi-code/test/tui/export-markdown.test.ts`：thinking、工具 hint、媒体占位、内部消息过滤、turn 分组和图片路径。
- `packages/kap-server/test/sessions.test.ts:185-315`：ZIP 下载、找不到 session、取消、临时文件清理、Web/desktop 日志。
- `packages/agent-core-v2/test/app/sessionExport/sessionExport.test.ts:193-785`：轮转日志、300+ 文件、路径冲突、hardlink、固定读取范围、abort、symlink、flush 失败。
- 同文件 `:166-189` 的重复导出测试等待 1.1 秒；不能据此证明同秒防覆盖。

## 待核实

Web 产品源码不在本仓，菜单实现只能通过预构建 bundle 确认。没有发现独立 HTML 会话导出路径。

## 推断

可读导出和诊断包的目标不同。Kimi 前者过滤用户不关心的注入内容，后者收集日志和多个 agent 文件；不能把 ZIP 的全面收集直接套到 ohbaby 的对话留存需求。
