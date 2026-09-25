# permission 模块 data-model.md

以 `packages/ohbaby-agent/src/permission/types.ts` 为完整类型定义；本篇说明数据含义与生命周期。

## 一、执行与来源身份

| 字段                   | 含义                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `id`                   | 每次登记独立生成的 permissionId；同 call 的多个审批不能合并       |
| `sessionId`            | 实际来源会话，也是 always 写规则的唯一 session                    |
| `runId`                | lifecycle 传入的真实执行轮次，不能用 callId 或当前主代理 run 兜底 |
| `callId` / `messageId` | 原工具调用和原消息身份                                            |
| `contextScopeId?`      | 原执行 scope，主代理可缺省                                        |
| `rootSessionId`        | application wrapper 校验后的根主会话，用于汇总和路由              |
| `ancestorSessionIds`   | 来源向根的祖先链，不含来源自身、包含根；来源就是根时为空数组      |
| `sourceLabel?`         | 展示名称，不参与授权                                              |

```typescript
interface PermissionSource {
  readonly rootSessionId: string;
  readonly ancestorSessionIds: readonly string[];
  readonly sourceLabel?: string;
}

interface PermissionIdentity extends PermissionSource {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly messageId: string;
  readonly contextScopeId?: string;
}
```

来源由 adapter 在登记前解析并验证，manager 保存冻结副本，不能在旧请求存续时重新挂到另一棵树。signal 属于执行控制，不属于浏览器连接，不进入 PermissionInfo、事件或终态。

## 二、输入与展示数据

`PermissionAskInput` 必需字段为 `runId`、`source`、`signal`、`sessionId`、`messageId`、`callId`、`toolName`、`category`、`params`；可选字段为 `contextScopeId`、`metadata`、`reason`、`rememberable`。`reason` 用于标题，`rememberable: false` 禁止 always。

`PermissionInfo` 在 `PermissionIdentity` 上增加：

| 字段           | 含义                                                      |
| -------------- | --------------------------------------------------------- |
| `type`         | tool / bash / skill / external_directory / sensitive_path |
| `name`         | 工具、命令或技能名称                                      |
| `title`        | 请求原因或默认确认标题                                    |
| `metadata`     | 操作参数、类别、原因、可记忆性等展示信息                  |
| `pattern`      | 本次请求生成的批准模式                                    |
| `time.created` | 毫秒时间戳；UI 投影为 createdAt                           |

manager 冻结 info 顶层与来源祖先数组；metadata 是操作描述，不用来重新定义授权身份。`PendingRequest` 仅在 manager 内部保存 info、冻结调用上下文、resolve/reject 和 abort listener，不跨进程序列化。

## 三、规则与状态

```typescript
interface PermissionRule {
  readonly tool: string;
  readonly pattern?: string;
  readonly decision: "allow" | "deny";
  readonly scope: "session";
  readonly reason?: string;
}
```

状态包括 `mode: plan | auto`、`level: default | full-access` 和 `Map<sessionId, readonly PermissionRule[]>`。规则样例为 `edit(src/**)`、`bash(git push)`、`skill(code-review)`；解析后分别保存 tool 与可选 pattern，工具级规则可无 pattern。敏感路径在 default 下不可记忆。Full Access 优先于 ask/allow 分支，但明确 deny 优先于 Full Access；切换不写会话规则、不变更已有 pending。

## 四、响应与终态

| 响应          | 原 ask 结果                                              | 规则副作用                                          |
| ------------- | -------------------------------------------------------- | --------------------------------------------------- |
| once          | resolve `once`                                           | 无                                                  |
| always        | resolve `always`                                         | 静默写入实际来源 session 的合法规则，提交后发布通知 |
| reject        | reject `PermissionRejectedError`                         | 无                                                  |
| suggest       | reject `PermissionRejectedWithSuggestionError`，携带建议 | 无                                                  |
| auto_approved | resolve `always`                                         | 系统对已登记匹配请求结算，不重复写规则              |
| cancel        | resolve `cancel`                                         | 仅内部撤销；公开 respond 拒绝此 choice              |

`PermissionResponse` 为 once/always/reject/suggest/cancel 联合类型；always 可携带 pattern，但必须等于请求模式。`SystemPermissionResponse` 为 auto_approved；两者合为 `PermissionEventResponse`。类型中保留 cancel 不代表 UI 可以发送它。

`respond()` 的同步返回值为 accepted / already-resolved / revoked / not-pending。公开 SDK 应答仍返回 Promise<void>，由 adapter 校验范围并映射状态。

```typescript
interface PermissionTerminal extends PermissionIdentity {
  readonly status: "resolved" | "revoked";
  readonly reason: string;
}

type PermissionCommit =
  | { readonly type: "requested"; readonly info: PermissionInfo }
  | {
      readonly type: "resolved";
      readonly identity: PermissionTerminal;
      readonly response: PermissionEventResponse;
    };
```

近期终态默认最多 1024 条，保存身份、状态、原因，不保存参数和正文；超限淘汰最早插入项。未知或已淘汰 ID 返回 not-pending，不恢复请求。

## 五、事件与错误

当前 `PermissionEvent` 包含 ModeChanged、LevelChanged、RuleAdded、Updated 和 Replied。Updated 包含 info；Replied 包含 sessionId、permissionId、runId、rootSessionId、reason、callId、response。没有 SwitchModeRequested。审批关键端口使用 PermissionCommit，adapter 再构造带 epoch/root/revision 的独立 requested/resolved UI 事件；普通 Bus 不是权威提交端口。

- `InvalidPermissionChoiceError`：code 为 `INVALID_PERMISSION_CHOICE`，不认领 pending。
- `PermissionRejectedError`：本次操作拒绝。
- `PermissionRejectedWithSuggestionError`：包含 permissionId 和 suggestion。
- `PermissionUnavailableError`：code 为 `PERMISSION_UNAVAILABLE`，含可选 rootSessionId 和 cause；健康状态独立于投影保存。

## 六、生命周期与归属

```text
已有规则 / Full Access -> 直接返回，无 pending 或审批版本变化
新登记 -> pending Map + abort listener -> requested 关键提交
pending -> 首个合法回答或撤销 -> 移除条目和 listener
        -> 规则副作用（如有）-> resolved 关键提交 -> 近期终态
        -> 完成原 Promise -> 专用通知与普通 Bus
```

任何 pending ID 都可进入终态，没有 current 阶段。同一调用后续审批使用新的 permissionId。正常执行结束按 runId 撤销；来源、根或祖先删除按冻结链撤销。`clearSession()` 清目标 session 规则，`dispose()` 完成所有 pending 等待。进程结束不恢复 Promise 或旧 ID。
