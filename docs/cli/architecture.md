# CLI 架构

## 当前结构

```text
packages/ohbaby-cli/src/bin.ts
  ├─ yargs 全局选项
  ├─ cli/commands/terminal.ts  -> CoreApiHost -> TUI
  ├─ cli/commands/run.ts       -> CoreApiHost -> stdout renderer
  └─ cli/commands/serve.ts     -> daemon lifecycle / browser
```

`CoreApiHost` 包含：

- `core: CoreAPI`：从 `UiBackendClient` 派生、去掉反向事件端口的调用面；
- `callbacks: SDKAPI`：`subscribeEvents` 反向端口；
- `dispose()`：释放 host。

Agent in-process host 与 Server remote host 都直接复用真实 client 对象作为 `core`，不再维护逐方法转发清单。

## 三条用户路径

### 默认 TUI

`terminal.ts` 创建本地或 remote host，把 `core` 和 `callbacks.subscribeEvents` 注入 `renderTerminalUi`，等待 UI 退出后 dispose。

### 非交互 run

`run.ts` 从位置参数或 stdin 得到 Prompt，先订阅事件供 stdout renderer 输出过程，再调用 `core.submitPromptAndWait()`。四种终态都由 completion 返回；最后统一 unsubscribe + dispose。

### serve

`serve.ts` 管理 daemon 的 start/status/stop/ps。loopback 默认可托管构建后的 Web assets；业务请求仍由 Server 的 REST/RPC + SSE surface 处理。

## 关键约束

- `submitPromptAndWait` 是 `submitPromptAccepted + waitForPrompt` 的组合，不拥有第三条执行逻辑。
- TUI 提交采用 accepted 语义，并从事件流观察后续状态。
- CLI 不把普通领域终态转换成传输异常；只按退出策略映射 process exit code。
