# 讨论记录与已确认要点

> 2026-11-16 开始与用户逐项讨论，每确认一项就更新本文。推理过程见 01，实施方案见 02。

## 1. 背景与动机

项目接下来要做 App 端适配，做完才做内置浏览器。现在用户升级只能自己手动执行 `npm i -g ohbaby-cli`。升级之后，如果旧版 daemon 还在跑，启动时会直接报版本不一致，用户得自己先运行 `ohbaby serve stop` 再 `ohbaby serve`。用户希望在 App 适配之前补上升级机制：可以手动升级，也可以自动升级。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 先后顺序 | 先做 npm 版 CLI 的升级，再做 App 适配。App 自己的更新跟 App 适配一起做 |
| 分发划分 | npm 包 `ohbaby-cli` 负责 TUI 和 Web。App 是单独的安装包，跟 TUI、Web 分开 |
| 运行方式 | TUI 在自己的进程里运行，不走 daemon；Web 由 daemon 提供。Web 和 App 不能同时使用 |
| 升级入口 | 只有 CLI 命令 `ohbaby update`，同时升级 TUI 和 Web。不在 TUI 里提供升级操作，Web 也不提供升级按钮 |
| 自动升级 | 做成可选开关，默认关闭，默认只提示有新版本 |
| 新版本检查 | 启动时先读本地缓存决定是否提示，再在后台刷新缓存，不拖慢启动 |
| 升级与 daemon | 升级前先检查 daemon 上有没有正在运行的任务，再停掉 daemon |
| 数据库版本保护 | 本轮一起做：程序发现数据库里有自己不认识的、更新版本的迁移时，拒绝启动并提示升级 |
| Windows 文件占用 | 升级前检查有没有其他 ohbaby 进程在运行，有就提示用户先关掉 |
| Web 刷新 | daemon 重启后，页面重连时如果发现版本变了，自动刷新整页 |
| App 预留约束 | 只在文档里写约束，不写代码：升级只重启 npm 自己启动的 daemon，不能停掉 App 的后端 |

## 3. 已确认：边界

| 项 | 处理 |
|---|---|
| App 的更新 | 放到 App 适配议题。已定方向：桌面端默认只提示、不下载 |
| curl（macOS、Linux）和 Windows 安装脚本 | 2026-11-17 改为提前做，拆到独立议题[脚本安装](../../2026-11-17-script-install/README.md)，不再等 Node SEA。本议题的 `ohbaby update` 要按安装方式分支，脚本安装这一支怎么升级由那个议题定 |
| 远程强制最低版本 | 不做，项目没有下发策略的后端 |
| 在 TUI 里升级 | 不做 |

## 4. 已确认：与关联议题的关系

| 议题 | 关系 |
|---|---|
| [多进程同开一个会话的占用规则](../../2026-11-10-multi-process-session-ownership/README.md) | 两边都处理"多个进程共用一个 SQLite"。本议题只管不同版本之间的数据库保护，不管同版本下的会话占用 |
| [脚本安装（curl 与 PowerShell）](../../2026-11-17-script-install/README.md) | 那边定安装脚本、安装目录、从 npm 切过去的迁移和 `ohbaby uninstall`；本议题的 `ohbaby update` 识别出脚本安装后，按那边定的方式升级。update 和 uninstall 共用"判断安装方式"的代码 |
| App 端适配（尚未开题） | 承接 App 更新、App 与 npm daemon 的共存规则、独立可执行文件打包 |

## 5. 逐项讨论中确认的决定

| 日期 | 决策项 | 结论 |
|---|---|---|
| 2026-11-17 | 命令名 | 用 `ohbaby update`，不加 `upgrade` 别名。原先定的 `ohbaby upgrade` 作废 |
| 2026-11-17 | curl 和 Windows 安装 | 拆成独立议题，提前做，见第 3 节和第 4 节 |
| 2026-11-17 | 按安装方式分支 | `ohbaby update` 先按自己 `package.json` 的位置判断安装方式：脚本安装就重新运行安装脚本，npm 全局安装就执行 `npm install -g --prefix <前缀> ohbaby-cli@<版本>`（前缀从自身路径反推），其他方式只提示命令、不代为执行。细节见[脚本安装议题 5.2 节和 5.9 节](../../2026-11-17-script-install/improve-1/00-discussion.md) |
| 2026-11-19 | 版本来源 | 直接请求 `<registry>/ohbaby-cli/latest`。registry 取 `npm_config_registry`，没有就用 npmjs.org；3 秒超时，走已装好的代理。不调用 `npm view`，不查 GitHub Releases，不解析 `.npmrc`。只在 `.npmrc` 里配了镜像、又连不上 npmjs.org 的用户看不到提示，接受（02 的 2.2 节） |
| 2026-11-19 | 缓存位置与间隔 | `<OHBABY_HOME>/update/check.json`，只记上次检查时间和最新版本。启动时只读缓存；超过 24 小时才在后台刷新，结果下次启动才用上（02 的 2.2 节） |
| 2026-11-19 | 关闭检查 | 环境变量 `OHBABY_NO_UPDATE_CHECK=1`：不读缓存、不提示、不发请求，自动升级也不触发；手动 `ohbaby update` 不受影响。`ohbaby run` 本来就不检查（02 的 2.2 节） |
| 2026-11-19 | 自动升级开关 | `<OHBABY_HOME>/update/settings.json` 的 `autoUpdate`，默认 `false`，文件缺失或损坏按关闭处理。用 `ohbaby update --auto on/off` 修改，只改开关不升级；新版本提示里告诉用户这个参数。不建通用设置文件，不放数据库，不和 `check.json` 合并（02 的 2.2 节） |
| 2026-11-19 | 自动升级的时机 | 只在启动 TUI、界面加载之前，开关已开、缓存显示有新版本、升级前检查通过时才升级，不再确认；成功后提示"已自动升级到 x，请重新运行 ohbaby"并退出。不满足或失败就打印原因，照常进入 TUI。不在后台边用边升级，不自动重启自己，`serve` 启动时只提示不升级。daemon 空闲时会被停掉，Web 页面断开到用户重新运行 `ohbaby serve`（02 的 2.2 节） |
| 2026-11-19 | 升级后的 daemon | 不自动重启，只提示"daemon 已停止，需要时重新运行 ohbaby serve"。daemon 目前只在终端前台运行，由 update 拉起会变成后台进程，等于引入新的运行方式；后台 daemon 以后要做就单独开题（02 的 2.2 节） |
| 2026-11-19 | 升级模块的设计文档 | 不单独建 `docs/cli/upgrade/`。实施后在 `docs/cli/goals-duty.md`、`docs/cli/architecture.md` 里补上版本检查与 `update` 命令（02 的 D2）；数据库设计文档写明迁移只能追加（02 的 D3） |
