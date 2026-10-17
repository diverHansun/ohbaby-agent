# Codex 会话导出

来源：本地 `codex/`，HEAD `12cca49c81c8aa6a37a5cc4e39964ee3b70f9458`。只读源码与测试，未运行该仓测试。

## 已证实事实

| 主题 | 事实 | 证据（仓库相对路径） |
|---|---|---|
| 入口 | TUI /export 可选复制到剪贴板或保存文件；/export path 直接导出。 | `codex-rs/tui/src/slash_command.rs:50,111`；`chatwidget/transcript_export.rs:8-65`；`chatwidget/slash_dispatch.rs:807` |
| 格式与默认名 | Markdown；默认 codex-session-{thread_id}.md。 | `codex-rs/tui/src/chatwidget/transcript_export.rs:47` |
| 运行状态 | 任务运行中禁用 /export；允许 side conversation。 | `codex-rs/tui/src/slash_command.rs:196-212,242-266` |
| 保存机器 | 本地使用会话 cwd；远程使用客户端 launch_cwd。 | `codex-rs/tui/src/app/transcript_export.rs:64-74` |
| 文件写入 | 支持绝对、相对、~/ 路径；在父目录建临时文件，persist_noclobber 发布，不覆盖；不自动创建父目录或加后缀。 | 同文件 `write_transcript:297-313` |
| 完整读取 | 当前 thread_id 以 HistoryHydrationScope::Complete 补齐所有页，再构造 transcript。 | 同文件 `load_export_transcript:81-136` |
| 降级 | 临时会话导出 visible_transcript；分页不支持时尝试旧 thread_read，仍失败或空数据时回退可见记录。 | 同文件 `:92-119` |
| 用户正文 | 去掉 IDE 附加上下文、提取用户 prompt，过滤重复 review 提示与此前复制/导出提示。 | 同文件 `visible_export_items:202-225`、`render_markdown_transcript:227-267` |
| 结构 | User、Assistant、Plan、Reasoning、Activity 分节；活动缩进，避免工具文本变成文档标题。 | 同文件 `:268-287` |
| 思考 | 可导 reasoning summary；raw reasoning 取决于 show_raw_agent_reasoning。 | 同文件 `:42-46`；`codex-rs/tui/src/thread_transcript.rs:307-330` |
| 工具 | 文件修改带路径、状态、完整 diff；MCP 带工具名、参数、文本/结构化结果和错误。 | `codex-rs/tui/src/app/transcript_export.rs:139-199` |
| 媒体 | 图片/音频为占位文字，资源保留 URI，不嵌 base64；用户图片标记为 Image #n。 | 同文件 `:164-185,235-243` |
| compact 与子代理 | compact 留活动标记；只读取当前线程，子代理可呈现活动摘要，不递归打包完整子线程。 | `codex-rs/tui/src/thread_transcript/other_items.rs:82-110` |
| 内部内容边界 | 不是通用脱敏；HookPrompt 可作为 hook prompt 活动导出。 | 同文件 `:113-126` |
| 错误 | 无会话、无内容、历史读取失败、写文件失败都有可见错误；成功提示完整路径。 | `codex-rs/tui/src/app/transcript_export.rs:38-41,70-74,88-120,290-313` |

证据表中省略 `codex-rs/tui/src/` 前缀的 chatwidget 路径使用该前缀。

## 测试证据

- `codex-rs/tui/src/app/transcript_export_tests.rs:20,65,125,180,206`：正文/ANSI、内部 review 提示、diff/MCP/媒体、防覆盖和相对路径。
- `codex-rs/tui/src/app/tests/session_lifecycle_requests.rs:2617-2650`：导出 305 条历史，验证完整分页。
- `codex-rs/tui/src/chatwidget/tests/copy_export_picker_tests.rs:93-131`：取消弹窗不改变草稿，Unicode 文件名保留。

## 待核实

- 未在真实 Codex TUI 操作 /export。这里只确认当前代码路径与测试覆盖。
- “完整历史”有临时会话与旧后端降级例外，不能据此承诺所有版本都无条件完整。

## 推断

客户端保存、持久历史读取与独占发布是三个独立责任。它们分别由导出 handler、history hydration、write_transcript 承担；这支持将 ohbaby 的内容生成与客户端保存分开的讨论，但不是对 ohbaby 已实现行为的描述。
