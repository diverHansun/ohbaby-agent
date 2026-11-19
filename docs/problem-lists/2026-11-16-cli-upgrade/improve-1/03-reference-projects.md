# 03 参考项目借鉴

> 本文只记录在本地源码里核实过的做法。路径相对于上级目录 `code-cli/` 下各项目的根目录，行号是 2026-11-18 调研时的快照。安装脚本和安装目录的做法见[脚本安装议题的 03](../../2026-11-17-script-install/improve-1/03-reference-projects.md)，本文只写升级和版本检查。

## 3.1 借鉴来源

| 项目 | 调研范围 |
|---|---|
| claude-code | `update` 命令、启动和定时检查、自动升级开关、安装方式识别 |
| codex | `codex update`、版本缓存、按安装方式升级、后台服务的自动升级与重启 |
| opencode | `upgrade` 命令、`autoupdate` 三档设置、npm 前缀反推 |
| kimi-code | `upgrade` 命令、CDN 版本文件、自动安装、安装锁 |
| pi（minimax-code 内置同一套代码） | `pi update`、每次启动检查、自管安装的自更新、会话格式版本 |
| Step-Code | 独立二进制的自更新、跳过某个版本 |

新增核对的本地源码还包括 dsh 桌面 Host（`39163dd30f7`）和 ZCode Server CLI（`fec97590`）。两者分别提供任务接收保护和等待停机的参考。

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|---|---|---|---|
| 各家 | 先识别安装方式，再用对应的包管理器或重跑官方安装器；识别不了只给提示（codex `tui/src/update_action.rs:10-68`，claude-code `src/utils/doctorDiagnostic.ts:46-128`，Step-Code `step/local-update.ts:48-53`） | ohbaby 同时有 npm 和脚本两种安装 | **采纳**（Stage 4） |
| codex | 独立安装在 Unix 重跑 install.sh，在 Windows 跑 install.ps1（`update_action.rs`） | 和 ohbaby 脚本安装的升级方式一致 | **采纳** |
| opencode | 从自身路径反推 npm 前缀，升级时加 `--prefix`（`services/updater.ts:178-193`） | nvm 或多个 Node 并存时，PATH 上的 npm 不一定对 | **采纳** |
| codex | 版本检查结果缓存在 `version.json`，20 小时后才重查；可以关掉启动检查（`tui/src/updates.rs:27`、`:38`） | ohbaby 定了"启动读缓存、后台刷新" | **采纳**：24 小时 |
| kimi-code | 版本请求 3 秒超时（`cli/update/cdn.ts:12`、`:67`） | 网络差时不能卡住 | **采纳** |
| 各家 | 都有一个关闭检查或自动升级的环境变量：`DISABLE_AUTOUPDATER`（claude-code `src/utils/config.ts:1743-1751`）、`OPENCODE_DISABLE_AUTOUPDATE`（`updater.ts:608`）、`KIMI_CODE_NO_AUTO_UPDATE`（`preflight.ts:541`）、`PI_SKIP_VERSION_CHECK` | CI 和离线环境需要 | **采纳**：`OHBABY_NO_UPDATE_CHECK` |
| opencode | `autoupdate` 可设 `true`、`"notify"`、`false`，默认 `"notify"`（`updater.ts:127-141`、`:205`） | 和 ohbaby"默认只提示、自动升级可选"一致 | **采纳**：只保留开和关两档，关就是只提示 |
| opencode、kimi-code、claude-code | 检查和安装加锁：opencode 用 Semaphore(1)（`commands/handlers/default.ts:62-83`），kimi-code 有安装锁（`install-lock.ts:144`），claude-code 有 5 分钟锁（`src/utils/autoUpdater.ts:161-194`） | 防止两个进程同时升级 | **改造采纳**：脚本安装由安装脚本的锁负责；npm 安装由 npm 自己处理并发，CLI 不另加锁 |
| codex | 后台服务装完新版后，只有版本真变了才重启，带优雅退出等待（`app-server-daemon/update_loop.rs:441-495`、`lib.rs:565`） | ohbaby 升级也要处理 daemon | **改造采纳**：ohbaby 的 daemon 是用户前台启动的，只停不重启 |
| kimi-code | native 版先把新文件放好，下次启动时再换上（`native-swap.ts:475`） | 避免替换正在运行的文件 | **改造采纳**：自动升级放在 TUI 加载前做，做完让用户重新运行 |
| dsh | 限制新请求、等待已接收请求、检查后台作业并要求确认正常退出（`apps/desktop-host/src/update-tasks.ts:16,28`、`apps/desktop/src/host-process.ts:373`） | 查询和停止之间仍可能接到新任务，进程退出也可能缺少清理证明 | **采纳**：同一次仅空闲停机请求内检查，停机结果用现有报告确认 |
| ZCode | `stopSupervisorAndWait` 等待本次的新停机状态和锁释放，活锁下身份无法确认就失败（`packages/zcode-server-cli/src/runtime/shutdownWait.ts:28,90`） | 升级需要确认本次停机，旧状态和 HTTP 应答都不足以放行 | **采纳**：继续用 ohbaby 的 PID、token、退出观察和清理结论 |

## 3.3 明确不借鉴

| 做法 | 来源 | 不借鉴的原因 |
|---|---|---|
| 自动升级默认打开 | claude-code、kimi-code、codex 后台服务 | 00 已定默认关闭；ohbaby 升级要停 daemon，默认打开会打断用户 |
| 运行中每隔一段时间检查一次 | claude-code 每 30 分钟（`src/components/AutoUpdater.tsx:194`），codex 后台服务每 60 分钟 | ohbaby 的 TUI 会话一般不会持续很多天，启动时检查足够 |
| 远端下发最低、最高版本，灰度强制升级 | claude-code（`autoUpdater.ts:70`、`:107`），kimi-code（`forced.ts`） | 项目没有下发策略的后端（00 第 3 节） |
| 跳过某个版本 | Step-Code（`local-update.ts:168`、`:242-259`） | 提示只有一行，不打扰；需要时再加 |
| 每次启动都同步查询 | pi（`utils/version-check.ts:97`） | 会拖慢启动，ohbaby 用缓存 |

## 3.4 数据库版本保护没有先例

调研的项目里，没有一家会因为数据比程序新而拒绝启动。pi 的会话格式有版本号（`core/session-manager.ts:41`），只做旧数据迁移，遇到更新的版本不拒绝（`:341`）。

ohbaby 坚持做这项保护，理由来自自己的情况：

- ohbaby 用一个 SQLite 数据库存所有会话，迁移会改表结构，旧程序按旧结构写入可能破坏数据。
- 脚本安装和 npm 安装可以并存，用户很容易在不知情时运行旧版本。

因为没有先例，04 专门测降级场景（U9、I8）。

## 3.5 对 02 方案的影响

- 按安装方式分支、npm 前缀、版本缓存、超时、关闭检查的环境变量：直接来自参考项目，几家做法一致。
- 自动升级默认关闭、只在启动时检查、升级后不重启 daemon：参考项目有不同做法，ohbaby 按 00 的决定和自己的运行方式取舍。
- 数据库保护：没有先例，理由见 3.4。
