# 网络测试与验收标准

> 这是未来实施的验收契约，不是本次已通过的测试记录。遵循既有项目测试规范与既有测试分类。

## 测试范围与位置

纯解析 / env 构造使用就近 unit，状态与错误形态使用 contract；真实主客户端 + 子进程 + 受控代理的集成测试放 `tests/integration/network-proxy/`。构建安装入口使用 smoke。常规测试不访问真实 LLM 或公共网站，不修改开发机系统代理。

## 关键用例

| ID    | 场景与断言                                                                                                                                                                          | 类型                    | Stage |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----- |
| N-T01 | 同层大小写、跨层 override、ALL_PROXY 后备、只设置一个协议时不从系统补另一个；最终环境没有旧大小写别名                                                                               | unit                    | 1     |
| N-T02 | 只有 NO_PROXY 仍系统跟随；`*` 全绕过；空白值 / 删除恢复继承；普通 env 空串保留                                                                                                      | unit                    | 1     |
| N-T03 | HTTP / HTTPS URL 校验和诊断脱敏；不借 Node 协议限制改坏显式外部客户端配置                                                                                                           | unit                    | 1     |
| N-T04 | 系统开启 → A 换 B → 关闭 → 读取失败 → 恢复；新进程读取当前完成快照；父 env 始终不变；不再生效协议的旧键消失                                                                         | integration             | 1 / 2 |
| N-T05 | 裸域、仅子域、`*.local`、`host:port`、`<local>` 等不可表达系统 bypass 明确拒绝子进程；只设普通 NO_PROXY 仍失败；主 Node 原本可用 policy 仍可用                                      | unit + integration      | 1     |
| N-T06 | IPv4 CIDR / 缩写 CIDR、IPv4 / IPv6 字面值、常用 loopback 构造与真实出口正确；IPv6 CIDR 拒绝，不因版本号假定支持                                                                     | unit + integration      | 1 / 3 |
| N-T07 | 首次读取失败 / PAC / malformed 系统配置时 Shell spawn=0、无 running job、retain 释放；有效显式 override / 全绕过不依赖系统失败                                                      | integration             | 2     |
| N-T08 | MCP transport 构造抛错：client=failed、已创建资源关闭、spawn=0、不影响其他 server                                                                                                   | contract + integration  | 2     |
| N-T09 | MCP 继承代理白名单及 config.env；已有无关 secret 仍不可见；重连读取新快照；config.env 不能在最终合并时重新引入别名冲突                                                              | integration             | 2     |
| N-T10 | 真实 HTTP 和 HTTPS CONNECT fixture 分别观察主进程客户端、主代理 Shell、subagent Shell 的代理出口；不能只看 env                                                                      | integration             | 3     |
| N-T11 | 真实 stdio MCP fixture 收到代理配置，并用明确支持代理变量的测试客户端请求受控地址                                                                                                   | integration             | 3     |
| N-T12 | 代理端口不可达时命令原生失败，不改直连，不在启动前新增探活；后台进程切换代理后仍保留旧环境                                                                                          | integration             | 2 / 3 |
| N-T13 | CLI local / TUI / serve 安装顺序正确、首次读取已完成；远程客户端不错误使用浏览器所在主机设置                                                                                        | contract + smoke        | 3     |
| N-T14 | dispose / 重新安装无旧快照；包导入无副作用；嵌入方未安装时仅显式 env 模式                                                                                                           | unit + smoke            | 1 / 3 |
| N-T15 | 代理异常下 Read / Glob / Grep 和本地 UI 控制仍可用；内部 rg 不进入网络门禁                                                                                                          | integration             | 2     |
| N-T16 | Windows proxy 键大小写和 curl.exe；macOS 静态读取；Linux env 模式均做实际平台验证                                                                                                   | integration / 平台验收  | 3     |
| N-T17 | 保留系统解析矩阵：macOS PAC/自动发现拒绝；Windows 有 PAC URL 拒绝、无 URL 且 12180 继续、其他 discovery 异常失败；两平台 HTTP+HTTPS+SOCKS 接受静态双协议，SOCKS 独占/单静态协议拒绝 | unit + 启动 integration | 1 / 2 |

fixture 使用本地受控代理，并以可解析但不是 loopback 的目标名验证代理出口，避免所有请求因 localhost 绕过而产生假阳性。HTTPS 使用测试 CA，不关闭生产 TLS 验证。Windows 明确调用 `curl.exe`，不把 Windows PowerShell 的 `curl` alias 当作 curl。

## 现有回归入口

```sh
pnpm exec vitest run packages/ohbaby-agent/src/utils/network-proxy packages/ohbaby-agent/src/tools/bash.unit.test.ts packages/ohbaby-agent/src/mcp/__tests__/transport.unit.test.ts packages/ohbaby-agent/src/mcp/__tests__/client.unit.test.ts packages/ohbaby-cli/src/bin.unit.test.ts
pnpm typecheck
pnpm --filter ohbaby-agent build
```

新集成文件建立后运行 `pnpm exec vitest run tests/integration/network-proxy`；该路径为本批计划新增，当前不存在不算已有测试通过。保留既有真实 SDK fixture，避免只验证 fetch 而漏掉 http / Axios 路径。

## 验收门

- N1–N5 均有对应 N-T 用例，三个 Stage 的完成定义都有实际输出依据。
- macOS / Windows / Linux 的声明支持范围有真实平台结果；缺少某平台时明确未验，不用 mocked platform 结果替代。
- 给出主进程、Shell、subagent Shell、MCP 四条路径的配置来源与受控出口证据；无需打印凭证。
- 已知不可表达 bypass 必须失败，不能为让测试通过而丢掉规则；含 `*.local` / `<local>` 的已知常见配置在自动系统路径下必然失败，须验证明确诊断及显式配置指引；不能写成偶发限制。
- 不新增通用子进程框架、不修改系统配置、不关闭证书验证、不重启存量任务。

## 易错点复核

重点复核：系统值意外写入 process.env 后被当成显式配置；刷新失败仍读旧成功值；覆盖层大写输给下层小写；MCP 在 try 外抛错；局部 bridge 错误污染主进程 policy。测试分别验证这些边界，不能靠一条 curl 成功替代。

环境变量传递不构成网络沙箱。不读取这些变量或自行重写环境的程序不在透明接管承诺内；它们的行为不能被 env 字段断言证明。
