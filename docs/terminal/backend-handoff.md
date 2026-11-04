# Terminal 后端交接

> 用户要求自然退出也必须清理所属后台进程。已补上按系统会话归属清理的实现；真实 `sh`、`zsh`、daemon 接口回归及子代理审查均已通过。

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

首批后端提交 `7b7f5354` 的全仓库 `pnpm test`：654 个文件通过、6 个文件跳过；7,620 项通过、17 项跳过。跳过项属于仓库已有用例，本批新增终端测试没有跳过。全仓库 lint 为 0 错误、109 条既有警告；本批改动文件 lint 为 0 错误、0 警告，类型检查和后端及依赖构建通过。

自然退出修正后的完整后端与 SDK 回归：67 个文件、759 项测试通过，零跳过。真实 PTY 覆盖命令结果、中文、初始目录、尺寸、暂停后关闭、并发关闭、忽略挂断信号的 shell/子进程强制结束、端口释放、关闭失败后重试，以及未提前检查的多个后台进程在 shell 自然退出后的清理。新增检查覆盖查询能力失败时不启动 shell、清理查询失败可重试、判空前复查和会话编号不重新接纳。真实 daemon 回归同时确认记录删除、端口可重新绑定，并让另一个终端实际执行命令证明不受影响。模拟原生依赖加载失败的测试与真实 PTY 测试分开，加载失败不能让真实测试自动跳过。

真实 daemon/socket 覆盖新建、鉴权、Host/Origin、两种 workspace 模式、断开重连快照、超长分片输入拒绝、关闭及停止；真实 headless 覆盖备用屏幕恢复、输出/尺寸/快照顺序、大于 2 MB 的彩色快照。额外通过公开 `startDaemonServer` 启动编译产物，验证真实命令执行、快照、关闭 1000 和列表清空。

本次自然退出修正也完成后端及依赖构建、类型检查和改动 TypeScript 文件的 lint/格式检查。子代理独立审查通过，并额外运行真实 sh/zsh 自然退出验证；上述 759 项为主代理最终完整运行结果，不包含按名称过滤的审查命令。

前端尚未实施，浏览器页面中的新建、标签恢复、复制粘贴、收起面板等交互未验收；由前端接入后按 [test.md](test.md) 完成。

## 审查修正与已知边界

子代理审查发现并修正了大快照被 2 MB 上限拒绝、自然退出直接删除记录而未清理已记录子进程的问题。初始快照现在单独发送；快照期间的增量输出仍受限，发送超时会断开查看者。自然退出先释放资源并完成进程清理，失败保留关闭入口。

自然退出补充修正：此前 macOS 仅靠父子关系和终端设备名，会漏掉 shell 退出后已被系统接管的后台程序。现在借鉴 deepseek-harness 的 Linux 进程会话归属做法，Linux 读取 `ps` 会话 ID，macOS 通过系统自带 JXA 调用 `getsid` 查询，同一终端中不同进程组的后台任务也能找到。macOS 新建前先验证查询能力，失败拒绝新建；关闭时查询失败保留记录，不当作进程已清空。未增加依赖、编译步骤或常驻辅助进程。首次查空后再完整复查一次，避免普通进程交接时提前完成；确认会话为空后停止跟踪，发送信号前仍核对进程启动身份。该实现面向普通终端任务，不提供对连续高速派生、退出或无限重建进程的完整收容保证。macOS arm64 已实测，Linux、Windows 和 macOS x64 未实测。

主动关闭按进程归属判断，而不是按命令名判断；`nohup` 不保证脱离终端，因此仍属于该终端时会被清理。快照中鼠标编码和光标隐藏模式的原有局限保持不变。
