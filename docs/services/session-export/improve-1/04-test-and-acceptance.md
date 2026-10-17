# 4. 测试与验收标准

> 导出模块内部的场景（S1–S11、H1–H9）见 [../test.md](../test.md)。本文覆盖接入层，并给出整体的验收门槛。

> 状态更新（2026-10-17）：后端批次之后，前端也已接入并完成本机端到端检查；最新结果与未覆盖边界见 [06](./06-frontend-acceptance.md)。下文保留原批次范围，作为实施顺序记录。

## 本批验收边界

本批覆盖导出模块、SDK/adapter、REST、JSON-RPC、Web HTTP/client 接线，验证 S1–S11、H1–H9、R1–R6，以及只读性、资源生成、大会话。R7 的传输错误保真在本批测试，UI 文案与 T1–T8、W1–W11、跨平台 Downloads 和视觉验收留到前端批次，不计作本批已完成。HTML 产物安全测试不等于 TUI/Web 视觉验收。

## 4.1 测试范围

| 类型 | 覆盖内容 |
|---|---|
| unit | 导出模块（../test.md），TUI 的 Downloads 目录解析、保存和参数解析，网页端的下载工具 |
| integration | 导出模块配合真实 SQLite（含 compact），ui-inprocess 的 `exportSession` |
| contract | SDK、RPC 代理、JSON-RPC：`exportSession` 能往返，错误码能保留下来 |
| 组件测试（web） | `SessionActionsMenu` 的子菜单和键盘交互 |
| 手工 | 在真实 TUI 和浏览器里各跑一遍；在 Linux 和 Windows 上验证 Downloads 目录 |

## 4.2 关键场景与用例

### TUI（Stage 2）

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | `/export` | unit 或手工 | 生成 `.html`，提示里有 `Exported N messages to <path>` 和敏感内容提醒 |
| T2 | `/export jsonl`、`/export html` | unit | 格式正确。**要用真实的命令目录走完整条链路**：catalog → `resolveCommand` → `executePromptCommand` → `run-export`。这样能确认 `acceptsArguments` 生效，补全回退时参数也不会丢 |
| T3 | `/export foo`、`/export html extra` | unit | 显示用法错误，不调用 client。同样走完整链路 |
| T4 | 没有当前会话、空会话、后端不支持 | unit | 分别提示 "No session to export"、"Nothing to export"、"not supported"，都不生成文件。"后端不支持"要分别模拟三种情况：JSON-RPC 未知方法、REST 404 且没有 code、本机抛出 not available。**不能**靠"方法不存在"来模拟，因为经过 RPC 代理后方法总是存在的 |
| T5 | 同一秒内导出同一个会话两次，再导出另一个会话一次 | unit | 同一个会话第二次的文件名带 `-1`，第一个文件没被覆盖。不同会话的文件名本来就不同 |
| T6 | `resolveDownloadsDir` | unit | 用表格驱动测试覆盖以下情况：<br>- darwin：`~/Downloads`<br>- win32：`C:\Users\x\Downloads`<br>- linux 有环境变量 `XDG_DOWNLOAD_DIR`<br>- linux 有 `user-dirs.dirs`，值为 `"$HOME/下载"`<br>- linux 两者都没有，回退到 `~/Downloads`<br>- linux 的值为空、是相对路径、带 `$OTHER` 变量、带 `` `cmd` `` 或 `$(cmd)`：都被忽略并回退，并且**不会执行任何命令**<br>- `XDG_CONFIG_HOME` 是相对路径：按 `~/.config` 处理<br>- `user-dirs.dirs` 格式错误或读不到：静默回退<br>- 目录不存在：自动创建 |
| T7 | 远程模式（`--remote-port`） | 手工 | 文件写在运行 TUI 的机器上 |
| T8 | `/help` 和命令补全 | unit | 能看到 `/export [html\|jsonl]`。stdout 和 headless 模式下看不到 |

### server 与 RPC（Stage 3）

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| R1 | `GET /v1/sessions/:id/export?format=html` | integration | 200，返回 `{ ok, export: { filename, mimeType, content, messageCount } }` |
| R2 | 没有 token、没有 clientId、client 未注册 | integration | 分别是 401、400、409，和 archive 一致 |
| R3 | format 缺失或不合法 | integration | 400，code 为 `INVALID_FORMAT` |
| R4 | 会话不存在、是子代理会话、是空会话 | integration | 404 `SESSION_NOT_FOUND`，400 `SUBAGENT_SESSION`，400 `EMPTY_SESSION` |
| R5 | 导出**非当前选中**的会话 | integration | 成功（这是和会话读取接口的区别） |
| R6 | JSON-RPC 的 `exportSession` | contract | 能往返，错误码能保留 |
| R7 | 新客户端连旧后端（JSON-RPC 白名单里没有 `exportSession`，也没有 REST 路由） | contract | TUI 和网页端都提示 "not supported"，不会崩溃 |

### Web（Stage 3）

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| W1 | 打开菜单 | 组件 | 依次是 Pin、Archive、Export，Export 带展开标记 |
| W2 | 悬停或点击 Export | 组件 | 子菜单显示 HTML 和 JSONL |
| W3 | 点 HTML | 组件 | 调用 `onExport("html")`，菜单关闭 |
| W4 | `downloadTextFile` | unit | 创建 Blob，`a.download === filename`，最后调用了 `revokeObjectURL` |
| W5 | 键盘：在 Export 上按 → 或 Enter | 组件 | 打开子菜单，焦点到 HTML。按 ← 回到 Export，子菜单关闭 |
| W6 | 主菜单按 ↑ ↓ Home End | 组件 | 只在 Pin、Archive、Export 之间移动，不会进到子菜单项 |
| W7 | 右键打开菜单、按 Shift+F10 打开菜单 | 组件 | 和点 "…" 按钮的行为一致 |
| W8 | 导出失败 | 组件或手工 | 显示错误，菜单状态正常 |
| W9 | 子菜单里按 ↑ ↓ Home End | 组件 | 只在 HTML 和 JSONL 之间移动，焦点不会被拉回主菜单 |
| W10 | 子菜单打开时按 Esc 两次 | 组件 | 第一次只关闭子菜单，焦点回到 Export。第二次关闭主菜单，焦点回到触发按钮 |
| W11 | 用鼠标点击子菜单里的 JSONL | 组件 | 调用 `onExport("jsonl")`。不会因为"点到菜单外"而提前关闭菜单 |

## 4.3 集成边界

- **SDK ↔ 后端**：本机走 RPC 代理，远程走 JSON-RPC，网页走 REST。三条路的返回结构要一样。
- **后端 ↔ 数据库**：导出过程只读，不能有任何写操作。用 integration 测试断言导出前后数据库内容一致。
- **TUI ↔ 文件系统**：所有 fs 和 os 依赖都注入，unit 测试不碰真实的 home 目录。

## 4.4 回归清单

- Pin 和 Archive 的行为、焦点恢复都不变，也就是 `SessionSidebar` 里 archive 之后的焦点逻辑。
- `/effort`、`/connect` 等现有的 TUI 本地命令不受新分支影响。
- 现有的 slash 命令补全和 `/help` 顺序不乱。
- `pnpm build` 中的 `prompt:check` 照常运行。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|---|---|---|
| 测试 | ../test.md 和本文的自动化用例全部通过 | `pnpm test:unit && pnpm test:integration && pnpm test:contract` |
| 构建 | `pnpm preflight` 通过，包括 format、lint、typecheck、test、build | 命令 |
| 资源一致 | 修改模板后，不重新生成就会让构建失败 | 手工改一下 `template.css`，再跑 `pnpm --filter ohbaby-agent build` |
| 内容完整 | 拿一个真实的、compact 过的会话导出 JSONL，消息数等于数据库里主上下文中可导出的消息数 | 用脚本对比 |
| 无泄露 | 哨兵测试 S3 通过：隐藏字段里的哨兵字符串，在解析后的 JSONL 和解码后的 HTML 数据里都找不到。S3b 通过：compact 摘要和中断提示仍然保留 | 自动化测试。不用 grep 关键词，因为会漏报，也会误报 |
| HTML 安全 | H1–H9 通过。在浏览器里打开，Network 面板没有自动发起的请求 | 测试加手工检查 |
| 大会话 | 用一个包含多张 MCP 图片的长会话（数据库中超过 20MB）导出 HTML 和 JSONL，记录耗时和后端内存峰值。结果写进 05。数值不能接受时，登记为下一轮候选 | 手工加脚本 |
| 三端可用 | 在 macOS 上用 TUI 和网页各导出一次。在 Linux 上验证中文下载目录。在 Windows 上验证 `C:\Users\<user>\Downloads` | 手工 |
| 文档 | `docs/commands/architecture.md` 里补上"TUI 本地执行命令" | review |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 会话内容里构造的 HTML 或 JS 在导出页面里执行 | 禁用原始 HTML、URL 白名单、escapeHtml。CSP 用了 `'unsafe-inline'`，**挡不住**注入的内联脚本，只能防止页面加载外部资源 | 将来升级 marked 后，配置可能失效。靠 H1–H3 测试兜住 |
| 构造恶意的 MCP 图片 data URI（SVG、非法 base64） | 只放行四种位图 MIME，base64 段严格匹配 | H7、H8 用例 |
| 通过 REST 导出别人的会话 | token 加已注册 client | 和 archive 一样，不校验工作区归属。本机单用户场景下可以接受，以后要上多用户时，archive 和导出一起收紧 |
| 内部数据被导出 | Collector 白名单式地映射字段，不做"整个对象复制" | 以后新增 part 类型时，默认不会被导出，需要显式加进映射 |
| 写文件覆盖用户已有的文件 | `wx` 加后缀 | 并发情况极少，`wx` 失败后会重试下一个后缀 |
| 文件名里出现路径穿越 | 文件名只由时间和 id 随机段组成，随机段只保留 `[A-Za-z0-9-]`。TUI 写文件时只取 basename | — |
