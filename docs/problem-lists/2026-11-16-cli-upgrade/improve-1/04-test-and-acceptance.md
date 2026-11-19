# 04 测试与验收

> 本文是实施会话自测和验收会话对照的依据。测试编号在 [02](02-optimization-plan-and-change-scope.md) 各 Stage 的完成定义里引用。脚本安装那一支的安装细节由[脚本安装议题的 04](../../2026-11-17-script-install/improve-1/04-test-and-acceptance.md) 覆盖，本文只验证 update 调用它的部分。

## 4.1 测试范围

| 层次 | 覆盖什么 | 放在哪里、怎么跑 |
|---|---|---|
| 单元测试（U） | 版本比较、缓存读写、提示文字、升级前检查的判断、设置文件、数据库反向检查、Web 自动刷新的节流 | 和源码放在一起，`pnpm test:unit` |
| 集成测试（I） | 启动时的提示、daemon 接口、停 daemon、从本地 registry 真实升级、数据库降级、Web 重连 | `tests/integration/cli/update.integration.test.ts` 等，`pnpm test:integration`；CI 三个系统都跑 |
| 实施前探针（P） | Windows 上 npm 版 update 替换自己时会不会失败 | 2026-11-18 已通过 SSH 在 Windows 台式机上执行，结果见 4.4 节末尾 |
| 真机验收（R） | 真实网络、真实终端、真实 Web 页面 | 实施完成后手工执行 |

## 4.2 单元测试

| ID | 场景 | 验证点 | 对应 Stage |
|---|---|---|---|
| U1 | 版本比较与提示 | 缓存里的版本更新时返回提示，相同或更旧时不返回；`0.1.20-beta.1` 不提示给 `0.1.19` 的用户；缓存文件不存在、不是 JSON、字段缺失时都不提示、不报错；`autoUpdate` 为 `true` 时提示里没有"--auto on"那句 | 1 |
| U2 | 后台刷新的时机 | 缓存未满 24 小时不发请求；满了才发；请求超时、返回非 200、返回内容不对都不写缓存、不抛错 | 1 |
| U3 | 关闭检查 | 设置 `OHBABY_NO_UPDATE_CHECK=1` 时不读缓存、不发请求 | 1 |
| U4 | 升级前检查：daemon 有任务 | daemon 返回非空的 `runs` → 不通过，原因里列出会话，且没有调用停止函数 | 2 |
| U5 | 升级前检查：旧 daemon | `/api/runs/active` 返回 404 → 不通过，提示用户确认后手动 `serve stop`，没有调用停止函数 | 2 |
| U6 | 升级前检查：其他进程 | Windows 且 npm 安装，进程列表里有别的 ohbaby → 不通过；只有自己、父进程和 daemon-state 记录的 daemon → 通过；非 Windows 或脚本安装 → 不检查进程 | 2 |
| U7 | 设置文件 | 不存在时 `autoUpdate` 为 `false`；`--auto on` 后为 `true`，并且没有查询版本、没有执行安装；文件损坏时按 `false` 处理 | 3 |
| U8 | update 的决策 | 安装方式为 `other` → 退出码 1 并给出命令；目标版本等于当前版本 → 退出码 0；非 TTY 且没有 `-y` → 不升级并提示 | 4 |
| U9 | 数据库反向检查 | `migration` 表多出一个未知版本 → 抛 `DatabaseNewerThanProgramError`，消息含该版本号；没有多出 → 照常迁移 | 5 |
| U10 | 迁移只增不减 | 测试里固定一份当前全部迁移版本的清单，`INITIAL_MIGRATIONS` 必须包含清单里的每一项（以后新增迁移时把新版本加进清单） | 5 |
| U11 | Web 自动刷新节流 | 第一次收到"服务已重启"时调用 `reload`；30 秒内再次收到时不调用，显示手动按钮；`sessionStorage` 抛错时不调用 | 6 |

## 4.3 集成测试

沿用 `packaging-smoke.integration.test.ts` 的打包和本地 registry（脚本安装议题的 C7 会把它们抽成共用函数）。在本地 registry 上发布两个测试版本，例如 `0.0.0-update.1` 和 `0.0.0-update.2`，用临时 `OHBABY_HOME`。

| ID | 场景 | 验证点 | 对应 Stage |
|---|---|---|---|
| I1 | 启动时的提示 | 缓存里写好新版本，启动 `ohbaby serve`：stderr 里有提示。把 `npm_config_registry` 指向一个不响应的端口：启动时间和不检查时相比没有明显增加，进程能正常退出 | 1 |
| I2 | daemon 接口 | 启动 daemon，跑一个会停住的任务：`/api/runs/active` 返回它；任务结束后返回空；不带 token 返回 401 | 2 |
| I3 | 检查通过后停 daemon | daemon 空闲时运行升级前检查：daemon 被停掉，`stoppedDaemon` 为真；daemon 有任务时：daemon 仍在运行 | 2 |
| I4 | npm 安装从旧版升到新版 | 用 `npm install -g --prefix <临时前缀>` 装版本 1，运行 `<前缀>/bin/ohbaby update -y`：`--version` 变成版本 2，输出里有"已升级到" | 4 |
| I5 | 升级时 daemon 在跑 | 版本 1 的 daemon 空闲运行中，执行 update：daemon 被停，升级完成，输出提示重新运行 `ohbaby serve`；之后用版本 2 运行 `ohbaby serve` 不再报版本不一致 | 4 |
| I6 | 自动升级 | `--auto on` 后，在缓存里写好版本 2，启动 TUI 入口（用非交互方式驱动）：完成升级、打印"请重新运行"、退出码 0。让升级前检查不通过：打印原因并照常进入 TUI。开关打开、缓存里有版本 2 时：启动 `ohbaby serve` 只提示不升级；设置 `OHBABY_NO_UPDATE_CHECK=1` 后启动 TUI 不升级 | 3 |
| I7 | 脚本安装分支的调用 | 用本地文件代替下载，替换成一个只记录参数和环境变量的假安装脚本：确认传入了 `OHBABY_INSTALL_VERSION`、`OHBABY_INSTALL_DIR`、`OHBABY_NON_INTERACTIVE=1`，Windows 上用的是 `powershell -NoProfile -ExecutionPolicy Bypass -File` | 4 |
| I8 | 降级被拦住 | 用临时数据库，手工往 `migration` 表插入 `999_future`，启动 `ohbaby run`：退出码 1，只打印提示消息、没有堆栈；`ohbaby update` 在这个数据库下仍然能运行到"确认"这一步 | 5 |
| I9 | Web 重连后自动刷新 | 在现有 Web 连接测试的基础上，模拟 daemon 重启后返回 401：页面调用了 `reload` | 6 |
| I10 | update 不加载原生模块 | 用 `node -r <钩子>` 运行 `bin.js update --help`，以及在本地 registry 上 `update -y` 到同一版本（走到"已是最新版本"），钩子包住 `process.dlopen` 并记录：两次都没有加载任何 `.node` 文件（做法同探针 P2） | 4 |

## 4.4 实施前探针（2026-11-18 SSH 执行）

| ID | 要确认的假设 | 怎么测 | 不符时怎么办 |
|---|---|---|---|
| P1 | Windows 上 npm 版 `ohbaby` 运行 `npm install -g` 替换自己所在的目录时，只要没加载原生模块就能成功 | 用 npm 装好当前发布的 `ohbaby-cli`；写一个小脚本，用同一个 node 从 `<前缀>\node_modules\ohbaby-cli` 里 import 和 update 命令同样会加载的模块（版本、代理、yargs），然后在这个进程里调用 `npm install -g ohbaby-cli@<另一个版本>`；记录是否报 EBUSY、EPERM，以及 `ohbaby.cmd` 结束时的输出 | 如果失败，update 在 Windows npm 安装上改为：把升级命令写进临时 `.cmd`，用 `start` 在新窗口运行后自己退出。更新 02 的 Stage 4 |
| P2 | `ohbaby` 启动时是否会立刻加载 koffi 或 node-pty | 在 Windows 上用 Process Explorer 或 `Get-Process -Module`（或用 Node 的 `process.moduleLoadList`）看 `ohbaby --version` 和 `ohbaby update --help` 进程加载了哪些 `.node` 文件 | 如果加载了，update 命令要放到加载原生模块之前分流，在 02 的 Stage 4 里注明 |

**执行结果（2026-11-18）**

机器：Windows 11 台式机，Defender 实时保护开启。用 npm 在临时前缀里装已发布的 `ohbaby-cli`，在 0.1.17 和 0.1.18 之间来回升级，各跑两遍。

| ID | 符合预期吗 | 实际结果 | 改了什么 |
|---|---|---|---|
| P1 | 符合 | 只加载 JS（含 yargs）的进程里执行 `npm install -g --prefix`：退出码 0，版本正确切换，包住它的 `.cmd` 在 node 退出后照常往下执行。另外试了加载 koffi 和 node-pty 的进程：升级同样成功、版本正确，但 npm 报 `EPERM` 删不掉旧的 `koffi.node`，留下一个 `.ohbaby-cli-XXXX` 残留目录 | 02 Stage 4 方案不变；注明 update 路径不能加载原生模块，新增 I10；残留目录写进 02 的 2.6 |
| P2 | 符合 | 用钩子包住 `process.dlopen`，`--version`、`--help`、`serve --help` 都没有加载任何 `.node` 文件 | 无。当时的发布版还没有 `update` 命令，用 `--help` 代替；实施后由 I10 检查 `update` 本身 |

没有直接测到的一点：P1 用的是自己写的 `.cmd` 包装，不是 npm 生成的 `ohbaby.cmd`。npm 的 `ohbaby.cmd` 用 `goto` 跳到不存在的标签来结束（npm 自带 `cmd-shim/lib/index.js:115`），运行中被替换也不会接着执行新内容；最后是否打印"找不到批处理文件"留给真机验收 R1 记录。

## 4.5 真机验收（实施完成后）

| ID | 验收项 | 通过标准 |
|---|---|---|
| R1 | 真实 npm 升级 | 在 macOS、树莓派、Windows 上，用 npm 版从上一个发布版本 `ohbaby update` 到新版本，三台都成功；Windows 上记录结尾是否打印"找不到批处理文件"，打印了也算通过 |
| R2 | 真实脚本安装升级 | 在三台机器的脚本安装上 `ohbaby update` 成功（与脚本安装议题的 R3 一起做） |
| R3 | 带着 Web 页面升级 | Web 页面开着、daemon 空闲时 update；重新运行 `ohbaby serve` 后，页面自动刷新并显示新版本，输入框里没发出去的草稿还在 |
| R4 | Windows 有其他窗口开着 | npm 版另开一个 TUI 后运行 update：被拦住，提示里能看出是哪个进程；关掉后再运行成功 |
| R5 | 代理环境 | 设置了代理的机器上，启动提示和 update 都能正常访问 registry |

## 4.6 回归清单

- 没有新版本、或关闭检查时，TUI、`run`、`serve` 的行为和启动时间与现在相同。
- `ohbaby run` 的输出里不出现新版本提示（脚本可能在解析它的输出）。
- `serve stop`、`serve status` 的行为不变。
- 数据库正常迁移路径不变：现有数据库测试全部通过。
- Web 连接断开但 daemon 没有重启时（"连接丢失"），仍然是自动重连，不刷新页面。

## 4.7 验收标准（发布门）

| ID | 标准 | 怎么验证 |
|---|---|---|
| A1 | U1–U11 通过 | `pnpm test:unit` |
| A2 | I1–I10 在三个系统上通过 | CI |
| A3 | 实施前探针 P1、P2 有结论，且 02 已按结论更新 | 已于 2026-11-18 完成，验收会话只需确认实现符合 02 Stage 4 的两点要求 |
| A4 | 真机验收 R1–R5 通过 | 验收会话记录每项结果 |
| A5 | 回归清单通过 | `pnpm test:integration`、`pnpm typecheck`、`pnpm lint` |
| A6 | 文档 | README 写明 `update`、`--auto`、`OHBABY_NO_UPDATE_CHECK`；`docs/cli/` 和数据库设计文档按 02 的 D2、D3 更新 |

## 4.8 对抗性审查要点

| 攻击面 | 可能出什么事 | 防御 | 残余风险 |
|---|---|---|---|
| 版本检查影响启动 | 网络卡住时 TUI 起不来或退不出去 | 后台执行、3 秒超时、`unref`；I1 | 无 |
| 停 daemon 打断任务 | 检查和停止之间刚好有新任务开始 | 检查和停止间隔很短 | 存在很小的时间窗口，本轮接受 |
| 数据库保护误拦所有用户 | 有人改名或删除了已发布的迁移 | U10 把已有迁移清单固定在测试里；D3 写进约定 | 无 |
| 降级后旧程序仍在运行 | 新版本迁移数据库时，另一个窗口里的旧版本还开着数据库 | update 先停 daemon；Windows 上检查其他进程 | macOS、Linux 上其他窗口里的旧版 TUI 不会被拦住，直到它重启。迁移大多是加表加列，风险较低 |
| 自动刷新丢东西 | 刷新时用户正在输入 | 草稿已存本地；30 秒节流 | 打开着的弹窗、滚动位置会丢 |
| 假的新版本提示 | registry 返回了奇怪的版本号 | 只接受合法的 semver，比较失败就不提示 | 无 |
