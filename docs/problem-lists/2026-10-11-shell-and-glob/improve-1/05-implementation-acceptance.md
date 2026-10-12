# improve-1 实施与验收

实施日期：2026-10-12。基于 `main@e5067039`，在同一工作目录的本地分支 `codex/improve-shell-glob-network` 开发。未合并、未推送。

## 已实施

- `utils/network-proxy/index.ts` 保存显式安装时的代理环境与最近一次系统读取快照；刷新失败替换旧状态，dispose 清除状态。未安装的嵌入式调用只使用显式环境。
- `utils/network-proxy/child-environment.ts` 集中构造子进程代理变量，处理覆盖层、大小写、ALL_PROXY、系统绕过规则及脱敏错误；不修改全局环境，不新增代理服务器或 PAC 执行器。
- `tools/bash.ts` 在创建 job 前构造环境；失败时不启动进程，并保留原来的资源释放与执行标识优先级。
- `mcp/core/transport.ts` 将代理白名单与显式配置交给 SDK，保留 SDK 的安全默认环境；`mcp/core/client.ts` 将 client/transport 构造纳入连接失败清理。

自动继承仍严格执行已确认规则：系统 bypass 无法可靠表达时，新的 Shell/MCP stdio 启动失败。普通 `NO_PROXY` 不会取消这项检查；显式 HTTP/HTTPS 代理配置或明确的全绕过选择按既有约定生效。未改变系统设置，也不重启运行中的任务。

## 验证与审查

真实模型凭证只在测试进程内加载，不写入日志或本文件。

```sh
OHBABY_RUN_REAL_PROCESS_TOOLS=1 OHBABY_REAL_PROCESS_BATCH=network pnpm exec vitest run --config tests/smoke/process-tools-real.vitest.config.ts
```

此端到端测试已通过：实际启动编译后的 CLI `serve` 子进程，使用真实 Zenmux `openai/gpt-5.6-luna`。8 次 provider 请求内，父代理与前台 generic 子代理的 curl HEAD 请求均成功；两次默认权限 `allow_once` 审批来自不同 session，但共用主会话 rootSessionId。按各自实际 bash call ID 核对，父输出进入第 3 次请求、子输出进入第 7 次请求，二者均进入第 8 次请求的 `role:tool` 消息。没有用子代理的总结文字代替其实际工具输出。

脱敏机器证据保存在本地忽略目录 `.ohbaby/test-evidence/process-tools/network.json`，只记录预定义输出标记、状态及调用 ID 哈希。此前失败的测试脚本事件订阅、旧 Shell 预检误判均单独保留，未作为成功证据。

独立子代理审查已发现并推动修复两项问题：环境合并不能覆盖生成的 `OHBABY_*` 执行标识；IPv4 映射 IPv6 的系统绕过不能被当作普通 loopback 丢弃。后者经过真实 curl 的多种地址写法验证。

最终网络定向回归：11 个文件、155 个测试通过，含 18 项真实 HTTP/HTTPS CONNECT、curl、MCP stdio 集成测试。代理刷新、后台进程保留旧环境、MCP 重连、秘密变量不继承，以及代理错误时本地 Read/Glob/Grep 仍可用均有行为证据。

全仓检查发现一项既有 Web 测试同步问题。独立审查在 `git archive main@e5067039` 的临时源码副本中，单独选择 `command-lifecycle.integration.test.ts` 的标题测试，16 次均复现同一错误：客户端尚未获得运行任务标识就发起 abort。本批只给该测试补上等待对应 `sessionControl` 到达的条件；没有修改 Web 产品代码。

最终检查结果：

| 检查 | 实际结果 |
| --- | --- |
| `pnpm preflight` 的格式、lint、typecheck 阶段 | 通过；lint 0 errors，109 项既有 warnings |
| 修正测试同步后的全量测试 | 5745 passed；两组套件因诊断进程遗留的全局构建锁超时，7 项未运行；另 17 项按配置跳过 |
| 构建锁清理后的两组补跑 | `compiled-model-contract.integration.test.ts` 与 `prompt-process.integration.test.ts`，7/7 passed |
| 实际打包安装 | `packaging-smoke.integration.test.ts` 通过 |
| 最终 `pnpm build` | 通过，包含 agent、server、CLI 与 Web 产物 |
| `git diff --check`、独立生产代码复查 | 通过，无遗留阻塞发现 |

上述结果覆盖本批检查，但不宣称单次 `pnpm preflight` 整条命令返回成功；那次命令确实因测试构建锁超时退出非零。补跑后没有未执行的失败套件，也没有为通过检查改写生产代码的超时或兜底行为。

## 测试发现的既有 Shell 问题

真实模型测试触发 `curl -o /dev/null` 的旧预检误判：同一条 curl 的输出路径先被登记为下载文件，随后又被当作执行目标，导致“下载后执行”拒绝。已用 `parseCommand` 与 `preflightShellCommand` 单独复现，不需要真实网络。

该问题归入 improve-2 的 AST / 政策迁移：下载输出路径本身不代表执行，只有实际执行下载文件或下载后直接管道执行才触发相应拒绝。improve-1 的成功联网场景使用 curl HEAD 请求隔离网络行为，不将此替代用例作为旧预检已修复的证据。

## 平台边界

本轮可实际运行的主机为 macOS。Windows/Linux 的平台分支可做契约测试，但没有实际主机运行证据，不能据此宣称三个平台都已验收。后续平台验收继续依据 [04](04-test-and-acceptance.md)。
