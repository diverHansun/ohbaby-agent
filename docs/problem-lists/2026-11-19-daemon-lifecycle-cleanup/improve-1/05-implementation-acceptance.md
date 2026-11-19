# 05 实施与验收

2026-11-19 在本地分支 `codex/daemon-lifecycle-cleanup` 实施，基线为 `d52232b0`。实施按 [02 方案](02-optimization-plan-and-change-scope.md) 执行，验收按 [04 清单](04-test-and-acceptance.md) 核对。

## 实施结果

| 阶段 | 实际改动 |
| --- | --- |
| Stage 1 | 停机只保留一份 `daemon-shutdown.json`。`serve stop` 校验报告中的 PID 和 token，读取不到匹配的新文件时兼容旧格式。状态写入各用独立的临时文件，失败后尽力移除自己的文件。停止中的状态发布按顺序执行。总时限到达时如果仍有写入，保留 PID 锁并结束停机，当前实例不发布报告。 |
| Stage 2 | 独占创建 PID 锁的快路径保留。确认旧持有者已退出后才尝试接管。持有 `.recovery` 锁时重读并验证旧记录，只有一个进程能接管。新记录刚创建仍为空时短暂等一次。拿到 PID 锁才清扫旧报告和临时文件，并按旧状态记录警告。 |
| Stage 3 | 启动提示调用与 daemon 相同的 `resolveOhbabyHome()`。实际由 CLI 组合入口把已加载的解析器传给提示逻辑，符合 CLI 的运行时加载约束。Web 和 TUI 界面未改动。 |

这轮沿用已有状态文件、停机观察和 JSONL 日志。恢复锁只保护过期 PID 锁接管，日常启停仍走原路径。固定文件名的停机报告在释放锁之后写入，因此实例快速换代时，缺失或身份不匹配的报告仍按清理未知处理。

释放锁时也核对持有者。文件已不存在可以完成释放，锁文件损坏或读取失败会产生 `pid.release` 错误，停机报告将清理标为未确认。

如果另一个进程正在接管过期锁，启动最多等待约 2 秒，并在等待期间重读 PID 文件。发现已接管的 daemon 后提示它正在运行。接管锁持续存在或 PID 文件持续损坏时，启动错误给出路径，并提示仅在确认同一目录的 daemon 既未运行也未启动时手动移除对应文件。自动清扫保留接管锁。

## 自动化验收

| 用例 | 结果 |
| --- | --- |
| U1–U4 | 验证单份报告和 POSIX 权限、新旧报告匹配、并发临时文件互不影响以及清扫范围。 |
| U5–U6 | 验证旧状态警告、损坏或缺失状态的启动容错、清扫失败警告，以及未取得锁时跳过读旧状态和清扫。 |
| U7 | 验证自定义 `OHBABY_HOME` 和显式 home 参数的优先级。 |
| U8 | 分别卡住 `stopping` 和最终状态写入，验证停机在时限内失败、保留锁且不写报告。模拟旧实例退出后，新实例能够发布并保有自己的 `running` 状态。 |
| I1–I3 | 真实子进程验证固定报告、异常退出后的诊断事件和双进程接管同一过期锁。发布中的空锁与存活检测失败在 PID 文件单测中验证。 |

macOS arm64、Node.js 24.20.0。最终全量单测通过 5,421 项，跳过 2 项。TypeScript 检查、全仓构建、改动文件的 ESLint 和 Prettier 检查通过。最后的审查修订后重建 server，复跑了 11 项停机集成测试和 R1–R5。

首次全量集成通过 2,511 项，跳过 12 项，失败 1 项。[Side Chat 历史回退用例](../../../../packages/ohbaby-agent/src/adapters/side-chat-runtime.integration.test.ts)在第 698 行读到后台进程仍存活。候选分支与基线各复跑 16 次均通过。只在测试中将终止进程树的动作延迟 500 毫秒，复现了同一断言失败。

第一次回退在测试中被模拟为立即返回“清理未确认”，而进程退出由另一条异步路径完成。现在断言轮询等待进程退出，保留对第一次历史不变和第二次回退成功的检查。延迟注入下的复现用例通过，撤掉注入后 Side Chat 整组 18 项通过。Side Chat 的运行时代码未改动。

针对 PID 锁提示、Side Chat 及 daemon 停机集成的联合复跑通过 38 项。

候选提交 `0166a486` 在 macOS 上复跑 `pnpm test:integration`，通过 2,512 项，跳过 12 项。Side Chat 整组 18 项包含在此次全量结果中。

跨平台修订后的候选提交 `31ff1a5c` 在 macOS 上以 `CI=true` 和 `GITHUB_ACTIONS=true` 再跑全量集成，通过 2,512 项，跳过 12 项。

Windows 真机上，基线 `d52232b0` 的终端 HTTP 和 PTY 集成有 16 项失败，其中部分夹具使用 POSIX shell 命令和进程组语义。调整后的 Windows 用例继续实际执行终端命令，验证 UTF-8、工作目录、窗口尺寸、退出和资源清理。依赖 POSIX 进程组、会话和 SIGHUP 的断言仍在 POSIX 系统运行。daemon 的正常停机夹具改用带认证的 HTTP 停机请求，避免 Windows 将 Node 的 SIGTERM 当作强杀，并按实测放宽了 Windows 子进程夹具的启动上限。

这些验收夹具调整未改动产品行为。Windows 真机分组复跑通过 daemon 多进程 11 项、终端 HTTP 12 项和原生 PTY 3 项，其中与 POSIX 进程组相关的 10 项跳过。macOS 对本轮涉及的 6 个文件复跑通过 74 项。

GitHub Actions 首轮全量集成在 Ubuntu 发现 15 项失败，在 macOS 发现 29 项失败。共同问题包括交互式 Ink 用例在 CI 下进入非交互模式、模型发现测试依赖任务调度顺序，以及历史查询超出 SQLite 变量上限。交互夹具明确启用交互，模型发现用例等到旧任务暂停后再启动新任务。用户同意修复历史查询，两组 ID 改为分别绑定 JSON 数组，继续检查 40,001 个 ID 的场景。用变量上限为 32,766 的 SQLite 复现了旧查询失败，并验证新查询返回正确的匹配行。

另外，Linux 的进程名与 macOS 不同，PTY 测试用 PID 验证子进程归属。针对托管 macOS runner 的实测调度延迟调整了测试夹具预算，保留 SQLite 锁期间的响应断言、持久化顺序和停机失败报告检查。Windows 的手动压缩用例先等摘要 provider 进入，再从取消时开始计时。Web 的目标命令用例等待输入区可以提交后再按回车。验收补丁覆盖的两次本地分组复跑分别通过 46 项和 73 项。

Windows 首轮全量集成有 71 项失败，另有一个打包测试文件在准备阶段失败。剩余的 Windows 专属问题包括测试清理前仍打开 SQLite 文件、在 JSON 字符串中直接查找带反斜线的路径，以及 Node 无法直接执行 `pnpm.cmd`。停机观察确认 PID 已退出后，测试还需要等 Node 子进程的退出事件才读取退出码。修订保留了原有持久化、路径、打包启动和退出断言。

Windows 真机上额外指定 Git Bash 复跑会话存储用例时，沙箱销毁后重建曾报 `SandboxContextAlreadyExistsError`。标准 Windows CI 的会话存储用例通过，R1–R3 使用 Windows 原生控制台和 CLI。

## macOS 终端验收

| 用例 | 结果 |
| --- | --- |
| R1 | 将本机 68 份旧报告和 3 份空临时文件复制到临时 `OHBABY_HOME`。编译后的 CLI 启动时清掉 71 份残留，收到 SIGINT 后只保留状态和停机报告。原目录保持原样。 |
| R2 | 再启动并停止三次，其中一次使用 `ohbaby serve stop`，另两次使用 SIGTERM。每次退出码为 0，停机后文件数保持为 2。 |
| R3 | 强制结束本次启动的 daemon，再启动该配置目录下的新实例。实读 JSONL，确认恰有一条 `server.previous_run.unclean` 对应旧进程 PID，旧状态为 `running`。 |
| R4 | 在独立临时 npm 前缀安装发布版 `ohbaby-cli@0.1.18` 并运行 daemon。新版 CLI 停止旧 daemon，输出 `daemon stopped`，退出码为 0。磁盘上仍存在旧格式报告。 |
| R5 | 在独立 PTY 里启动编译后的 TUI，确认能看到相同临时 `OHBABY_HOME` 下的 daemon 共存提示。 |

所有烟测进程均已退出，测试使用临时配置目录、SQLite 文件和本机临时端口。

## Windows 真机验收

Windows 11 台式机，Node.js 24.20.0。从候选提交 `0166a486` 构建 CLI，使用独立 `OHBABY_HOME`、SQLite 文件和本机临时端口。

| 用例 | 结果 |
| --- | --- |
| R1 | 放入 68 个模拟旧报告和 3 个空临时文件。CLI 启动清掉 71 个文件。向独立 Windows 控制台发送原生 `CTRL_C_EVENT` 后，进程以 0 退出，只留下状态和停机报告。 |
| R2 | 再启动三次，每次用 `ohbaby serve stop`。三次命令都输出 `daemon stopped` 并以 0 退出，目录始终只有两个文件，报告的 PID、token 与目标实例相符，清理状态为 `confirmed`。 |
| R3 | 用 `taskkill /F /PID` 强制结束测试进程。下一次启动的 JSONL 中恰有一条 `server.previous_run.unclean`，对应上次的 PID 和 `running` 状态。 |

## 实施审查

Pi 使用 `anthropic/claude-opus-5-5` 和 `high` 思考强度审查源码与测试，未发现阻塞项。Pi 沙箱无法执行工作树的 `git diff`，改为直接读修改文件。审查建议已落实到遗留接管锁提示、状态写入完成时的归属检查，以及空 PID 文件、探测不明和下一实例接管的测试。

最终复审核对了释放损坏 PID 锁的处理和对应测试，未发现新增阻塞项。

Pi 再用 Opus 5.5 高思考强度核对了 SQLite 查询及 TUI、PTY 和模型发现夹具，未发现需要更改的行为。Windows 原生 PTY 用例验证 shell 退出，不覆盖 POSIX 的后台进程组回收。其他用 Node SIGTERM 结束 Windows 子进程的夹具应视为强制退出，Windows 的正常停机证据来自真实 Ctrl+C、CLI stop 和 HTTP 停机用例。

## 发布验收状态

macOS 终端 R1–R5、Windows 真机 R1–R3、本议题的自动化场景及本地全量集成均通过。

候选提交 `31ff1a5c` 的跨平台复跑中，Ubuntu 集成 2,511 项通过、13 项跳过，Windows 集成 2,485 项通过、39 项跳过。macOS 集成 2,511 项通过、12 项跳过，唯一失败是打包烟测重做工作区构建超过 180 秒。该 job 的前置 `pnpm build` 已成功。[三平台复跑](https://github.com/diverHansun/ohbaby-agent/actions/runs/44505217413)

候选提交 `8943208c` 的 CI 给打包与命令记录烟测传入已有的构建复用开关，使用当前 job 生成的产物，继续执行 npm 打包、安装、导入和 CLI 启动断言。单独跑打包烟测时仍自行构建。本机先跑 `pnpm build` 再在 CI 环境复用产物，打包与命令记录烟测共通过 3 项。[构建产物复用的三平台结果](https://github.com/diverHansun/ohbaby-agent/actions/runs/44511624594)

该候选的 macOS 和 Ubuntu 通过。Windows 第一次有 2,484 项通过、39 项跳过，唯一失败是并行 SQLite 写入预算用例超时。用同一提交单独复跑时，预算用例仍失败。目标运行与子代理唤醒未在轮询时限内落库，后台子代理会话与转录用例也超过了整条用例的时限。

预算测试现在直接比较共享预算实际扣除量与两笔并行写入的总耗时，继续使用真实 SQLite 锁。持久化测试继续断言相同的运行、投递和重开结果，将终态轮询时限设为 5 秒，整条用例时限设为 30 秒。相关两个文件在本地 CI 环境复跑共通过 66 项。候选提交 `d301b851` 的 [完整矩阵](https://github.com/diverHansun/ohbaby-agent/actions/runs/44522733635)在 Windows 上通过 2,485 项集成、跳过 39 项。用户指出的三条失败均通过。Ubuntu 也通过。macOS 剩余一条停机锁用例在正确拒绝写入后，实际用时 223 毫秒，超过夹具原设的 180 毫秒上限。

候选提交 `bfde2335` 保留 80 毫秒停机预算，将独立持锁时间拉长到 800 毫秒，并在拒绝写入后直接确认 SQLite 仍被锁住。两条停机预算用例在本地和三平台 CI 都通过。最终候选的 TypeScript、ESLint、构建和测试均通过，Windows 的完整运行再次通过用户指出的三条用例。[最终三平台 CI](https://github.com/diverHansun/ohbaby-agent/actions/runs/44527534489)

| 系统 | 全量单测 | 全量集成 |
| --- | --- | --- |
| macOS | 5,422 通过，2 跳过 | 2,512 通过，12 跳过 |
| Windows | 5,411 通过，12 跳过 | 2,485 通过，39 跳过 |
| Ubuntu | 5,418 通过，6 跳过 | 2,511 通过，13 跳过 |

发布验收通过。合并前撤回本次专用的 CI 配置，保留通过验收的源码和测试。macOS 和 Windows 真机的临时测试文件已清理。早期失败见 [首轮 CI](https://github.com/diverHansun/ohbaby-agent/actions/runs/44497646990)和 [中间复跑](https://github.com/diverHansun/ohbaby-agent/actions/runs/44501462967)。
