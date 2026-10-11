# 网络配置现状与问题

> 基线：`24c7003448840fb4ba5acedb15d31456651e1466`。以下为现状，目标实现见 [02](02-optimization-plan-and-change-scope.md)。本次未修改产品代码。

## 问题清单

| ID  | 当前问题                                                  | 影响                                       | 证据                                                                                                                                     |
| --- | --------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | 系统代理只接管 Node 网络客户端，没有导出给子进程          | 主进程与 curl 使用不同配置                 | [installSystemProxy](../../../../packages/ohbaby-agent/src/utils/network-proxy/index.ts)，L36                                            |
| N2  | Bash 仅合并 `process.env` 和执行环境                      | 系统发现的代理不会随 spawn 传递            | [stateEnvironment / createBashTool / spawn](../../../../packages/ohbaby-agent/src/tools/bash.ts)，L63 / L95 / L197                       |
| N3  | MCP stdio 只传 `config.env`，SDK 默认继承列表没有代理变量 | 即使主进程显式配置代理，MCP 也可能没有拿到 | [createTransport](../../../../packages/ohbaby-agent/src/mcp/core/transport.ts)，L13；已安装 SDK `client/stdio.js`                        |
| N4  | 主进程与外部客户端解释 bypass 的语义不同                  | 同一字符串不一定产生同一路由               | [bypassMatcher](../../../../packages/ohbaby-agent/src/utils/network-proxy/policy.ts)，L73 / L139–145，系统来源仅额外规范化缩写 IPv4 CIDR |
| N5  | 主进程刷新闭包与子进程环境构造分离                        | 新进程无法取得已确认的当前配置 / 错误状态  | [refresh](../../../../packages/ohbaby-agent/src/utils/network-proxy/index.ts)，L66                                                       |

## 模块诊断

### 目标与职责

网络模块负责 ohbaby 自己发出的 HTTP / HTTPS 请求。Shell 和 MCP transport 负责启动外部程序。目前缺的是已确认网络配置的传递边界，不是缺少另一套系统代理发现器。

### 架构与数据模型

`system.ts` 读取 macOS `scutil --proxy` 或 Windows 当前用户 WinINet 配置；Linux 返回 discovery unavailable。`policy.ts` 计算显式环境 / 系统来源、代理端点和 bypass。`index.ts` 安装 Node http / https、undici、Axios 路由，并默认每 5 秒刷新系统配置。

`SystemProxyInstallation` 目前仅暴露 `dispose()`。子进程不能取得同一个刷新结果。显式代理变量在安装时读取为启动快照，不会因另一个终端执行 export 改变。

已有解析支持静态 HTTP / HTTPS，但 PAC、WPAD 与 SOCKS 的分支需要按平台区分。依据 [system.ts](../../../../packages/ohbaby-agent/src/utils/network-proxy/system.ts) L64–80 / L161–182：

- macOS 开启 PAC 或自动发现，直接返回 PAC 不支持。
- Windows 已配置或发现 PAC URL，返回 PAC 不支持；开启自动发现但没有 URL 时，`detectionError !== 12180` 返回 `System proxy discovery failed`。12180 表示没有发现 PAC，允许继续读取静态配置或使用无代理状态。
- 两平台均在 SOCKS 开启且静态 HTTP / HTTPS 任一缺失时拒绝。两项静态代理齐全时忽略 SOCKS，仅使用 HTTP / HTTPS；本机同时开启三项代理并不自动构成 SOCKS 错误。

这些分支没有下载或执行 PAC。执行系统读取命令失败另报 `System proxy settings could not be read`；平台解析错误在该 catch 之外，保留其具体原因。代理读取或解析失败会让外部 Node 请求失败，本地 loopback 仍可访问。

主进程对显式 `NO_PROXY` 与系统 bypass 复用 `bypassMatcher`；系统来源只额外接受并规范化 macOS 缩写 IPv4 CIDR。N4 指的是主进程与 curl 等外部客户端之间的差异：裸域、仅子域、通配、端口、`<local>`、IPv6 CIDR 等规则的解释并不一致，不能直接复制字符串就宣称路由相同。

### 数据流与用例

```text
CLI 启动 → installSystemProxy → 主进程 HTTP / fetch 客户端
工具执行 → stateEnvironment(process.env + context.env) → spawn Shell
MCP 连接 → config.env → SDK 的有限环境继承 → spawn server
```

主代理和 subagent 使用同一个 runtime 组合。Subagent 在 [SessionSubagentHost](../../../../packages/ohbaby-agent/src/agents/subagent-host.ts) L1551 创建进程内实例，调用同一工具入口，不是额外的 OS 进程。

此前调查用假系统代理地址初始化模块，随后启动子进程观察继承状态：父进程环境未改变，子进程没有继承发现的代理。该诊断不访问外部网络，不证明所有外部程序的兼容性。

### 非功能约束

系统代理读取已经有界，刷新已串行化；请求路径不执行系统命令。Shell 的环境覆盖不能反向污染全局 `process.env`。外部程序启动失败不应阻断 UI、本地读取或 bundled ripgrep。

环境继承不是网络隔离。`HostLocalAdapter` 声明 `isolation: none`，本议题不增加 OS 网络拦截，也不承诺控制不读取代理变量的程序。

### 测试现状

已有 network-proxy system / policy / index 及真实 SDK fixture；Shell 有 spawn、取消、后台生命周期测试；MCP 有 transport 与 client 测试。[system.unit.test.ts](../../../../packages/ohbaby-agent/src/utils/network-proxy/system.unit.test.ts) L56 / L94 / L99 / L107 / L133 分别覆盖 macOS 静态双协议与 SOCKS 共存、Windows 12180、PAC URL、discovery 失败和 SOCKS 独占；Windows 三协议共存、两平台单静态协议与 SOCKS 共存的矩阵尚未完整覆盖。缺少“同一配置 → 主进程请求与真实子进程请求”的贯通证据，尤其是代理刷新、显式 override、不可表达 bypass 和启动失败。

## 文档与代码对照

| 原文档                                                                                                                                                       | 代码现状                         | 本议题处理                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------- |
| [系统代理规划 §2.6](../../2026-10-01-system-proxy/improve-1/02-optimization-plan-and-change-scope.md) L109–111 明确 Shell / stdio 不受父进程 dispatcher 控制 | 与代码一致                       | 扩展这个边界，不推翻主进程路由               |
| 原规划把 PAC / SOCKS 的首版范围列作待确认                                                                                                                    | 静态协议混合与自动发现分支见上文 | 00 明确本次只自动适配静态 HTTP / HTTPS       |
| [MCP 架构](../../../mcp/architecture.md) 定义 transport 工厂和 workspace manager                                                                             | stdio 直接使用 config.env        | 实施时补启动环境契约，保留单 server 失败隔离 |

## SWE 判断

最小改法是让已存在的网络模块提供一份可读取的配置快照，再给 Shell / MCP 启动构造环境。复制系统读取器、写全局环境变量、让每个 subagent 管理代理都会制造重复状态。相反，把项目里所有 spawn 都改成通用代理执行框架，也超出真实需求。

本批承重边界是配置优先级、bypass 表达能力与启动生命周期。它们应在 02 明确、在 04 用真实子进程验证，不能用“已复制环境变量”代替效果验收。
