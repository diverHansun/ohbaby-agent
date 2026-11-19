# 05 实施与验收

2026-11-19。实施分支为 `codex/cli-install-upgrade`，基线为 `55cc2bf0`。本轮包括 TUI 和 Web 使用的 CLI 升级机制。公开发布验收待发版执行。

## 实施与规划对照

| 阶段 | 实施结果 | 证据 |
| --- | --- | --- |
| Stage 1、3 | 本地 TUI 与 `serve start` 读取版本缓存。正常启动后在后台刷新。本地 TUI 的自动更新在启动运行时前执行，远程 TUI 显示缓存提示。 | [启动入口](../../../../packages/ohbaby-cli/src/bin.ts)、[版本检查](../../../../packages/ohbaby-cli/src/update/version-check.ts) |
| Stage 2 | 升级和卸载共用 daemon 预检，停机前暂停接受新工作，等待已经接收的提交登记，并核对进程身份和清理结果。后台任务、持久队列、打开的 Web 终端和仍在创建的工作区纳入检查。 | [CLI 预检](../../../../packages/ohbaby-cli/src/update/preflight.ts)、[daemon 预检](../../../../packages/ohbaby-server/src/runtime/daemon/stop.ts) |
| Stage 4 | `ohbaby update` 支持最新版和指定版本。脚本版先下载目标安装器，再进行停机检查。npm 版通过原前缀安装并确认版本。 | [更新命令](../../../../packages/ohbaby-cli/src/cli/commands/update.ts) |
| Stage 5 | 运行时发现未知的已执行迁移会拒绝打开数据库。CLI 显示升级指引，维护命令仍可执行。 | [数据库迁移](../../../../packages/ohbaby-agent/src/services/database/index.ts) |
| Stage 6 | 主 Web 页面在 daemon 重启后自动刷新，同一标签页 30 秒内最多一次。打开的 Side Chat 有未发送草稿时保留手动刷新入口。 | [Web 重连](../../../../apps/ohbaby-web/src/api/daemon/client-sync.ts) |

更新和卸载复用同一预检。CLI 组合入口沿用延迟加载方式，普通 TUI 继续只加载本地运行所需的模块。停机请求与身份检查绑定，已接收任务有时间完成登记，拒绝停机后继续接收任务。

## 验收证据

- 本机 `pnpm build`、`pnpm typecheck` 和 `pnpm lint` 通过。全量 Vitest 以 6 个 worker、最多重试 1 次运行，共 8,735 项通过，30 项跳过。上一轮高并行运行中的 PTY 尺寸测试超时，单独复跑 12 项通过，本轮全量复跑也通过。
- 聚焦测试覆盖版本比较与缓存、TUI 开关、脚本更新未生效和已生效的失败处理、数据库迁移历史、Windows 进程扫描、daemon 权限和忙碌检查。CI 在三个系统运行安装相关集成场景。
- 本机浏览器连接打包后的 Web 界面。输入一条草稿后，在同一端口停止并重启 daemon，验证页面产生了新的加载时间，且输入框草稿完整保留。
- 旧版 daemon 手动停机后的重试、停机报告、并发任务准入和新实例拦截均有自动化覆盖。npm 更新、卸载、原生模块加载探针及新数据库保护由 [打包测试](../../../../tests/integration/cli/packaging-smoke.integration.test.ts) 验证。
- 公开 npm 和 jsDelivr 发版后的多机更新验收、Windows 双终端使用发布产物的更新验收待完成。脚本的物理环境测试见 [脚本安装验收](../../2026-11-17-script-install/improve-1/05-implementation-acceptance.md)。
