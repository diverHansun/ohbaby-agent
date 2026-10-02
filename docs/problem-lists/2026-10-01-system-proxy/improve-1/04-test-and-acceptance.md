# 04 · 测试与验收标准

状态：未来实施的验收契约草案，**以下产品级验收尚未执行**。D3/D4/D5 的范围确认后，在本轮规划审阅中收敛相应支持矩阵。未执行项不能标为通过。

本轮已执行的是 01 §1.7 的传输可行性探针和 9 次最小真实 API 调用，结果见 [证据](./evidence/2026-10-01-network-probes.json)。它们不能替代下表，Windows、HTTPS Tavily、完整系统刷新及资源清理仍未验收。

沿用仓库 colocated `.unit.test.ts` / `.integration.test.ts` 与 root Vitest。既有 [Server 测试设计](../../../ohbaby-server/test.md) 记录未有正式项目级 test-blueprint；本议题不另建全仓测试规范。

## 4.1 测试分层

- 单元测试：env 优先级、来源、bypass、系统输出解析、未知/失败状态、串行刷新与关闭竞态。输入用人工 fixture，不能提交本机真实凭证或完整环境。
- 集成测试：受控 HTTP/CONNECT 代理、目标服务和真实 SDK，验证 TCP/HTTP 实际出口、错误原因、流式切换及资源清理。
- 原生平台测试：Windows/macOS 的真实系统设置读取与动态变化。Linux 测试 env 和声明支持的桌面 provider；不能仅 mock `process.platform`。
- 安装包冒烟：打包后的 CLI/serve、已声明最低 Node 和当前受支持 Node 分支，验证可选原生依赖、路径、清理与状态。

## 4.2 关键用例

| ID | 场景与可验证结果 | 层级 | 阶段/问题 |
| --- | --- | --- | --- |
| T01 | 无 env，系统明确无代理；请求到目标，无代理命中记录；状态为无应用代理 | 集成 | S1/P1 |
| T02 | HTTP-only、HTTPS-only、ALL-only、空值、非法非空值；按选定成熟 env 语义归一化，fetch/http/https 一致，非法配置不能访问目标 | 单元+集成 | S1/P1/P8 |
| T03 | 仅 NO_PROXY 不关闭系统跟随；`*` 明确全绕过；域名边界/端口/IPv6/CIDR/简单主机名不误匹配；系统规则不能直接拼 NO_PROXY 了事 | 单元+集成 | S1/P3 |
| T04 | localhost、IPv4 loopback、::1 的 daemon/MCP 不进入代理；其余私网不默认绕过 | 集成 | S1/P3 |
| T05 | 存在显式 env 时系统变化不覆盖；状态标注 env 来源，移除覆盖并重启后恢复系统跟随 | 集成 | S1/P8 |
| T06 | Mac/Win 分别读取静态 HTTP/HTTPS、分协议端口与 bypass；fixture 与原生结果一致 | 原生平台 | S2/P2 |
| T07 | 代理关闭→打开→端口改变→关闭；进程不重启，同一 SDK 实例的新请求改走对应出口；明确验证 A→B→关闭，包括宿主初始基线已有代理；运行期关闭应 direct，模块 dispose 才恢复宿主代理，空对象 no-op 不能冒充关闭 | 集成+原生 | S2/P4 |
| T08 | A 代理上的流持续输出时切到 B；旧流不被应用主动取消，新请求到 B；代理真的退出时保留部分输出，不自动重放 | 集成 | S2/P4 |
| T09 | 并发请求不会并发执行检测命令；相同快照不重建 agent；读取串行不重叠，不需要序号取消体系 | 单元+集成 | S2/P4 |
| T10 | 读取失败、无权限、超时、畸形输出；与明确无代理区分，新外部请求有明确错误，本地管理可用，后续刷新成功恢复 | 集成 | S2/P2/P4 |
| T11 | 真实 OpenAI compatible、Responses、Anthropic 与模型探测分别走受控代理；切换后复用旧客户端仍正确 | 集成 | S3/P5 |
| T12 | Tavily/Exa 搜索及网页读取、MCP HTTP/SSE 初次与重连验证实际出口；SDK 专有 proxy 不双重代理或悄悄抢优先级 | 集成 | S3/P5 |
| T13 | 代理连接拒绝/超时/407、目标 TLS/DNS/响应超时；保留可证实底层 code/status/cause，不建立连接阶段分类器；无自行直连 fallback | 集成+契约 | S3/P6 |
| T14 | cause 环、含密码代理 URL、URL 查询参数、Authorization；日志和 UI 均无敏感值；重试次数不因展示变化增加 | 单元+集成 | S3/P6 |
| T15 | 最低与当前支持 Node；fetch、node:http/https 和各 SDK 行为相同；缺能力版本给明确版本错误或走已验证兼容实现 | CI/安装包 | S1/P7 |
| T16 | PAC/WPAD/SOCKS：已支持则按 URL、协议和 DNS 行为测试；未支持则准确识别和提示，不能默默直连；Windows 自动检测无代理与探测失败区分 | 原生+集成 | S2/P2/P3 |
| T17 | 仅 OS TUN/VPN，无应用层代理配置；不推测端口、不额外叠加代理，状态不谎称物理直连 | 原生手工 | S2/P2 |
| T18 | 单 daemon 多 workspace 不相互重写全局策略；独立 TUI 各自初始化；仅 import agent/server 无全局网络副作用 | 集成 | S3/P8 |
| T19 | Windows 用户进程与服务身份差异；读取失败信息准确；无管理员权限也能使用声明支持的普通用户模式 | 原生平台 | S2/P2/P8 |
| T20 | Windows 浏览器连接远程 serve，状态来自服务端；WSL/容器中的 localhost 不误认为宿主 | 集成/手工 | S3/P8 |
| T21 | stdio/Shell 的边界有说明；支持的 env 继承不覆盖用户显式配置；不宣称存量第三方子进程热更新 | 集成/文档 | S3/P5 |
| T22 | 打包后启动、重复初始化、退出、连续切换，观察器/空闲连接不累计；原生依赖无需开发机工具链才能安装 | 安装包 | S3/P4/P7 |

若 PAC 正式纳入：T16 追加不同 URL 路径、脚本内容变化而 URL 不变、网络变化、脚本下载失败、返回多个代理和 DIRECT 的场景。候选切换不得重放已发送模型 POST。

## 4.3 受控出口测试要求

1. 用受控代理统计连接和 CONNECT，用受控目标记录实际到达的请求；只断言 `new ProxyAgent()` 被调用不合格。
2. 测试目标使用可控的非 loopback 主机名及测试 DNS/lookup，代理端把它转发到本地 fixture。直接用 `localhost` 当代理目标会命中必需 bypass，造成错误结论。测试可控制解析，不应关闭被测 bypass 规则。
3. HTTPS fixture 使用仅在测试进程受信任的测试 CA，不以关闭证书校验验证成功。
4. 模拟代理不可达时，目标请求计数须为 0，以证明没有隐式直连；同时检验 SDK 内部重试的次数没有意外放大。
5. SDK 输出使用真实协议的最小响应/流；避免 mock 掉 SDK 自身传输路径。网络策略切换不重建 SDK 实例，以暴露创建时捕获旧 agent 的问题。
6. 测试隔离全局 dispatcher、http agent 和 env，结束恢复。不能把全局网络测试无隔离地并行执行。

## 4.4 原生机器验收步骤

Windows 和 macOS 各执行一次，记录 OS/架构/Node/包版本、服务身份、代理模式和脱敏配置来源，不记录密钥。

1. 清除测试进程的显式代理覆盖，确认服务端跟随系统状态。
2. 启动 ohbaby，系统明确无应用代理时请求受控目标；记录路线。
3. 在专用测试用户/VM 中开启系统代理，保持 ohbaby 进程不重启，等待建议上限 5 秒；再次请求，核对代理实际命中。
4. 修改代理地址/端口，再次检查同一客户端的新请求。不要只测试启用标志。
5. 开始长流，切换系统配置，确认应用没有主动杀掉旧流；另发请求检查新路线。
6. 保留系统代理配置但停掉代理进程，检查明确故障、无目标直连；重新启动代理应能恢复。
7. 关闭系统代理，核对后续请求无应用代理；再用显式 env 启动另一独立测试进程，验证覆盖及来源提示。
8. 如有 TUN、PAC、SOCKS 支持承诺，分别测试，不能用 mixed HTTP 端口成功冒充 SOCKS 测试。
9. 用“一个经代理、一个直连”的受控分流规则验证两端点。可选真实 Zenmux/智谱冒烟只记录当次网络结果，不将地域连通性当确定性 CI 断言。
10. 恢复测试用户/VM 的系统设置，验证退出后无 ohbaby 观察器残留。

实施者不得为跑自动化悄悄修改开发者主机系统代理。本轮没有执行这套系统切换验收步骤；仅从当前设置读取地址用于独立进程探针。

## 4.5 命令与发布门

建议新增测试与实现 colocated，采用以下命名入口；文件由后续实施创建：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/utils/network-proxy
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/llm-client/sdk-retry.integration.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts
pnpm run typecheck
pnpm run lint
pnpm build
```

SDK 出口测试可放在新目录的 `sdk-egress.integration.test.ts`，平台读取在 `system-proxy.integration.test.ts`。现有 SDK 重试测试用于确认本轮没有偷偷改变预算；需要变更预算则先独立说明和调整契约。

| 发布门 | 要求 |
| --- | --- |
| 范围 | D3/D4/D5 已收敛，帮助文档与实测支持矩阵一致；不支持的模式不能自称已跟随 |
| 平台 | macOS/Windows 都有原生读取、动态切换和打包验收证据；mock 通过不能替代 |
| 动态行为 | 在已支持的静态模式与正常机器负载下，建议 5 秒内应用新设置；请求不逐次 spawn；睡眠期间不承诺墙钟期限，定时器恢复后刷新 |
| 正确性 | 代理错误无自行直连，bypass 可证明；旧 SDK 实例能使用新策略 |
| 流与资源 | 旧流不被主动中止；故障时不重放部分完成请求；切换/退出无持续增长的 watcher 和空闲连接 |
| 诊断 | 环境/系统/读取失败/未支持状态可区分；不暴露凭证或声称知道代理内部出口 |
| 兼容性 | Node 声明与最低版本测试一致；嵌入方无导入副作用；本地控制通道、已有模型/搜索/MCP 行为回归通过 |

所有 Stage 的完成定义必须对应测试证据；产品完整验收在实际实施后写入同轮 05，目前不得创建占位“通过”报告。

## 4.6 对抗性审查

| 最可能失败处 | 防御/验证 | 残余限制 |
| --- | --- | --- |
| 系统值写进 env 后被当显式覆盖 | T05/T07，来源与有效值分开，热切换不修改 env | 已启动的第三方子进程仍可能持有旧环境 |
| 全局 dispatcher 生效但 Axios/SDK 私有 agent 绕过 | T11/T12 的真实出口计数 | 新增 SDK/升级传输依赖后需重验 |
| Windows 服务误读另一个用户设置 | T19，记录服务身份和可用能力 | 不自动提权或模拟其他用户 |
| 刷新乱序/切换销毁长流 | T08/T09/T22，串行刷新和 graceful close | 代理本身停止时旧连接可能断开 |
| PAC/bypass 解析错后静默直连 | T03/T10/T16，区分 direct、unknown、error、unsupported | 未实现的协议不能保证同浏览器一致 |


## 4.7 开始产品接入之前的技术门槛

集中薄适配必须先用本地 fixture 证明三个能力：系统 CIDR/简单主机名在 fetch 与 http(s) 的一致绕过；读取失败/不支持模式时两栈都拒绝外部请求但允许本地控制通信；代理关闭恢复正确且旧资源有所有者和清理。不能用“状态已更新”代替请求行为。

若 native API 单独不能实现，应改用成熟可关闭 dispatcher/agent 加共享的小型路由判定；不能继续往每个 SDK 内散落条件分支。Node 下限在传输选择后决定。这一门槛是已发现真实缺口的定点验证，不扩展成通用网络框架。
