# CLI 测试

## 当前测试位置

| 文件 | 覆盖 |
|---|---|
| `packages/ohbaby-cli/src/bin.unit.test.ts` | yargs 组合、默认 terminal、run/serve 分流、拒绝旧 `-p` |
| `cli/commands/run.unit.test.ts` | 参数/stdin、andWait 时机、四终态 exit policy、finally dispose |
| `tui/app.contract.test.tsx`、`tui/index.unit.test.tsx`、`tests/integration/tui/*` | accepted/event 时机、local/remote host 与 TUI 生命周期 |
| `cli/commands/serve.unit.test.ts` | start/status/stop/ps 与 Web assets 约束 |
| `cli/stdout-renderer.contract.test.ts` | SDK event 到 stdout/stderr 的投影 |
| `tests/integration/cli/*` | 真实 CLI/daemon、持久化与全局 FIFO 集成 |

## 必测合同

1. `run` 只调用组合 `submitPromptAndWait`，并在 completion 前不 dispose。
2. succeeded/failed/cancelled/interrupted 全部通过 completion resolve；exit code 分别按策略映射。
3. 技术 reject 仍进入异常路径，但 finally 必须 unsubscribe/dispose。
4. 默认 terminal 使用 accepted/event 语义，不额外建立 per-Prompt wait 状态源。
5. strict CLI 拒绝旧 `-p/--prompt`。
6. remote host 与 in-process host 暴露同一 SDK 派生 seam。
