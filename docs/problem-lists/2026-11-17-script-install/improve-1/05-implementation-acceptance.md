# 05 实施与验收

2026-11-19。实施分支为 `codex/cli-install-upgrade`，基线为 `55cc2bf0`。本轮安装、更新、卸载共用同一份 CLI 和 Web 构建产物。公开发布验收待发版执行。

## 实施与规划对照

| 阶段 | 实施结果 | 证据 |
| --- | --- | --- |
| Stage 1 | CLI 从真实包路径识别脚本或全局 npm 安装。Windows 检查 npm 生成的 `ohbaby.cmd`，因此默认前缀和自定义前缀即使没有自己的 `npm.cmd` 也能使用维护命令。 | [安装方式](../../../../packages/ohbaby-cli/src/install/install-method.ts) |
| Stage 2 | 两份脚本校验并安装私有 Node.js 24.22.3，锁定安装目录，试跑新版本后更新 `current`。更新保留前一版本。 | [POSIX 安装脚本](../../../../packages/ohbaby-cli/install.sh)、[PowerShell 安装脚本](../../../../packages/ohbaby-cli/install.ps1) |
| Stage 3 | npm 安装由原 npm 前缀卸载，脚本安装先清理自己的 PATH 设置。Windows 脚本版退出后由用户执行最终删除命令。发现目标包含用户主目录、配置目录、数据目录或数据库时拒绝删除。 | [卸载入口](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.ts) |
| Stage 4 | 同一 npm 包内含两份安装脚本、CLI 和 Web 资源。安装指南和发版步骤已更新，CI 的三平台任务已接入安装和打包验收。 | [发版检查](../../../ohbaby-cli/tui-productization/npm-packaging.md)、[CI](../../../../.github/workflows/ci.yml) |

POSIX 脚本在切换前准备启动文件，在版本生效后发布到固定位置。这样用自定义目录安装时，若停机检查失败，原有启动文件仍可访问旧版本。Windows 脚本拒绝将目录联接或符号链接当作安装根，确保安装和卸载找到同一个锁。两个脚本继续各自使用系统提供的脚本运行环境，共用版本指针、锁和启动方式。

## 验收证据

| 环境 | 已验证 | 边界 |
| --- | --- | --- |
| macOS arm64 | 在 PATH 上没有 Node 的隔离环境中，通过管道安装公开的 `ohbaby-cli@0.1.18`。Node 24.22.3 下载、校验、安装和启动通过。测试路径包含中文、空格和单引号。 | 本轮候选包的公开安装地址随 npm 发布生效。 |
| Ubuntu 24.04.5 arm64 树莓派 | PATH 上没有 Node。脚本校验官方 Node 归档，从隔离 npm 缓存安装公开的 `ohbaby-cli@0.1.18`，启动脚本正确返回版本。 | 直接下载超时。成功试验使用暂存的官方归档、校验清单及从公共 registry 准备的 npm 缓存。 |
| Windows 11 / PowerShell 5.1 | 官方 Node 归档和本地 registry 验证首次安装、重复安装、三次版本切换、失败回退、daemon 与安装锁拦截、中文和空格路径、代码页 936 及 `irm \| iex`。使用临时注册表值验证 PATH 增删和 `REG_EXPAND_SZ` 保留。 | 实际用户 PATH 保持隔离。npm 上游命令启动脚本在前缀含 `&` 时有已知限制。 |
| 本地自动化 | POSIX 安装器集成测试通过，覆盖校验、失败恢复、daemon 身份、版本清理和 shell 配置。Windows 安装器用独立 Windows 测试环境验收，CI 将执行同一测试场景。 | 跨平台 CI 结果和公开 jsDelivr 地址的验收等待发布流程。 |

可复现入口见 [安装集成测试](../../../../tests/integration/cli/install-unix.integration.test.ts)、[Windows 集成测试](../../../../tests/integration/cli/install-windows.integration.test.ts) 和 [npm 打包测试](../../../../tests/integration/cli/packaging-smoke.integration.test.ts)。更多更新与 daemon 停机证据见 [CLI 更新验收](../../2026-11-16-cli-upgrade/improve-1/05-implementation-acceptance.md)。
