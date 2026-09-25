# PermissionDialog — 权限确认弹窗

`packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx` 渲染当前选中的 SDK `UiPermissionRequest`，通过 `CoreAPI.respondPermission(id, response, context)` 回答。权限决定由 backend 完成。

## 输入与显示

props 为 `client`、`request`、`ready`、`context` 和 `onResync`。context 包含 permissionEpoch、rootSessionId 和可选 bindingGeneration。显示 title、简短来源（Main agent 或 sourceLabel）、description，以及 backend 提供的 choices。过滤 cancel/abort，不提供 Cancel run。

## 操作

| 按键            | 行为                                        |
| --------------- | ------------------------------------------- |
| Up / Down / Tab | 切换回答选项                                |
| Enter           | 回答当前选项                                |
| Esc             | 选择 deny 安全默认项                        |
| `[` / `]`       | DialogManager 切换上一条/下一条 pending     |
| R               | 同步耗尽后显式重试；严重 unavailable 不重试 |

多条请求以稳定列表显示，允许先回答非首项。审批未 ready、context 缺失或正在发送时禁用回答。requestId、epoch、root 或 generation 变化时清理当前发送状态；旧应答 Promise 的回调不能回写新请求，包括 A→B→A。

后台回答或撤销后，独立同步列表移除该 ID，DialogManager 展示剩余请求。PERMISSION_NOT_PENDING 触发重新同步，不能用旧 ID 回答同 callId 的下一次审批。来源和权限档位都不由 UI 推断。
