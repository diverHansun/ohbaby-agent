# 0. 讨论结论

> 来源：2026-10-17 用户与 agent 的讨论。这里只保留已经确认的结论，被否决的方案不写。

## 0.1 需求

- **TUI**：输入 `/export`，导出当前会话，然后提示文件保存到了哪里。
- **Web**：会话栏右键，或点会话旁的三个点打开菜单。菜单里现在有 Pin 和 Archive，在它们后面加一项 Export。
- **用途**：保存用户和 AI 的讨论记录。

## 0.2 已确认的决策

| # | 议题 | 结论 |
|---|---|---|
| 1 | 导出格式 | 可以选 **HTML**（给人看）或 **JSONL**（给程序读） |
| 2 | TUI 默认格式 | `/export` 不带参数时导出 HTML。用 `/export html` 或 `/export jsonl` 指定格式 |
| 3 | 保存位置 | 网页端走浏览器下载，TUI 写本地文件，默认都放在 Downloads 下 |
| 4 | Downloads 目录 | 要支持 macOS、Linux、Windows。Windows 用 `%USERPROFILE%\Downloads`，默认在 C 盘。Linux 先读 `XDG_DOWNLOAD_DIR`，读不到再用 `~/Downloads` |
| 5 | 自定义路径 | 这一版不支持 `/export html <路径>` |
| 6 | 再导入 | 这一版不做。JSONL 头部带上 `format` 和 `version`，给以后留余地 |
| 7 | 导出内容 | 所有消息类型都导出，包括思考过程和工具调用。不导出 model-state 和隐藏的上下文 |
| 8 | compact 掉的原始消息 | 导出，并加上 `compacted` 标记 |
| 9 | 子代理 | 这一版不导出子代理的中间过程，只保留主会话里的 `subagent_run` 调用和结果 |
| 10 | HTML 实现 | 参考 pi 的单文件 HTML 导出 |
| 11 | 网页端菜单 | 只放一项 Export，鼠标移上去展开子菜单，在里面选 HTML 或 JSONL |
| 12 | 网页输入框里的 `/export` | 不支持，网页端只能从会话菜单导出 |
| 13 | 文档 | 新模块按 plan-module-design 写，放在 `docs/services/session-export/`。接入已有代码的改造按 plan-code-improvement 写，放在 `improve-1/` |
| 14 | HTML 里的 MCP 图片 | 显示出来，只允许 png、jpeg、gif、webp 四种格式，SVG 不显示。来自 codex 审核 |
| 15 | 文件名 | `ohbaby-<YYYYMMDD-HHmmss>-<会话 id 随机段>.<ext>`，例如 `ohbaby-20261017-153012-k3x9ab1.html`。原方案用 id 前 8 位，但前 8 位恒为 `session_`，没法区分会话。来自 codex 审核 |

## 0.3 agent 提出、用户没有反对的默认做法

- 会话还在运行时导出：导出读取时已经持久化的全部可导出内容，不等待当前任务结束；尚未持久化的流式尾部不保证包含，没跑完的工具调用标上当前状态。
- 空会话：提示"没有可导出的内容"，不生成文件。
- 不覆盖已有文件：同名时在文件名后面加 `-1`、`-2`。文件名格式见决策 #15。
- Windows 固定用 `%USERPROFILE%\Downloads`。用户把下载文件夹挪走了，也不会跟过去，这一点作为已知限制。
- 界面文字用英文，和现有 UI 保持一致。TUI 导出成功后提示导出了多少条消息、保存在哪里，并提醒文件可能含敏感内容。
- 不自动识别或替换正文中的秘密，由调用方提醒用户；内部字段过滤是另一条独立规则。参考项目并非全部原样导出，详见源码复核。
- 不设大小上限。
- 网页端看子代理对话的视图里不放导出入口。
- TUI 的 `/export` 自己在 TUI 里处理：调用 client 拿到文件内容，再写到本机。这样远程模式（`--remote-port`）下文件也会落在用户自己的机器上。

## 0.4 参考项目

调研了 codex、opencode、pi、kimi-code、deepseek-harness、ZCode，详见 [03-reference-projects.md](./03-reference-projects.md)。

## 0.5 本批实施范围（2026-10-17 追加确认）

用户确认先修正文档，再在 `codex/session-export-backend` 实施后端；Web 的 `http.ts`、`client.ts` 底层接线一并完成，TUI/Web 界面先不动。完成后先做子代理审查，再用 Pi 的 `opencode-go/gemini-4-argon-contributor` 检查。视觉检查等待前端实施完成。
