# 网络参考与取舍

## 来源

| 来源                    | 可验证依据                                                                                                                                                                                                                                                          | 本批用途                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ohbaby 已有系统代理模块 | [system.ts](../../../../packages/ohbaby-agent/src/utils/network-proxy/system.ts)、[policy.ts](../../../../packages/ohbaby-agent/src/utils/network-proxy/policy.ts)、[index.ts](../../../../packages/ohbaby-agent/src/utils/network-proxy/index.ts)，基线 `24c70034` | 直接复用系统读取、主进程路由、刷新与清理                                        |
| Pi                      | [utils/shell.ts](../../../../../pi/packages/coding-agent/src/utils/shell.ts)，本地 `6fb2e7815`                                                                                                                                                                      | 子进程环境以进程环境为基础；不另建 Shell 网络客户端                             |
| Kimi                    | [proxy.ts](../../../../../kimi-code/packages/agent-core-v2/src/_base/utils/proxy.ts)，本地 `5b936697670ed15444bcb4720bd91e6ee776a941`，L228 的 `proxyEnvForChild`                                                                                                   | 借鉴窄 helper、同值大小写与显式覆盖；不照搬失败后直连或未经验证的 Node 专用开关 |
| MCP TypeScript SDK      | 已安装 `@modelcontextprotocol/sdk` 1.29.0 的 `client/stdio.js`                                                                                                                                                                                                      | 默认仅继承有限变量，代理必须显式传入；保留其安全环境基线                        |
| curl 官方文档           | [Proxy environment variables](https://everything.curl.dev/usingcurl/proxies/env.html)，2026-10-11 核对                                                                                                                                                              | 小写 `http_proxy`、协议变量优先于 ALL_PROXY、NO_PROXY 的有限表达能力            |
| PowerShell 官方文档     | [Invoke-WebRequest](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-webrequest?view=powershell-7.5)                                                                                                                         | PowerShell 7 与旧版 5.1 的代理能力不能混为一谈                                  |

## 采用与调整

1. 采用普通子进程环境传递，保持原始命令；外部程序自行消费其支持的网络变量。
2. 主进程的静态系统代理发现继续由现有模块承担。给 Shell / MCP 补齐传递，而不是照搬参考项目的整个运行环境。
3. 对 curl 的真实行为编写 HTTP / HTTPS / CONNECT 集成用例。仅检查 env 字段不是完成验收。
4. MCP stdio 补代理变量时保留 SDK 原有环境基线和用户 `config.env`；不借机把全部父进程秘密变量复制给 MCP。

## 不采用

不引入本地转发代理服务器、流量透明接管、额外网络 daemon、对 curl / PowerShell 命令文本打补丁或自动重启已有进程。参考项目能继承 env，不代表能完整跟随系统 PAC / bypass，也不代表任何子程序都遵守代理。

本地 Claude Code 目录是第三方源码恢复项目，未用作官方网络实现的证据。OpenCode / Codex 的沙箱网络管理属于不同运行模型，不为本次 host-local 场景引入其完整隔离框架。

子代理在受控本地 HTTP 目标和代理上验证 curl 8.7.1：`no_proxy=::1` 直连，`::/0` 与 `::1/128` 仍经过代理。因此本轮不把 IPv6 CIDR 列为自动桥接支持项；正式验收仍按 04 执行。

以上取舍对应 [02](02-optimization-plan-and-change-scope.md) 的共享配置、薄环境构造及显式能力失败设计。
