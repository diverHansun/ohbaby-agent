# usePermissionSync — 独立审批同步

实现位于 `packages/ohbaby-cli/src/tui/use-permission-sync.ts`。App 挂载 `usePermissionSync(client, store, rootSessionId)`，返回 `{ state, retry }`，不再通过通用 useStream 把审批逐项塞入弹窗队列。

1. 先同步安装 `subscribePermissionEvents`，再通过轻量 session index 与 `getPermissionSnapshot` 引导本地根绑定。
2. 使用 SDK `createPermissionSync` 管理 epoch、root revision、binding generation、独立 ready、事件缓冲及重试。通用全量 snapshot、历史和 model 读取不拥有审批状态。
3. 仅在根主会话且同步 ready 时启用回答。无 active root 或 child activeSessionId 不展示可操作的全局审批。
4. 更新 `TuiStore.setPermissions`；DialogManager 按所选 ID 渲染，并用 `[` / `]` 切换任意待办。
5. 默认 TUI 的 CoreAPI 是 in-process；loopback RPC 对同步订阅直接透传函数，不将回调做 JSON clone。已有 RemoteDaemonClient 发出每次实际 hello 的连接代次，由同一同步器恢复审批。

每个恢复周期累计最多四次查询，单次上限10秒，退避100/250/500毫秒。缓冲上限1024条/2MiB；缺口和溢出要求新基线，不重置预算。实际新连接、范围切换或显式重试开启新周期。PERMISSION_UNAVAILABLE 停用且不自动重试。每次 bootstrap 重试均重新读取 session index，不复用前次失败或过期的 Promise；每次尝试退出都会取消该次权限查询，包括 metadata 分支先失败的情况。dispose/切换清理订阅、查询信号、计时器与 buffer。

关闭窗口或切换会话不撤销 backend pending。只有执行生命周期、来源失效或显式响应结束等待；默认 TUI 不改为 attach serve，也不承诺跨 runtime 审批同步。
