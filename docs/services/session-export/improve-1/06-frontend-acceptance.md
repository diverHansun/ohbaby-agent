# 6. 前端接入与 HTML 视觉验收

日期：2026-10-17。开发分支：`codex/session-export-backend`，集成目标：`main`。本文接续 [05 后端批次](./05-implementation-acceptance.md)，记录用户完成前端接入后，本轮检查与直接修复的结果。

> 清理说明：按用户要求，`improve-1/evidence/` 下的临时验收文件已全部删除，包括截图、导出样例、日志、PDF 和复现脚本。本文保留当时的测试结果；正式源码测试继续保留。

## 结论与修复

macOS TUI 的 `/export` 和 Web 会话菜单的 HTML / JSONL 导出已通过实际交互验证。HTML 阅读页按用户要求减少框嵌套，借鉴 Pi 对正文与工具信息的区分方式，保留本项目的离线和转义约束。

| 问题 | 修复与证据 |
|---|---|
| 旧后端 REST 404 无业务码时，TUI / Web 只显示原始 HTTP 错误 | 映射为“不支持导出”；有 `SESSION_NOT_FOUND` 等业务码时仍保留业务错误。先补失败测试，再修复；Web 用实际菜单和路由故障注入复核两种文案。 |
| TUI 导出路径较长，把 notice 标签、标题、来源挤成碎字 | 将并列 Flex Text 改为父 Text 内的行内文本，敏感内容提醒另起一行。真实 PTY 重放确认路径和提示可读。 |
| Markdown 出现大量无意义的空行 | 容器改为 `white-space: normal`，marked `breaks: true` 保留正文软换行；代码保留空格和缩进。 |
| HTML 多层卡片、折叠框和状态框重复 | 消息改用留白和细分隔线，details 无外框，状态改为小号文字；标题和统计保持可见，完整元数据收进 Session details。思考正文用普通字体，代码及工具输入输出保留浅底。 |
| 暗色错误文字偏暗，页脚混入正文 | 单独设置深色错误颜色；页脚使用分隔线、小号文字。 |
| 长工具输出打印时穿插“more lines”，并出现大块空白页 | 打印隐藏该操作提示，连接前后两段输出，允许 pre 自然跨页。最终 PDF 从 6 页缩为 4 页，保留摘要、思考和 line 32，打印后折叠状态恢复。 |

## TUI 实际验证

使用真实 source CLI（`node --import tsx`），在 macOS PTY 中输入命令。独立临时 profile、workspace、SQLite 只包含合成消息；没有读取真实会话或提交模型 prompt。

- 本地与 `--remote-port` 各验证 `/export`、`/export html`、`/export jsonl`、两种错误参数、`/help`、`/expo` 补全和退出，共各 9 阶段，均 exit 0。
- 远程模式使用另一进程的真实 daemon / HTTP JSON-RPC，服务端记录三次导出，客户端未创建本地 DB，文件落在 TUI 所在机器的 Downloads。
- 当时生成的六个实际导出文件均已核对，并仅清理本次 UUID 对应的 Downloads 文件；测试副本现已按用户要求删除。
- 下载目录解析、排他写入与冲突后缀、错误提示、真实 catalog → Prompt → resolveCommand → executePromptCommand → run-export 链路均有回归覆盖。
- TUI 定向回归：8 个文件、296 条测试通过；独立审查另跑 54 条，通过。

当时检查的终端画面来自真实 ANSI 的终端单元格重放再栅格化，**不是原生 Terminal 窗口截图**。这些临时文件现已清理。

## Web 实际验证

使用生产 Web 构建、源码 daemon、真实 persistent backend / SQLite；浏览器为 Chromium 155.0.8059.82，连接本机 loopback。合成会话包含 compact 前历史、摘要、思考、32 行工具输出、内嵌位图、中文、emoji、美元符号、Markdown 表格、代码及长字符串。

| 场景 | 结果 |
|---|---|
| 右键和省略号菜单 | Pin / Archive / Export 顺序正确；悬停或点击 Export 展开 HTML / JSONL。 |
| 实际下载两种格式 | 两次 download failure 均为 null；文件名与扩展名正确。目标是未选中的历史会话，下载后当前会话保持不变，菜单关闭，焦点回到该会话的 Actions 按钮。 |
| 键盘 | Shift+F10 打开，主菜单 End → Export，→/Enter → HTML，子菜单 ↓/Home/End 只移动格式选项，←/第一次 Esc 回到 Export，第二次 Esc 关闭并恢复触发按钮焦点。 |
| 空会话 | 显示 Nothing to export，无下载，不切换当前会话。 |
| 错误注入 | 无业务码 404 显示 Export is not supported by this backend；有 SESSION_NOT_FOUND 时显示 Session not found；菜单正常关闭。 |
| 375×740 菜单 | 主菜单 x=29..205，子菜单 x=207..327，均在视口内，未被裁切。 |
| Blob 生命周期 | unit 验证 UTF-8 大小和 MIME、挂载后点击、filename、移除 anchor、延后且只释放一次 object URL；点击抛错时同样清理。 |

Web App、菜单和下载工具合计 192 条定向测试通过。成功下载走真实 REST；404 使用浏览器路由故障注入，未声称启动过旧版 daemon。

## HTML 与打印视觉结果

当时实际打开浏览器下载的 HTML，检查了浅色、深色、375px 窄屏和展开后的工具内容。导出样例与截图现已清理。

- 1440px 与 375px 均无页面水平溢出；窄屏 scrollWidth=375。
- 原始 `<script>` 作为文字显示，测试哨兵没有执行；HTTP(S) 自动请求和页面脚本错误均为 0。
- 内嵌 PNG 展开后 naturalWidth=1；工具输出完整保留到 line 32。
- 最终 PDF 为 4 页；提取文本确认元数据、压缩摘要、思考及最后一行工具输出都在，没有“more lines”操作文字。检查了 PDF 栅格化页面；详情在打印前后均保持原来的关闭状态。
- 打印测试显式使用 print media；screen media 不代表打印样式。修复前后 PDF、提取文本和检查结果现已清理。

## 审查与最终检查

- TUI 子代理审查：Spec PASS / Quality PASS。
- Web 修复与 HTML 简化子代理审查：最终 PASS，无剩余 actionable findings；独立 38 条 HTML 测试及生成资源一致性检查通过。审查发现的 details 数量断言已限定为 main 内的折叠项，Session details 的打印恢复另有断言。
- Pi：按用户确认的 `opencode-go/gemini-4-argon-contributor`、`medium`，沿用本任务独立 session。首轮建议已核实，第二轮读取简化源码及四张新截图，结论 PASS；两轮完整原文已在对话呈现。最后的 pre 分页修复由主代理实际 PDF 验证及子代理复核，未声称 Pi 再审过该最后一条 CSS 调整。
- `pnpm preflight` exit 0：format、lint、typecheck、全量 test、build 全部通过。565 个测试文件通过、6 个跳过；6,689 条测试通过、17 条跳过。Lint 为 0 error / 122 warnings；构建保留 Web bundle 大于 500 kB 的现有提示。
- 最终模板资源已重新生成，`--check` 和 `git diff --check` 通过。

## 复现与边界

临时端到端复现脚本已随 evidence 目录删除。源码中的单元、契约和集成测试仍可通过 `pnpm test` 运行；重新做视觉或实际下载验收时，需要重新创建独立测试会话。此前 fixture 未调用模型，所用 token 是合成值。

Linux / Windows 只有注入平台参数的 Downloads 单元测试，尚未跨操作系统实跑；远程只在同一台 Mac 的两个进程间验证。没有运行 Safari / Firefox，也未用最终发布二进制重跑 PTY。因此 [04](./04-test-and-acceptance.md) 的跨 OS 手工发布门仍不能标为完成。本轮所有测试后台服务已停止，用户数据与会话未改动。


## Opus 独立视觉重做与复核（2026-10-17，后续批次）

用户指定 `calling-pi` 使用 `anthropic/claude-opus-5-5`、`medium` 直接优化 HTML，延续同一个任务会话。Pi 自主决定版式、字体和颜色；主代理未修改视觉源码，只反馈实测的可读性和功能问题。

- 改为仿书页的单栏排版、暖白/暖黑底色、系统衬线标题、细线和留白分段；工具折叠行增加输入摘要，时间本地化并保留原始 ISO。详情仍完整保存在单文件 HTML 中，未加入费用字段。
- 主代理测得浅色辅助文字对比度约 4.04:1；Pi 调整为 `#66655e`（纸色上约 5.41:1），并移除压缩内容的整体透明度，避免小字再次变淡。
- 独立审查发现 119.6 秒显示为 `1 m 60 s`；Pi 修正取整进位并补 8 组边界测试。最终 HTML 测试 48/48 通过，资源生成一致性检查通过。
- HTML 子代理最终复审无未解决 finding；后端/SDK/REST/RPC/TUI/Web 接线子代理未发现可复现 P1/P2，独立 11 个文件、99 条定向测试通过。
- 主代理以实际 Chrome 155.0.8059.82 检查最终页面的 1440px / 375px、浅色 / 深色媒体查询，均无页面水平溢出。离线外部请求和页面脚本错误均为 0；脚本哨兵不执行，危险链接不生成，内嵌 PNG 成功解码。
- 用合成会话复核思考、压缩摘要、错误/中止/运行状态以及 85 行长工具输出。打印输出包含所有正文哨兵和工具最后一行，不出现“more lines”操作文案；打印后折叠状态恢复。Tab 焦点可见，Enter 可展开会话详情。
- DOM 插入由 `innerHTML` 改为 `DOMParser` + `replaceChildren`。审查确认输入仍经过转义或受限 Markdown 渲染；解析器本身不承担清洗职责，安全边界仍由转义、链接规则、图片规则和执行测试共同保证。
- 本轮预览、截图、PDF、脚本、日志均放在系统临时目录；没有重建 `improve-1/evidence/`。`services/session-export/html/` 是正式实现及回归测试，按用户“没用才删除”的要求核查后保留。
- 最终 `pnpm preflight` exit 0：format、lint、typecheck、全量 test、build 均通过。565 个测试文件通过、6 个跳过；6,699 条测试通过、17 条跳过。Lint 0 error / 122 warnings，Web 仍有既有的 500 kB 包体积提示。

用户已确认进入交付收尾。文件审计核对了 21 份文档及新增源码、测试、资源：均有实际用途，没有空模板或需要删除的正式文件；已删除的 evidence 临时目录保持不存在。提交分为导出核心（含 HTML）、协议接线、TUI、Web 菜单、文档五批。集成目标为 main，只推送 main，不推送本地功能分支。
