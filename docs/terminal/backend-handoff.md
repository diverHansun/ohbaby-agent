# Terminal 后端交接

## 分支与范围

- 基线：`04accf97`（包含实施前更新的设计文档）。
- 本地临时基线分支：`codex/terminal-temp`。
- 后端分支：`codex/terminal-backend-temp`，从临时基线分支创建。
- 本批包含 server 终端核心、REST/WebSocket、daemon Host 校验和停止清理、SDK 契约及测试。没有修改前端，不合并或推送；由用户验收后合并。

## 前端接入

SDK 的 `TerminalInfo`、`TerminalClientMessage`、`TerminalServerMessage` 以及协议、错误码和关闭码常量已导出。接口完整定义仍以 [dfd-interface.md](dfd-interface.md) 为准。

- `POST /v1/terminals`：发送 `{ cols, rows }`；目录头可选，无目录头时在主目录打开。服务端返回 `title`，前端不用计算主目录名。
- `GET /v1/terminals`：返回所有 workspace 尚未删除的记录，包括 `closing`、`close_failed`。这两种状态保留关闭入口，不接回终端。
- `DELETE /v1/terminals/:id`：忙时返回 409 `TERMINAL_BUSY`，程序名在 `error.process`；确认后带 `?force=1`。清理成功才返回 200，失败记录继续可查询、可重试。
- WebSocket：`/v1/terminals/:id/attach`；子协议为 `ohbaby.terminal.v1` 和 `ohbaby.bearer.<base64url(token)>`。不要把 token 放进 URL。
- 快照可能大于 2 MB，浏览器须按完整快照恢复，再处理后续输出。2 MB 是实时输出积压上限。输入的完整 JSON 编码仍不得超过 65,536 字节，前端须拆分长粘贴。
- HTTP 和 WebSocket 只在 loopback 模式开放，沿用现有 token；Host 校验同时保护首页和其他接口。

## 验证

环境：macOS 27.0.1、arm64、Node 24.20.0、pnpm 9.15.0。Linux、Windows 未验证，不因已有预编译包而视为通过。

可重复运行：

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run packages/ohbaby-server/src packages/ohbaby-sdk/src
pnpm exec tsc -b --pretty false
pnpm --filter 'ohbaby-server...' build
pnpm run lint
```

全仓库 `pnpm test`：654 个文件通过、6 个文件跳过；7,620 项通过、17 项跳过。跳过项属于仓库已有用例，本批新增终端测试没有跳过。全仓库 lint 为 0 错误、109 条既有警告；本批改动文件 lint 为 0 错误、0 警告，类型检查和后端及依赖构建通过。

后端与 SDK 回归：66 个文件、746 项测试通过，零跳过。真实 PTY 覆盖命令结果、中文、初始目录、尺寸、暂停后关闭、并发关闭、忽略挂断信号的 shell/子进程强制结束、端口释放、关闭失败后重试，以及已记录子进程在 shell 自然退出后的清理。模拟原生依赖加载失败的测试与真实 PTY 测试分开，加载失败不能让真实测试自动跳过。

真实 daemon/socket 覆盖新建、鉴权、Host/Origin、两种 workspace 模式、断开重连快照、超长分片输入拒绝、关闭及停止；真实 headless 覆盖备用屏幕恢复、输出/尺寸/快照顺序、大于 2 MB 的彩色快照。额外通过公开 `startDaemonServer` 启动编译产物，验证真实命令执行、快照、关闭 1000 和列表清空。

前端尚未实施，浏览器页面中的新建、标签恢复、复制粘贴、收起面板等交互未验收；由前端接入后按 [test.md](test.md) 完成。

## 审查修正与已知边界

子代理审查发现并修正了大快照被 2 MB 上限拒绝、自然退出直接删除记录而未清理已记录子进程的问题。初始快照现在单独发送；快照期间的增量输出仍受限，发送超时会断开查看者。自然退出现在先释放资源并清理已记录子进程，失败保留关闭入口。

自然退出仍有一个平台边界：在 macOS 上，用户输入 `exit` 后，此前未记录、已被系统重新托管的后台进程可能继续运行。点 `x` 主动关闭会在发送信号前记录子孙并清理，保证更完整。第一版按 KISS 不引入额外原生模块、辅助守护或轮询框架；这一限制不是“全面清理自然退出后台程序已经通过”。

主动关闭按进程归属判断，而不是按命令名判断；`nohup` 不保证脱离终端，因此仍属于该终端时会被清理。快照中鼠标编码和光标隐藏模式的原有局限保持不变。
