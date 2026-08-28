# 4. 测试与验收标准

> 本仓库暂无统一 `test-blueprint.md`；沿用既有事实约定：source colocated unit/contract，跨包真实 listener 放 `tests/integration/`，compiled UI 最终做 PTY E2E。测试围绕 receiver 与生产组合缝，不追求覆盖率数字。

## 4.1 测试范围

| 层 | 负责证明 | 不负责证明 |
|---|---|---|
| SDK unit | fake-RPC 保留 connected impl receiver；clone/error/AbortSignal 不回退 | daemon wire |
| CLI unit | `createRpcCoreHost` 对 receiver-dependent host 可用；remote 参数/清理不回退 | 真实 HTTP |
| Server unit | direct RemoteDaemonClient 保持现有 RPC/SSE 行为 | CLI 包装 |
| 跨包 integration | 真实 remote client 经 fake-RPC 后访问真实 daemon | Ink 视觉交互 |
| compiled TUI E2E | argv→动态加载→Ink→snapshot/prompt/status→cleanup 全链 | 外部真实模型质量 |

## 4.2 关键场景

| ID | 场景 | 类型 | 验证点 | 对应 Phase |
|---|---|---|---|---|
| U1 | class implementation | SDK unit | method 读取 instance state 成功；旧实现稳定失败 | A |
| U2 | object literal/closure | SDK unit | 既有实现结果不变 | A |
| U3 | clone boundary | SDK unit | input/result 仍值拷贝，不因 Reflect.apply 共享引用 | A |
| U4 | error boundary | SDK unit | TypeError/name/stack 仍按既有规则重建 | A |
| U5 | AbortSignal | SDK unit | 顶层与 nested signal 行为不变，backend waiter 清理 | A |
| C1 | CLI receiver-dependent remote host | CLI unit | terminal 至少调用一次 proxy method，并保留 receiver | B |
| C2 | fresh/resume mapping | CLI unit | startup intent、auth、host、port、dispose 不回退 | B |
| I1 | real daemon snapshot | integration | `RemoteDaemonClient → createRPC → getSnapshot` 完成 initialize + RPC | B |
| I2 | prompt + event | integration | 经同一 wrapped client 接单/等待，SSE 收到 session/message/run event | B |
| I3 | fresh/continue isolation | integration | 既有 terminal daemon session-view 语义保持 | B |
| E1 | compiled fresh remote TUI | E2E | mount 后无 `.rpc`/receiver error，snapshot 可见 | C |
| E2 | compiled prompt/status | E2E | prompt 完成，`/status` 可读，远程 CoreAPI 不只首方法可用 | C |
| E3 | cleanup | E2E | TUI/daemon 正常退出，端口/PID/临时目录无残留 | C |

## 4.3 集成边界

验收必须明确列出每个测试真正经过的层。以下两类证据不可互相冒充：

```text
direct remote client:
test → RemoteDaemonClient → HTTP daemon

remote terminal composition:
test/TUI → CLI fake-RPC → RemoteDaemonClient → HTTP daemon
```

I1/I2 至少覆盖第二条的 fake-RPC + remote + daemon；E1/E2 覆盖真实 CLI/Ink 装配。

## 4.4 回归清单

- 默认 in-process TUI 启动、snapshot、prompt 不回退。
- `ohbaby run` 的 fake-RPC clone/error/AbortSignal 行为不回退。
- remote auth、directory header、startup intent、fresh/continue 不回退。
- SSE subscribe/reconnect/dispose 不回退。
- `submitPromptAndWait` 仍只组合 accepted + wait，不新增 JSON-RPC method。
- callback `subscribeEvents` 仍走现有 direct closure，不被意外 JSON clone。
- 不新增 UiBackendClient 手抄 method table。

## 4.5 建议命令

实施时至少执行：

```text
pnpm exec vitest run packages/ohbaby-sdk/src/rpc/proxy.unit.test.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts tests/integration/cli/daemon-terminal.integration.test.ts --no-file-parallelism
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm --filter ohbaby-cli build
```

最后按 2.4 Phase C 在隔离目录启动真实 daemon 与 compiled TUI，记录终端 frame、daemon 请求和 cleanup 证据。

## 4.6 验收标准

| 门 | 标准 | 如何验证 |
|---|---|---|
| G1 根因单测 | receiver-dependent implementation 通过，旧实现下失败 | U1 |
| G2 边界无回退 | clone/error/abort/callback 既有测试全绿 | U2–U5 |
| G3 CLI 组合 | remote host 的实际 proxy method 被调用，不只校验 loader | C1/C2 |
| G4 真实 daemon | wrapped remote client 完成 snapshot/prompt/event | I1–I3 |
| G5 TUI 全链 | compiled TUI 无 `.rpc` 错误，prompt 与 `/status` 成功 | E1/E2 |
| G6 资源清理 | TUI/daemon/端口/PID/临时目录无泄漏 | E3 |
| G7 变更克制 | 生产修复集中在 SDK invocation；Server client 无逐方法改造 | diff 审查 |
| G8 文档一致 | SDK/CLI architecture 与 Server test 已同步 | 文档 diff |

若 full integration 仅出现已知 `packaging-smoke` 环境超时，必须单独记录并定向证明本批 I1–I3 全绿；不得把无关超时说成全量通过，也不得用它掩盖本批失败。

## 4.7 对抗性审查

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| unit 继续用 closure，假绿 | U1 强制 class/stateful receiver | 测试 fixture 若又被简化会回归 |
| integration 名称写 terminal，实际绕过 CLI | 每条证据列 production layers；I/E 分层 | I 仍可能不含 Ink，因此保留 E2E |
| Reflect.apply 误伤 clone/abort | U3–U5 + full contract | 极低 |
| 顺便“统一” callback binding | Out of scope + diff 门 G7 | 未来真有 class callback 需另立证据 |
| remote special-case 造成 transport 分叉 | G7 禁止 CLI/server 手抄与绕行 | 无 |

## 4.8 发布闸门

全部 G1–G8 通过后才可进入用户验收。实施完成前不得删除当前 direct remote client tests；它们验证的是另一条仍有价值的边界。
