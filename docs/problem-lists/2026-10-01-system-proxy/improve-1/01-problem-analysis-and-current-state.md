# 01 · 现状与问题分析

分析日期：2026-10-01。源码基线：`637f3ca3dc000f7421c7ff7b541f4d061208ec74`。这不是实施进度记录。

## 1.1 故障证据与结论边界

本会话前序诊断记录：本地健康检查正常；安装版 ohbaby 的同一 Zenmux 模型调用直连约 32.9 秒后失败，底层出现 `UND_ERR_CONNECT_TIMEOUT`；显式启用 Node 环境变量代理后约 2.5 秒成功。系统当时有本地代理设置，服务进程没有相应代理环境变量。

这些结果支持“当前请求链路没有采用系统代理”，不证明所有 timeout 都是代理问题，也不证明该端点在所有网络都必须经过代理。后续用户授权后，本轮进行了下述最小真实请求探针；它们不是跨平台产品验收。截图中的 3 秒失败与前序约 33 秒复现是不同请求。

## 1.2 代码锚点

以下链接相对仓库定位；行号是当前基线快照，定位以符号为准。

| 位置 | 当前行为 | 证据 |
| --- | --- | --- |
| CLI 入口 | 先加载运行环境，再注册执行命令；未见统一系统代理初始化 | [bin.ts](../../../../packages/ohbaby-cli/src/bin.ts)，L655，`loadRuntimeEnvIntoProcessEnv` 调用 |
| 环境加载 | 已有进程环境优先；项目 `.env` 后加载全局 `.env`，均 `override:false` | [project-env.ts](../../../../packages/ohbaby-agent/src/utils/project-env.ts)，L35，`loadRuntimeEnvIntoProcessEnv` |
| 模型入口 | 创建 provider 时传 API key/base URL 等，不提供系统代理解析器 | [client.ts](../../../../packages/ohbaby-agent/src/core/llm-client/client.ts)，`createLLMClient` |
| OpenAI compatible/Responses、Anthropic | SDK 构造主要配置 key 和 base URL | [openai-compatible.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts)，L443；[openai-responses.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-responses.ts)，L168；[anthropic.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/anthropic.ts)，L682 |
| 模型探测 | 使用 fetch，需纳入实际出口验证 | [context-window-probe.ts](../../../../packages/ohbaby-agent/src/config/llm/context-window-probe.ts) |
| MCP | HTTP/SSE 配置 headers；stdio 启动独立进程，传入 `config.env` | [transport.ts](../../../../packages/ohbaby-agent/src/mcp/core/transport.ts)，L13，`createTransport` |
| Tavily | 内部支持 `defaults.proxy` 并传给 SDK；存在独立传输策略入口 | [tavily.ts](../../../../packages/ohbaby-agent/src/services/search-providers/tavily.ts)，L40，`createTavilyProvider` |
| 错误 | 外层状态码/错误码参与分类，SDK 包装的连接原因未充分呈现 | [retry.ts](../../../../packages/ohbaby-agent/src/core/llm-client/retry.ts)，L103；[error-detail.ts](../../../../packages/ohbaby-agent/src/runtime/run-manager/error-detail.ts)，L84 |
| 生命周期 | CLI 可以独立运行；serve 有单独服务器生命周期和清理路径 | [main.ts](../../../../packages/ohbaby-server/src/runtime/daemon/main.ts)，`createServerRuntime`、`startDaemonServer` |
| 运行时约束 | CLI/agent/server 声明 Node >=24.0.0 | [CLI package.json](../../../../packages/ohbaby-cli/package.json)、[agent package.json](../../../../packages/ohbaby-agent/package.json)、[server package.json](../../../../packages/ohbaby-server/package.json) |

## 1.3 七维现状诊断

| 维度 | 现状 | 缺口 |
| --- | --- | --- |
| 目标与职责 | 业务配置、SDK 适配、运行入口已有分层 | 没有集中承担操作系统代理读取与生效的责任点 |
| 架构 | 多包；TUI 进程与 serve 进程各有入口；一个 serve 服务多个项目 | 把进程级代理放到会话/项目初始化中会产生相互覆盖 |
| 数据模型 | 模型配置、环境变量和 SDK 专有配置分散存在 | 没有“来源、有效策略、读取失败、能力缺失”的统一运行状态 |
| 数据流与接口 | `.env` → SDK 参数/默认传输 → 外部 API；错误再被归一化 | 环境变量加载不等于代理启用；底层原因在 UI 中不充分 |
| 用例 | 能配置多个模型端点、搜索、HTTP/stdio MCP | 未统一验证开关代理、切换端点、切换网络与服务常驻的组合 |
| 非功能性 | 保持 SDK 封装有利于维护；跨平台产品已经有路径适配 | 新方案必须控制刷新开销、清理旧连接、保留流式输出、避免记录凭证 |
| 测试 | 已有 SDK 重试集成测试、CLI 单测与 daemon 集成测试 | 测试代理配置值不足以证明真实出口；缺少此次系统跟随的跨 OS 证据 |

相关既有测试：[sdk-retry.integration.test.ts](../../../../packages/ohbaby-agent/src/core/llm-client/sdk-retry.integration.test.ts)、[bin.unit.test.ts](../../../../packages/ohbaby-cli/src/bin.unit.test.ts)、[global-single-serve.integration.test.ts](../../../../packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts)。本轮只分析，不宣称重跑了这些测试。

当前 [CI](../../../../.github/workflows/ci.yml) 已有 Ubuntu、Windows、macOS 矩阵，使用浮动 Node 24。缺口是本议题的系统代理用例和精确最低版本验证，不是仓库完全没有跨平台 CI。

## 1.4 承重问题

| ID | 问题 | 影响 | 02 回应 |
| --- | --- | --- | --- |
| P1 | 环境读取和网络生效脱节 | UI 正常但模型请求直连失败 | §2.1、Stage 1 |
| P2 | 没有系统代理跨平台语义 | 在本机偶然可用，换用户/Windows 失效 | §2.4、Stage 2 |
| P3 | 全局开关不能表达按 URL 分流、绕过与 PAC | 智谱/Zenmux、本地 MCP、企业代理可能走错路线 | §2.3–2.4 |
| P4 | 常驻进程需要动态更新 | 只在启动时设置环境变量无法满足 U3 | §2.5 |
| P5 | 默认 fetch 不代表所有传输 | Tavily、MCP 重连、stdio 子进程可能表现不同 | §2.6 |
| P6 | 请求错误缺少路由与连接阶段信息 | 一律 timeout 无法区分代理端口、目标站点、TLS | §2.7 |
| P7 | 声明 Node 版本与新 API 能力不一致 | 本机 Node 26 成功不代表 Node 24.0 成功 | §2.2 D4、Stage 1 |
| P8 | 源环境、服务用户和执行主机容易混淆 | 修改客户端 shell/本机浏览器配置不影响已运行远端服务 | §2.3、§2.4 |

## 1.5 既有文档与实现关系

| 既有文档 | 已有约束/记录 | 与本议题关系 |
| --- | --- | --- |
| [全局单 daemon](../../2026-07-11-global-single-daemon/README.md) | serve 是进程级单实例，TUI 保持独立进程 | 代理作用域应是执行进程，不能随 workspace 切换 |
| [环境变量集中化](../../2026-06-17-api-key-env-centralization/README.md) | 环境加载有既有入口 | 复用加载结果并保留来源，不另造 dotenv 加载体系 |
| [Windows 路径迁移](../../../plans/2026-07-15-windows-home-migration-design.md) | Windows 差异应通过真实平台验证 | 此文描述路径兼容，不是系统代理已兼容的证据 |
| [搜索配置规范](../../../config/tools/implement/schema.md) | 面向用户的 defaults 暂不开放 proxy | Tavily 内部确有 proxy 入口；需区分内部能力和公共配置，不凭历史示例扩大承诺 |
| [Server 测试设计](../../../ohbaby-server/test.md) | colocated 测试及 root Vitest；该文记录尚无正式项目 test-blueprint | 沿用现有命名与工具，不为本议题重做全仓测试规范 |

未发现可直接沿用的系统代理架构契约。本议题定义新行为，不能将旧目录内的网络示例误当当前产品承诺。

## 1.6 SWE 原则审视

1. **启发**：系统代理平台差异是本质复杂度；向每个业务层传一个庞大运行时是可避免的复杂度。采用集中初始化加小范围平台适配。
2. **健康度**：业务与 SDK 适配边界可保留；启动职责、诊断和跨传输一致性需要补齐，不需要全局架构重写。
3. **风险地图**：优先修 P1/P2/P4；P3 的 PAC/自动发现会显著提高实现和打包成本，必须显式限定或完整实现；P5 用出口测试识别真实缺口。
4. **行动**：先验证低层传输能力和最低 Node 版本，再做 Windows/macOS 双平台纵切，最后验证各客户端及状态呈现。
5. **反教条**：文件越少不等于越简单；不能用一个 `if darwin` 把 Windows 当直连，也不能为了兼容任意第三方工具而构建全流量代理服务器。重试预算改造独立处理。

原则依据：learn-swe-before-after-implement 的复杂度管理、KISS/YAGNI、可验证性；架构取舍采用 swe-architecture-design 的需求—约束—代价方式，具体决策集中在 02。

## 1.7 本轮实测补充：传输可行性，不是产品完成

用户授权使用 `.env` 和 `tests/models-4-tests.md`。2026-10-01 在 Node 26.3.1/macOS 上使用现有源码 `createInterfaceProvider`，所有客户端在临时安装代理之前创建；不修改生产配置、系统代理或服务。系统读取当时返回静态 HTTP/HTTPS `127.0.0.1:1082`，端口仅为本次观察值。

| 路径 | 模型/协议 | 结果 | 耗时 |
| --- | --- | --- | --- |
| Node 默认网络，未安装本次应用代理 | DeepSeek v4.1 flash / Chat | 成功 | 4.053 s |
| Node 默认网络，未安装本次应用代理 | GLM 5.3 flash / Chat | 成功 | 2.918 s |
| 从系统读取静态地址并临时安装 | DeepSeek v4.1 flash / Chat | 成功 | 3.653 s |
| 同上 | GLM 5.3 flash / Chat | 成功 | 3.183 s |
| 同上 | GPT 5.6 luna / Responses | 成功 | 4.345 s |
| 同上 | Claude Sonnet 5 / Anthropic | 成功 | 3.485 s |
| 同上 | Qwen 3.8 flash / Chat | 成功 | 2.523 s |

第二次专门验证 Responses/Anthropic 的发送 socket，均观察到经过当前代理端口；这是补证连接复用时“没有新连接事件”不等于未走代理。共 9 次最小模型调用，每次上限 256 输出 token、45 秒超时；提示仅要求回复 OK，没有发送项目内容。

**结论边界**：当前 Node 默认路径也能请求成功，不能从前序故障推断 Zenmux 永远需要显式代理；该路径仍可能受 OS TUN/路由影响。本次静态地址探针没有实现完整系统 bypass、Windows 读取或产品级刷新，不能据此宣布功能完成。

受控本地探针得到：

- 代理 A 上旧流能结束；新安装 B 后新请求经过 B。
- `setGlobalProxyFromEnv({})` 后仍经过 B；恢复 B 的安装句柄回到 A，恢复 A 的句柄才回到原基线。必须明确定义“关闭”，不能反复堆 restore 栈。
- fetch 显式 `127.0.0.1` 可绕过；`127.0.0.0/8` 未绕过，`<local>` 未匹配简单主机名。
- `*.local` 测试未命中代理，走了直接解析并超时；证明这次后缀规则触发绕过，不证明该名字可解析。因此不能一概声称 `*.local` 必须重新实现。
- Tavily 的 HTTP fixture：同一默认客户端随着全局代理 A→B 改变；显式 `proxies.http=A` 的客户端仍走 A。不能把所有 Axios 默认路径都认定为绕过全局配置。HTTPS 和专有 env 场景仍待验证。

[脱敏证据 JSON](./evidence/2026-10-01-network-probes.json) 保存结果、运行条件和限制，不含密钥、提示正文、模型正文、认证头。probe 使用临时脚本，未加入产品代码。Node 原生函数源码同时证实 restore 只恢复句柄，不显式 close 旧池。
