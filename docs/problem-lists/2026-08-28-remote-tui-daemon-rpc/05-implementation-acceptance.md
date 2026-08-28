# 5. 实施验收文档

> 撰写时机：2026-08-28，生产修复、自动化回归与真实 compiled TUI PTY 验收完成后。

## 5.1 元信息

| 项 | 值 |
|---|---|
| 议题 / 批次 | Remote TUI → daemon RPC receiver 丢失 |
| 规划基线 | `8484474`（`main` / `origin/main`） |
| 规划文档 commit | `30a8ae7` |
| 生产修复 commit | `da056b7` |
| 验收日期 | 2026-08-28 |
| 结论 | **通过**：规划范围完整落地，G1–G8 全部有可复现证据，无阻塞 gap |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
|---|---|---|---|
| Phase A：SDK 调用语义 | 完成 | `createRPC()` 用 connected `impl` 作为 receiver 调用动态取得的 method；未增加 helper、缓存或 allowlist | `proxy.ts` + receiver unit |
| Phase B：CLI + remote 组合缝 | 完成 | CLI unit 使用 receiver-dependent remote host；daemon terminal integration 让真实 `RemoteDaemonClient` 经 fake-RPC 后完成 snapshot、prompt、event、fresh/continue | CLI unit + daemon terminal integration |
| Phase C：compiled TUI + 文档 | 完成 | 隔离环境启动 compiled daemon/TUI 和 fake provider，完成 prompt、`/status`、退出与清理；同步 SDK/CLI architecture 和 Server test | PTY 证据 + 三份权威文档 |

## 5.3 规划与实际差异

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
|---|---|---|---|---|
| 数据结构 | 不新增 DTO、字段或 schema | 与规划一致 | 无 | 无迁移、无 wire 兼容风险 |
| 数据流 | fake-RPC 以 connected impl 为 receiver，再进入 RemoteDaemonClient/HTTP | 与规划一致 | 无 | 恢复标准 class method 语义 |
| 协议 / 接口 | `createRPC`、`CoreAPI`、`SDKAPI`、JSON-RPC/SSE 签名不变 | 与规划一致 | 无 | 对外零破坏 |
| 文件 / 包结构 | 唯一生产修复在 SDK；CLI/跨包测试与权威文档跟进 | 与规划一致 | 无 | Server 生产代码零改动 |
| 错误 / Abort 边界 | clone、错误重建、AbortSignal、callback 直通保持 | 与规划一致 | 无 | 既有 unit/contract 全绿 |
| E2E 形态 | 自动化分层测试 + 一次真实 PTY，不新增常驻 script | 与用户确认一致 | 临时 harness 只用于本次验收，结束后移入废纸篓 | 长期回归由 unit + integration 守住，避免维护重复脚本 |
| 依赖 | 不新增依赖 | 与规划一致 | 无 | 安装和供应链面不变 |

## 5.4 实施理由与注意事项

- 修复放在 SDK invocation seam，因为 receiver 正是在这一层被丢掉；在 RemoteDaemonClient、CLI 或 daemon 协议补特判都会把责任放错地方。
- `Reflect.apply(method, impl, clonedArgs)` 保留当前动态 method lookup，不需要 Kimi 式原型链遍历和 bound method map，属于一行可逆的契约修正。
- integration 的 `createTerminalClient()` 是测试内对生产组合的显式复现，不是新增运行时抽象；真实 compiled PTY 又覆盖了实际 `runOhbabyCli → createRpcCoreHost` 路径。
- callback receiver 仍不在本批：当前 `subscribeEvents` 由 closure 显式转发，没有同类故障证据。若未来 callback implementation 也改成 receiver-dependent class method，应另立回归再扩边界。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

| 验收 ID | 结果 | 证据 |
|---|---|---|
| G1 根因单测 | 通过 | receiver unit 在旧实现上稳定失败：`this.value` receiver 丢失；修复后通过 |
| G2 边界无回退 | 通过 | SDK unit 7/7；全量 unit 227 文件、2113 通过、2 跳过；contract 15 文件、251 通过 |
| G3 CLI 组合 | 通过 | `preserves receiver-dependent methods on explicit remote hosts` 真正从 rendered proxy 调用 `getSnapshot()` |
| G4 真实 daemon | 通过 | 定向矩阵 4 文件、36 通过；全量 integration 49 文件、322 通过 |
| G5 TUI 全链 | 通过 | compiled TUI 首屏无 `.rpc` 错误；remote prompt 返回 `REMOTE_TUI_E2E_OK`；`/status` 展示 Runtime/Session/Model/Context/Cache/Tools/MCP/Project |
| G6 资源清理 | 通过 | TUI exit 0；daemon `stopped`；PID、pid file、provider/daemon 两个端口均释放；临时目录移入废纸篓 |
| G7 变更克制 | 通过 | 生产 diff 只有 SDK invocation 一处；无 Server/CLI production 特判、无 bind/facade 清单、无新依赖 |
| G8 文档一致 | 通过 | SDK/CLI architecture 与 Server test 已同步 receiver 和组合测试合同 |

其他发布门：Prettier、ESLint、TypeScript project build、完整 workspace build 全部通过；integration 内 75 秒 packaging smoke 正常完成，没有沿用旧批次的超时豁免。

### 5.5.2 SWE 层面评估（聚焦改动面）

大白话结论：这次把 bug 修在了“弄丢 `this` 的地方”，没有去每个受害者身上打补丁。生产复杂度减少而非转移，测试则补上了此前缺失的组合事实。

| 发现 | 严重性 | SWE 依据 | 结论 / 建议 |
|---|---|---|---|
| 一处 `Reflect.apply` 恢复 method contract | 正向 | 正确性优先、信息隐藏、高内聚 | 修复点与责任点一致，保持 |
| 未增加 bind map、remote 分支或 callback 框架 | 正向 | KISS / YAGNI；错误抽象比重复更贵 | 改动克制，保持 |
| unit + CLI unit + real daemon integration + PTY 分层 | 正向 | 测试金字塔、缩短反馈回路、测试是活文档 | 各层证明不同事实，避免文件名代替证据 |
| integration 复现两行 fake-RPC 装配 | 低残余风险 | DRY 针对知识而非字面；E2E 覆盖真实组合根 | 当前重复很窄且意图明确；若装配语义扩展，再考虑导出测试 seam |

按架构审查清单复核：本批不改数据写入、一致性、重试、队列或模型预算；不增加网络调用与无界并发；auth token 和 workspace routing 在真实 PTY 中保持；AbortSignal 既有测试全绿。因此一致性、韧性、规模、安全与 AI 副作用均未引入新的承重风险。

### 5.5.3 残余风险与未完成项

- 阻塞 gap：无。
- 已知窄风险：callback API 若未来出现依赖 receiver 的 class implementation，当前 direct callback seam 需要独立证据；本批按 YAGNI 不预建框架。
- compiled TUI PTY 按用户确认不沉淀为常驻脚本；长期自动保护依赖 SDK receiver unit、CLI remote unit 和真实 daemon integration 三层。

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|---|---|---|
| [proxy.ts](../../../packages/ohbaby-sdk/src/rpc/proxy.ts) | 用 connected implementation 作为 method receiver | 修改 |
| [proxy.unit.test.ts](../../../packages/ohbaby-sdk/src/rpc/proxy.unit.test.ts) | 新增 receiver-dependent class 回归 | 修改 |
| [bin.unit.test.ts](../../../packages/ohbaby-cli/src/bin.unit.test.ts) | 新增显式 remote host receiver 组合回归 | 修改 |
| [daemon-terminal.integration.test.ts](../../../tests/integration/cli/daemon-terminal.integration.test.ts) | 真实 remote host 经 fake-RPC 验证 snapshot/prompt/event/fresh/continue | 修改 |
| [SDK architecture](../../ohbaby-sdk/architecture.md) | 记录 receiver-safe in-process RPC seam | 修改 |
| [CLI architecture](../../cli/architecture.md) | 记录 local/remote 统一装配约束 | 修改 |
| [Server test](../../ohbaby-server/test.md) | 记录跨包 terminal composition 测试边界 | 修改 |
