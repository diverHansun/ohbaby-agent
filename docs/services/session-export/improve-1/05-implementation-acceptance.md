# 会话导出后端实施与验收

日期：2026-10-17。临时分支：`codex/session-export-backend`，起点 `0bcda4846f57fb02c20f67d989297ff6225ffffd`。

> 本文保留后端批次完成时的范围和测试结果。后续 TUI/Web 接入与 HTML 视觉验收已完成，当前验收结论见 [06 前端验收](./06-frontend-acceptance.md)。

本批按用户确认的范围实施：导出服务、SDK、in-process / persistent adapter、REST / JSON-RPC，以及 Web 的 `http.ts` / `client.ts`。TUI 命令、Downloads 写入、Web 菜单和下载交互由后续前端批次完成。本记录不把应用界面或视觉验收记为已完成。

## 已实现的行为

- `UiQueryClient.exportSession({ sessionId, format: "html" | "jsonl" })` 返回 `{ filename, mimeType, content, messageCount }`，客户端负责保存文件。服务不写 Downloads，也不改变当前选中会话。
- 读取指定主会话的已持久化历史，包括压缩前正文和摘要；只取 primary context scope，不混入子代理内部上下文。归档、未选中的会话可以导出；子代理会话、空会话和不存在的会话有稳定错误码。
- HTML / JSONL 使用同一份白名单数据。排除模型上下文、原生 model-state、提示词和内部路由字段。用户正文和工具内容按原意保留，没有自动识别并脱敏任意正文中的秘密。
- 助手用量优先读取 modelRequests；旧记录从原始 part carrier 回退。reasoning 不重复计入 total。缺失用量不伪造为零，部分已知用量仍保留，并用 usageComplete / usageCoverage 标明不完整。
- HTML 内嵌 Markdown 解析器和数据，可离线阅读。原始 HTML 按文本显示；链接使用协议白名单，Markdown 远程图片不加载；仅将工具输出中的指定格式 data 图片转为图片元素。
- 资源生成结果提交为 TypeScript 常量，build 执行 `export-assets:check` 防止模板和生成结果不同步。marked MIT 许可保留在内嵌脚本中。
- REST：`GET /v1/sessions/:id/export?format=html|jsonl`，成功返回 `{ ok: true, export }`。须持有 daemon token 和已注册的 `x-ohbaby-client-id`。JSON-RPC 提供同名 `exportSession` 方法，具有相同输入校验和业务错误状态。

## 验证证据

实施过程中分别观察了收集器、入口、adapter、传输层测试的失败，再实现并验证通过。真实 SQLite 和真实 HTTP 集成测试覆盖归档会话、未选中会话、历史压缩、子上下文隔离；比较导出前后的 session / message / part 表、选中会话和事件记录，确认导出只读。HTML 的安全测试执行最终生成的完整页面，解码 base64 后核对隐藏字段哨兵，覆盖 Unicode、美元符号、script 闭合、原始 HTML、危险 URL、MCP 图片和打印状态恢复。

检查按 `preflight` 的子命令分别执行：

- `pnpm run format:check`：通过。
- `pnpm run lint`：通过，0 error / 122 warning；新增导出模块单独 lint 为 0 error / 0 warning。
- `pnpm exec tsc -b --pretty false`：通过。
- `pnpm build`：通过；最后的摘要状态修复后又运行 agent 包构建，资源新鲜度检查通过。
- 导出模块最终 61 个用例通过（8 collector、14 entry、2 SQLite / local RPC、37 HTML），连同真实 HTTP 集成用例共 62 个通过；服务端与 Web 底层回归 557 个用例通过。
- 全仓 `pnpm test`：561 个文件通过 / 6 个跳过，6625 个测试通过 / 17 个跳过，耗时 229.62 秒。最后的小修复另外执行模块测试和构建检查。
- 收尾修复后，合并运行导出模块、真实 HTTP 集成和 Web daemon API 测试：18 个文件 / 202 个测试通过（包含 Web 底层 140 个测试）。最后的 Web 改动 targeted lint / format、Web typecheck 均通过。
- Pi 使用用户确认的 `opencode-go/gemini-4-argon-contributor` 完成只读检查，确认白名单、HTML 注入防护、主作用域隔离及无写入副作用；指出摘要状态与旧后端纯文本 404 两处问题。两处均已修复，通过回归和子代理定向复审；Pi 未对修复后的版本再次审查。

子代理做了 HTML、传输层和全改动审查。修复了 URL 内部空格被删除和 HTML 页脚提醒遗漏，并补了回归测试；两轴复审通过。收尾时额外发现真实 compaction summary 没有 `time.completed`，因而会被误标为 running；补了真实 SQLite 失败回归后，按摘要的原子持久化语义导出为 completed，并确认不伪造完成时间。修复后定向复审 Spec / Quality 均通过，无剩余发现。

旧 daemon 对不存在的导出路由返回纯文本 404。Web HTTP 层现在允许错误响应的 JSON 解析失败，并保留 HTTP status 及兜底错误消息，让前端能按“404 且无业务 code”判断后端版本不支持；已有 JSON 业务错误仍保留 message / code，成功响应若不是合法 JSON 仍拒绝。新增 404、500 和成功响应解析失败回归；定向复审 Spec / Quality 均通过，无剩余发现。

`@types/jsdom` 引入 DOM fetch 类型后，已有 context-window-probe 的 headers 联合类型不再满足 HeadersInit；仅补了 `Record<string, string>` 注解，没有改变请求行为。SDK 增加必选方法后，本批为既有 CLI / Web UI 测试的 fake client 补了未使用的接口桩，本批未实施应用界面代码；工作区中的并行前端改动不属于本记录的验收范围。

不能仅根据 jsdom 测试通过推断真实浏览器 CSP 或跨平台 Downloads 已验收。

## 大会话实测

合成 SQLite 数据库 41,820,160 bytes（约 39.9 MiB），240 条原始消息、6 张每张约 4 MiB 的有效 PNG、3 次真实压缩。导出保留 243 条消息。未使用用户会话数据。

| 调用方式 | 格式 | 产物 bytes | 耗时 ms | 导出前 RSS MiB | 返回后 RSS MiB | 进程累计峰值 MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 直接服务调用 | HTML | 47,485,869 | 91 | 224 | 547 | 547 |
| 直接服务调用 | JSONL | 35,548,214 | 46 | 447 | 691 | 691 |
| 进程内 RPC | HTML | 47,485,869 | 156 | 437 | 831 | 831 |
| 进程内 RPC | JSONL | 35,548,214 | 111 | 550 | 862 | 862 |

以上四次导出在同一进程连续执行，每次之前请求 GC。峰值来自 `process.resourceUsage().maxRSS`，包含测试数据构建及先前导出，不是四次互相独立的单次增量；耗时只包含导出调用，不包括生成图片和插入数据库。这里没有测浏览器打开时间或 HTTP 跨网络传输耗时。

本批仍采用整份内容返回的设计，不设大小上限。实测表明，多份字符串和 RPC 复制会推高内存；后续候选是流式 JSONL / 文件响应、HTML 降低复制或分段渲染。不能把本机的低耗时当作低内存保证。

## 留给前端批次

TUI `/export` 的命令、保存位置提示和跨平台 Downloads；Web 右键 / 三点菜单、下载行为及错误文案；应用视觉效果；真实浏览器的离线网络、深浅主题与打印检查。
