# 05 · 实施与验收记录

实施日期：2026-10-02。本地分支：`codex/system-proxy`。先创建分支并提交 00–04 规划文档（`66c28e77`），再修改产品代码。核心实现提交为 `81ce2069`；测试脚本、CI 与验收记录单独提交。没有 merge、push、修改系统代理或重启用户既有服务。

## 实际行为与改动

默认读取请求进程所在电脑、运行用户的系统静态 HTTP/HTTPS 代理。模型配置仍只选择目标 API；不识别 Clash、Shadowrocket，不写死端口，不维护 provider 分流名单。TUN 是操作系统路由，本实现无需识别它。

| 文件 | 实际职责 |
| --- | --- |
| `packages/ohbaby-agent/src/utils/network-proxy/system.ts` | macOS `scutil`；Windows 当前用户原生 WinHTTP 配置读取，经非交互 PowerShell 调用；明确报告不能解析的模式 |
| 同目录 `policy.ts` | env 覆盖、系统绕过、loopback、CIDR、简单主机名；只选择路线 |
| 同目录 `transport.ts` | Undici 与 Node HTTP(S) 共用策略；成熟库负责 CONNECT、TLS、连接池；退休旧池时保留在途流 |
| 同目录 `index.ts` | 显式安装、串行刷新、恢复原全局对象；导入 agent 不安装系统代理 |
| `packages/ohbaby-cli/src/bin.ts`、`packages/ohbaby-server/src/runtime/daemon/main.ts` | dotenv 后、首次 backend 请求前安装；run/TUI 结束或 fresh serve 关闭时释放；复用 serve、远程客户端、help/version/status/stop/ps 不重复安装 |
| `packages/ohbaby-agent/src/runtime/run-manager/error-detail.ts` | 提取有限、无环 cause 链中的网络错误码，不输出原始 URL、凭证或请求体；不修改重试策略 |
| `.github/workflows/ci.yml` | 原三平台矩阵加入网络集成测试；增加最低 Node 24.0.0 网络测试任务（尚未提交远端运行） |

普通 SDK 指 OpenAI、Anthropic、Tavily 等发起 HTTP 请求的客户端库。前两者默认使用 fetch，Tavily 使用 Axios/Node HTTP；因此只设置 fetch 不够。本实现覆盖它们的默认全局传输。Axios 还会在 Node 路由前自动读取环境并改写 URL；安装期间通过可撤销的默认实例 request interceptor 关闭这一步，让原始 URL 进入共享策略。Axios 依赖范围与 Tavily 保持一致，并用实际 SDK 测试约束共同实例；卸载时 eject interceptor。该兼容措施针对本包当前 ESM 加载的默认 Axios 实例，不声称覆盖外部 CJS 加载、axios.create() 或其他依赖副本。升级依赖必须重跑 SDK 行为测试。调用方显式提供 fetch/dispatcher/agent，以及 Tavily 的专用代理设置，仍保留自己的所有权，不被强行覆盖。

## 明确的兼容性契约

- `http_proxy` / `https_proxy` / `all_proxy` 优先于对应大写非空值。显式 HTTP/HTTPS/ALL 是完整覆盖；某协议没配置且无 ALL 时，该协议交给 OS 路由。只有 NO_PROXY 不会取消系统跟随。
- 环境取启动快照，保留既有 dotenv 优先级。Windows 在复制前按属性读取，保留 `process.env` 的大小写不敏感行为。不写回探测结果。
- env URL 必须含 `http://` 或 `https://`，允许凭证，拒绝非根路径、query、fragment 和未支持协议；诊断不显示 URL。没有 scheme 的值不会被猜成 HTTP。
- NO_PROXY 的域名规则选用 Axios 所依赖的 `proxy-from-env@1.1.0` 语义：裸域精确匹配，`.example.test` / `*.example.test` 匹配子域；同时绕过裸域与子域时写 `example.test,.example.test`。这不是所有客户端共同标准，Undici 当前 EnvHttpProxyAgent 的裸域语义不同。这里统一两种传输，避免 SDK 间歧义。
- 额外支持 IPv4/IPv6 **字面地址** CIDR、`<local>`、系统简单主机名标志、端口；系统 CIDR 接受 `169.254/16` 这样的缩写。不会 DNS 查询后再套用 CIDR；域名解析进私网的情况仍应显式列域名。畸形 CIDR/端口拒绝，不能扩大直连范围。
- localhost、127/8、::1、IPv4-mapped loopback 始终绕过应用代理。没有擅自绕过所有私网。
- 读取完成后再等待 5 秒开始下一次读取；单次系统命令上限 10 秒，无重叠、无逐请求系统命令。因此不是“系统变化后墙钟必定 5 秒内生效”，休眠/读取延迟需要额外时间。旧请求不重发、不强行终止；新请求使用已发布的新策略。
- 读取失败、无效配置、明确未支持模式：新外部请求阻断；loopback 保持可用，下一次成功刷新可恢复。不会沿用可能过期的直连策略或自动直连。
- 状态在 CLI/serve stderr 明确显示 system / environment / OS route / blocked；NO_PROXY=* 显示全绕过。这里的 OS route 可能包含 TUN，不等同物理直连。远端 Web 尚无独立常驻网络指示器，收到的是现有运行错误；服务策略来源看服务进程状态输出。
- 连接失败显示实际 `ECONNREFUSED`、`ENOTFOUND`、TLS 等安全错误码；不凭码断言是代理还是上游故障。启动状态可辅助判断路线。代理拒绝连接的测试确认不会转而请求 origin。

## 平台边界与剩余验收

| 平台/模式 | 本轮结果 |
| --- | --- |
| macOS 静态 HTTP/HTTPS | 已读取本机系统配置并完成真实 SDK、编译 CLI 请求；HTTP/HTTPS 与 SOCKS 同时启用且两个 HTTP 协议都有对应配置时正常工作 |
| Windows 静态 HTTP/HTTPS | 已实现当前运行用户读取及 fixture 测试；**尚无 Windows 实机证据，不能称为已经验收** |
| Windows 自动检测 | 原生发现 PAC URL 后明确阻断；12180 表示未发现 PAC URL，其余错误阻断；不是看到勾选就一律失败。PowerShell/C# 启动、WPAD 延迟、企业限制仍需实机验证 |
| PAC/WPAD 脚本、SOCKS-only | 检测并明确报不支持，不执行 PAC，不提供 SOCKS 传输；仍属于完整需求的能力缺口，不能把本轮称为全部系统代理兼容 |
| Linux/容器/WSL | 显式 env 或该环境自身 OS 路由；未实现 GNOME/KDE 设置读取，不声称自动继承宿主或客户端电脑 |
| MCP stdio / 任意子进程 / 自定义 SDK 传输 | 不接管存量子进程或显式传输；本轮范围为 ohbaby 进程内默认 HTTP(S) 请求 |

Windows 发布前应在真实用户环境验证：静态代理开/关与换端口、bypass、默认自动检测且无 PAC、有 PAC/发现超时、PowerShell 限制、代理不可达、流进行中切换和 daemon 退出。保留旧流期间旧代理若被用户关闭，连接仍可能失败，这是外部条件，不通过偷偷直连隐藏。

本机未切换实际系统设置或关闭 TUN。动态切换由两个真实本地 CONNECT 代理和可控系统读取器完成，不能冒充 macOS 设置面板切换实测。

## 测试结果

1. 基线 CLI/SDK retry：38 项通过；规划提交钩子 lint/typecheck 通过，已有 93 条 lint warning。
2. 新系统读取、策略、真实连接切换/故障、HTTPS SDK 与安全错误测试：53 项通过；加上 CLI/server 生命周期 56 项，共 109 项相关测试通过。fetch 与 Node HTTP 的在途流均有换代后继续读完的断言。
3. Node 24.0.0 最低运行时 41 项网络测试通过。当前开发机 Node 26.3.1 的 gzip、HTTPS 和切换场景按集成测试记录，不从 Pi 的 Undici 8 问题直接推断本仓 Undici 7 有相同问题。
4. `pnpm build`、typecheck 已通过；lint 为 0 error、93 条既有 warning。最终全仓回归：483 个测试文件通过、6 个跳过；5413 项测试通过、17 项跳过。
5. 真实 API：5/5 成功，Zenmux、智谱、Dashscope 三家 base URL；Chat Completions、Responses、Anthropic 三类接口；模型取自 `tests/models-4-tests.md`。实测连接 peer 是系统配置的本地代理，而不是只检查变量。见 [API 脱敏证据](./evidence/2026-10-02-real-api.json)。
6. 编译 CLI：隔离 OHBABY_HOME、数据库与工作目录后，三家 provider 的 `ohbaby run` 均退出 0 并输出 OK。见 [CLI 脱敏证据](./evidence/2026-10-02-real-cli.json)。临时目录已清理，无 key 写入报告。

复跑真实请求会产生 API 费用，需要显式 opt-in：

```sh
OHBABY_REAL_NETWORK_TEST=1 node --import tsx scripts/run-real-network-smoke.mjs
pnpm build
OHBABY_REAL_NETWORK_TEST=1 node scripts/run-real-network-cli-smoke.mjs
```

不要把独立 build 和全仓 tests 同时运行；CLI 集成测试内部会构建包。首次回归发现新增测试桩类型错误和旧 stderr 空断言，已修正；一次独立 build 与这些测试并行导致声明产物竞争，后续改为顺序执行。

## 审核取舍

使用 calling-pi-agent 调用了 `github-copilot/claude-sonnet-5.5`、medium、同一任务 session。Pi 两轮正文已完整展示给用户；第二轮专门复核 Axios 修补，结论是未发现新的阻塞问题。没有把意见当事实直接照做。Pi 无权读同级参考仓库；主代理重新读取了 Pi、OpenCode、Kimi 的相应源码，沿用 03 的证据范围。

- 保留参考项目的集中初始化、成熟 agent、loopback 保护，增加本需求必须的系统读取与换代；不引入通用网络框架。
- 接受并测试系统 CIDR 缩写、最低 Node 版本、Windows PowerShell 绝对路径；删除从未实际产生的代理错误标签，不误导为已区分代理/上游故障。
- NO_PROXY 保留与 Axios 兼容的精确/后缀契约，明确与 Undici 的差异。
- 不采纳“读取失败继续旧路线”或“忽略未知绕过规则”，因为已确认契约要求无法确认策略时阻断新外部请求。
- 保留一次启动来源提示，满足环境覆盖可见；不采纳隐藏所有正常启动状态的建议。
- Windows 周期性进程/原生编译开销记录为实机验收风险；没有为尚未测量的开销引入缓存层、常驻桥接服务或改成逐请求读取。
- 子代理已审核共享策略，修正启动快照、域名边界、畸形 CIDR/端口；HTTPS fixture 发现并修正 Node `agent:false` 构造器协议问题。
- 最终子代理发现并真实复现 Axios 改写原目标导致 Tavily loopback/CIDR 绕过失效；新增失败测试后在安装点修正。独立复核 SDK 集成测试已通过，保留显式 Tavily agent 和卸载恢复行为；没有把普通 Axios `config.proxy` 等同于拥有独立 agent。

发布结论：本轮静态代理实现及本机验证可供代码审查；Windows 原生验收和未支持协议仍保留上述边界。等待用户审查，不合并、不推送。
