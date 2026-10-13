# improve-2 实施与验收

实施日期：2026-10-12。接续 improve-1 提交 `8b78e5e3`，在同一工作目录的 `codex/improve-shell-glob-network` 分支开发。未合并、未推送。

## 实施范围

- Shell 使用 `web-tree-sitter` 与 Bash / PowerShell grammar 提取事实，命令原文仍交给实际系统解释器。分析不完整进入单次审批，真实语法诊断保留在系统 stderr / exit code 中。
- Windows 优先显式可用的原生 Shell，否则选择 pwsh / Windows PowerShell；macOS 默认 zsh；Linux 默认 bash / sh。取消自动探测 Git Bash，不在执行失败后换解释器重试。
- 权限链直接接收可信 `shellAnalysis`。默认权限下，分析不完整的命令不能被历史 allow 放行，也不能记忆 Always；deny 仍优先。主代理与子代理的审批归属保持根会话。
- 审批前固定原始命令、解释器、启动参数、cwd 与 commandPrefix；启动时再读取网络环境。准备来自实际 Bash 工具实例，支持注入依赖、无 environment 与内部直接调用。
- Glob 改为 bundled ripgrep 的 argv 调用与 NUL 路径协议，保留隐藏文件、忽略 ignore 文件、五类固定排除、不跟随内部 symlink、默认 100 项。数量限制观察到第 N+1 项才标记截断；展示只保留完整路径，并向模型传递扫描与展示的完整性字段。

两套 grammar 是精确版本的开发依赖，构建时复制 WASM 与许可证到发布目录；运行依赖只有 `web-tree-sitter`，不要求安装者编译 grammar。pnpm 9 使用精确包名单禁用这两个无用的原生安装脚本，不禁用其他依赖脚本。

## 删除与兼容性

已删除 `shell/analysis/light-parser.ts`、对应旧测试和整个 `utils/command-parser/`；有价值的 argv / 路径场景迁入新分析测试，通用 `matchesPattern` 留在 `utils/string-match.ts`。旧 Glob matcher / walker、10,000 文件遍历上限，以及自动探测 Git Bash 的遗留 helper 同步移除。

旧同步 `parseCommand` 及其类型 / barrel 导出不再提供。仓内消费者已迁移；需要分析能力的外部调用方应使用异步 `analyzeShellCommand`。没有保留兼容解析器或双 Glob 引擎。

## 审查与修正

独立子代理分别审查解析事实、权限与执行绑定、Glob 生命周期。发现的问题通过定向探针或真实进程复现后修正，包括 `>|` 风险分类、条件 / 失败 cd 的 cwd、wrapper 改目录、动态赋值、续行转义、规范化后的绝对 Glob 模式、长路径展示，以及短命 rg 的退出竞态。

Opus 5.5 的认证检查通过，但实际调用返回 `model_not_supported`，没有取得审查意见。经用户明确选择，另启动两个 `deepseek/deepseek-flash`、xhigh 实例分别审查 Shell 与 Glob。其意见按实证筛选：普通 `bash a.sh` 的下载执行拒绝原本有效；真实换行文件名能够被含换行的模式匹配，因此没有采纳禁止全部控制字符的建议。实际发现的 metadata 衔接与执行入口问题纳入回归。

Glob 没有新增通用进程或资源隔离框架。初版普通取消 / 限额停止等待进程 close 与进程树清理结果；Windows 的后续修正见下节。无法确认清理且仍未 close 时，标记已有资源 lease 为 unconfirmed，让后续冲突请求明确失败。close 后最终探测仍 unknown 时报告清理失败，沿用现有操作结束后释放资源的契约，不声称提供持久进程组隔离。

## 验证记录

真实模型端到端已通过（37.48 秒）：实际启动编译后的 CLI `serve` 子进程，使用真实 Zenmux `openai/gpt-5.6-luna` 与内存加载的 API key。主代理运行 `for` 循环，前台 generic 子代理运行命令替换，随后 Glob 匹配两个已知文件。

10 次 provider 请求中，按实际工具 call ID 核对：父 Bash 输出进入第 5 次请求，子 Bash 自身输出进入第 8 次请求，Glob 输出进入第 10 次请求，均为 `role:tool`。没有拿子代理总结代替子工具消息。父、子两次 default 审批来自不同 session，均归属主会话；选择项只有 `allow_once` / `reject`，没有 Always。凭证未写入日志或证据，脱敏结果在本地忽略目录 `.ohbaby/test-evidence/process-tools/shell-glob.json`。

```sh
OHBABY_RUN_REAL_PROCESS_TOOLS=1 OHBABY_REAL_PROCESS_BATCH=shell-glob pnpm exec vitest run --config tests/smoke/process-tools-real.vitest.config.ts
```

定向回归 29 个文件、386 项通过，覆盖解析、权限绑定、真实进程与 Glob；后续全仓检查发现两处测试夹具需要跟随可信准备流程迁移：清理测试改为等待实际 `source-cleanup` 事件，审批测试改用真实 Bash 工具准备与被拦截的执行函数。未削弱“两次独立审批、拒绝后不执行”等行为断言，没有为通过测试改动生产逻辑。清理场景重复 10 次通过；最终合并检查权限、执行绑定与清理，5 个文件、46 项通过，其中权限整文件 26/26 通过。

实际打包安装检查通过：无系统 rg 的环境中使用 bundled rg 执行 Grep / Glob，安装后可加载两套 grammar；缺失任一 grammar 时明确报告分析不可用，不悄悄使用旧解析器。最终 `pnpm build` 已通过。

最终全仓 `pnpm preflight` 整条命令返回 0：格式、lint、typecheck、测试、构建全部通过。测试为 526 个文件通过、6 个文件按配置跳过；5790 项通过、17 项跳过，无失败。lint 为 0 errors、109 项既有 warnings。单元、契约、集成、TUI 与安装包测试包含在本次全量运行中；真实模型端到端使用上面的独立命令执行。

`git diff --check` 通过。没有合并、推送或删除本地开发分支。

## 平台与验收边界

实际主机为 macOS。Windows / Linux 平台选择有模拟契约测试，但没有这两个系统的真机执行证据；PowerShell grammar 在本机可验证加载，不等于 Windows PowerShell 5.1 的输出编码已验收。后续平台检查继续依据 [04](04-test-and-acceptance.md)。

AST 分析、审批和进程内目录锁不构成操作系统沙箱。用户授权整条命令执行后，未知脚本的实际副作用仍属于原有执行边界。


## 2026-10-13 Windows CI 修正

[CI run 38256158721 / Windows job](https://github.com/diverHansun/ohbaby-agent/actions/runs/38256158721/job/114834664353) 的代码为 `206b011d`。完整日志共有 6 项失败（4 个文件）；Linux、macOS 和最低 Node 网络任务通过。这些失败来自本议题新增代码或测试，不能用此前 macOS 端到端成功替代 Windows 验收。

- 三项代理测试把 POSIX 的大小写双键输出当成全平台契约。Windows 实现本来只输出大写单键，避免环境变量的大小写冲突。修正空覆盖继承、全绕过为 darwin / linux / win32 三平台表格用例，Bash 启动测试按实际平台校验；不改变生产代理行为。
- 一项 Glob 测试在 Windows 创建含换行的文件名而失败。将真实换行文件名测试限定 POSIX，N 与 N+1 的截断判断拆成普通文件名的全平台测试。NUL 协议接收器仍在所有平台验证帧内换行。
- 两项 Glob 接收器测试揭示实际退出竞态：短命 rg 已经自然退出时，Windows `taskkill /t` 返回失败，覆盖原 UTF-8 错误或限额结果。只为固定 bundled rg 的 Windows 路径使用拥有的 `ChildProcess.kill()` 句柄，并等 `close` 后确认清理。固定 `--no-config --files` 参数不启动 shell、不使用 `--pre`、不加载用户配置，因此适用叶进程边界；不推广到通用 Shell。1 秒内仍未 close 会报告 unconfirmed 并保留现有资源限制，不能因 kill 返回 true 或 false 就提前确认。POSIX 进程组探测与共享 Shell 清理规则不变。

新 Windows 模拟契约覆盖 kill 成功但未 close、kill 返回 false 后自然 close、停止错误且暂未 close，以及协议错误不被停止错误覆盖。三个用例在修复前失败，修复后通过。旧 POSIX 不确定进程树契约保留；CI 三平台矩阵新增执行该契约文件。

定向验证：5 个文件、71 项通过；全仓测试为 526 个文件、5798 项通过，另 6 个文件、17 项按配置跳过。独立子代理复核未发现阻断问题。完整 `pnpm preflight` 返回 0，格式、lint（0 errors / 109 项既有 warnings）、typecheck、测试、安装包检查与最终构建均通过。本机仍为 macOS，此次本地模拟不能宣称新的 Windows runner 已通过；提交后的真实 Windows CI 需重新运行。

首次推送修复后的 [CI 38327642502](https://github.com/diverHansun/ohbaby-agent/actions/runs/38327642502) 中，Windows 与 Linux 单元测试均通过，原六个失败已消除；新加的清理契约步骤却暴露测试隔离缺口：模拟 POSIX 平台时，未隔离 bundled rg 路径解析，导致 Windows/Linux 试图加载 macOS 可选依赖。此契约本来使用虚拟进程，现同时模拟可执行文件定位；真实 rg 加载继续由 Glob 单元及安装包测试验证。本机将模拟平台改为 Linux 后复现 2 项失败，补齐隔离后相关 3 文件、19 项通过。
