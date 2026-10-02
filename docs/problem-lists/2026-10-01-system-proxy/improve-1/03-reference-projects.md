# 03 · 参考项目与平台依据

采样日期：2026-10-01。以下是用户提供的本地源码快照，不是对上游最新版本的承诺。相邻仓库链接在 `code-cli` 目录结构下可用；文档中保留 commit 以便异机复核。

## 3.1 项目比较

| 项目/基线 | 已核对实现 | 采用与不采用 |
| --- | --- | --- |
| Pi `5fd446ca1`（2026-09-25） | [http-dispatcher.ts](../../../../../pi/packages/coding-agent/src/core/http-dispatcher.ts)：`applyHttpProxySettings`、`configureHttpDispatcher`；启动时安装 EnvHttpProxyAgent/global dispatcher，并注意 fetch 与 Undici 版本一致；特殊传输另有 [node-http-proxy.ts](../../../../../pi/packages/ai/src/utils/node-http-proxy.ts) | 采用集中安装、兼容性验证；不把它误读成已经支持系统设置动态跟随 |
| OpenCode `16c56fe5ec`（2026-09-24） | [desktop sidecar.ts](../../../../../opencode/packages/desktop/src/main/sidecar.ts)：`ensureLoopbackNoProxy`、`useEnvProxy`，调用 Node `setGlobalProxyFromEnv`；CLI/Bun 与桌面 Node 不同 | 采用运行时现成能力、本地绕过；不照搬 Node API 而忽略 ohbaby 的最低版本 |
| Kimi Code `be7d5f5fe`（2026-09-24） | [proxy.ts](../../../../../kimi-code/packages/agent-core-v2/src/_base/utils/proxy.ts)：`installGlobalProxyDispatcher`、HTTP/SOCKS、NO_PROXY 与子进程环境；[main.ts](../../../../../kimi-code/apps/kimi-code/src/main.ts) 启动接入 | 采用单点初始化和协议差异显式化；不假定环境继承能让存量子进程热切换 |
| ZCode `29628c9`（2026-09-24） | [desktopNetworkPolicy.ts](../../../../../ZCode/packages/desktop/src/main/desktopNetworkPolicy.ts) 区分 API 和内嵌浏览器；[agentProxyEnv.ts](../../../../../ZCode/packages/services/src/runtime-tools/agentProxyEnv.ts) 为 Agent 构建显式环境；[nodeApiNetwork.ts](../../../../../ZCode/packages/services/src/providers/api/nodeApiNetwork.ts) 适配 Node Host | 借鉴 Electron/Node/子进程不是同一个网络边界；它的多种独立策略比 ohbaby 当前目标复杂，不整体照搬 |
| DeepSeek Harness `477b4f4205`（2026-09-24） | [install.ts](../../../../../deepseek-harness/packages/util/http-proxy/src/install.ts)：启动安装和清理全局策略；[policy.ts](../../../../../deepseek-harness/packages/util/http-proxy/src/policy.ts) 分离纯策略；[模块 README](../../../../../deepseek-harness/packages/util/http-proxy/README.md) 强调真实出口测试 | 采用纯策略与有副作用的安装分离、实际 SDK 出口验证；[用户文档](../../../../../deepseek-harness/docs/user/guide/network-proxy.zh.md) 明确不读取操作系统代理，不能直接满足 U1/U3 |

归纳仅限本次核对路径：多数通过启动环境配置进程级代理，没有共同的“给所有业务层注入 NetworkRuntime”模式；没有证据表明这些模型请求主路径普遍实现了跨 OS 系统代理热跟随。ohbaby 的附加需求应单独实现和验收。

## 3.2 官方平台资料

| 来源 | 核对事实 | 对 02 的约束 |
| --- | --- | --- |
| [Node http.setGlobalProxyFromEnv](https://nodejs.org/api/http.html#httpsetglobalproxyfromenvproxyenv) | 24.14.0/25.4.0 加入，配置全局 agent/dispatcher，提供恢复函数 | 不能覆盖当前全部 >=24.0.0 支持区间；热切换与旧流清理仍须实测 |
| [Undici EnvHttpProxyAgent](https://github.com/nodejs/undici/blob/main/docs/docs/api/EnvHttpProxyAgent.md) | 支持代理环境和 bypass；不同参数有不同读取时机 | env 更新不等于完整原子策略切换，需测试所有目标传输 |
| [Microsoft：WinINet 配置用于 WinHTTP](https://learn.microsoft.com/en-us/windows/win32/winhttp/setting-wininet-proxy-configurations-in-winhttp) | 当前用户设置与服务账户配置不同；自动代理按请求处理 | Windows 不能仅取机器 WinHTTP 配置当桌面用户配置；服务身份必须明确 |
| [Microsoft：WinHttpGetProxyForUrl](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpgetproxyforurl) | 自动代理针对 URL 求值；存在下载脚本、脚本错误、发现失败等独立失败 | PAC/WPAD 不是静态地址，失败不能当作未配置代理 |
| [Apple：CFNetworkCopyProxiesForURL](https://developer.apple.com/documentation/cfnetwork/cfnetworkcopyproxiesforurl(_:_:)) | 按 URL 和设置返回有序代理结果，可能返回自动配置 URL；不自动查询 Keychain 凭证 | 单次配置读取不等于 PAC 执行和完整认证；系统候选与应用自造 fallback 要区分 |
| [GNOME 代理配置](https://wiki.gnome.org/DevGnomeOrg%282f%29Gnome3PortingGuide%282f%29ProxyConfiguration.html)、[KDE 代理配置](https://docs.kde.org/stable_kf6/en/kio-extras/kcontrol6/proxy/proxy.pdf) | 桌面环境有自身配置入口 | Linux 的支持范围须按 provider 界定，不能套一个 Windows/macOS 式开关 |
| [Mihomo 运行模式](https://wiki.metacubex.one/en/config/general/#operation-mode)、[规则](https://github.com/MetaCubeX/Meta-Docs/blob/main/docs/config/rules/index.en.md) | 存在 rule/global/direct 模式及按规则的出口选择 | 交给代理软件的流量不等于全部经远程节点；ohbaby 不复制分流名单 |

Apple 正文通过其官方 Markdown 表示核对；一般代理 API 的存在不等于现成 npm 封装已经满足维护、打包、许可和热更新要求。本轮未选定原生依赖。

## 3.3 明确不照搬

- 不因 Pi/Kimi 主要依赖 env，就删掉用户已确认的系统跟随目标。
- 不因 ZCode 区分多个出口，就给 ohbaby 每个模型、workspace 加网络设置。
- 不因 DeepSeek Harness 有独立包，就为 ohbaby 新建完整网络 workspace 包。
- 不把浏览器系统代理、Node 默认网络、子进程和 OS TUN 当成同一层。
- 不复制参考项目的自动直连 fallback；U4 要求本产品明确报告失败。

## 3.4 对方案的影响

集中启动接入形成 D1；参考项目的运行时差异形成 D4 和最低版本验证；真实 SDK 出口测试形成 D7 与 04 T11/T12；平台官方语义形成 Windows 用户身份、PAC、Linux 能力边界和按 URL 决策要求。


## 3.5 本轮复核边界

用户指定的 Pi 调用使用 `github-copilot/claude-sonnet-5.5`。Pi 沙箱未能读取三个相邻参考仓库，因此它关于这些仓库的判断不能替代本文件源码证据；主代理和后续子代理分别核对了相关文件。外部意见经真实请求和本地受控探针校正，事实更新见 01 §1.7。

尤其不能照搬 Kimi 对无效代理配置回退 direct 的行为；本需求要求明确报错。也不能从“Node 有统一代理 API”直接推导出 CIDR、简单主机名、blocked 状态及连接池清理都已解决。
