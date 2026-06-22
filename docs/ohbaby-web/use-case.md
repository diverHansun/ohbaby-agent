# ohbaby-web · use-case（用例场景）

> 说明 web 端如何围绕职责完成关键业务动作，强调编排顺序、责任落点与失败/决策点。不展开实现。
>
> 前置：[`goals-duty.md`](./goals-duty.md)、[`dfd-interface.md`](./dfd-interface.md) 已确认。

---

## 1. Use Case Overview（用例概览）

| 用例 | 落地职责 |
|------|---------|
| **UC1 启动会话并渲染首屏** | D1 / D4 / D3 |
| **UC2 发话并接收流式回复** | D3 / D2 |
| **UC3 处置权限请求** | D3 |
| **UC4 断线恢复 / 重同步** | D1 / G5 |
| **UC5 执行 web-safe slash 命令** | D6 / D2 |

---

## 2. Main Flow Description（主流程描述）

### UC1 启动会话并渲染首屏
1. `bootstrap.ts` 读 `window.__OHBABY__` → 构造 `client`。
2. `POST /v1/clients`（startup intent）→ clientId。
3. **先开** SSE 并缓冲事件 → 收 `hello` → `connecting`。
4. `GET /v1/snapshot`（含 seqNum 基线）→ 投影初始 ViewState。
5. 应用缓冲中 seq>基线 的事件 → `live`。

### UC2 发话并接收流式回复
1. 用户在 Composer 输入 → `POST /v1/sessions/:id/prompt` → `202`。
2. SSE 推 `message.part.delta` → 累积成 StreamingMessage（流式渲染）。
3. `message.updated` 定稿 → 并入消息序列；`run.updated` 收束 runStatus。
4. 期间用户可随时 `abort`（中断当前 run）。

### UC3 处置权限请求
1. SSE 推 `permission.requested` → 入 PendingPermission 队列 → **权限模态 slide-up 弹出**（渲染队首；多于一个显示"还有 N 个待处理"）。仅当权限策略为 `default` 时弹出（`full-access` 不弹）。
2. 用户准/拒 → `POST /v1/permissions/:id`。
3. `permission.resolved` 回流 → 移除该 PendingPermission，模态显示下一个或关闭。
4. 模态**纯由队列投影**：resync 时 ViewState 重建 → 队列重算 → 模态自动刷新/关闭（该请求可能已被它端处置）。视觉规格见 [`ui/components.md`](./ui/components.md)。

### UC4 断线恢复 / 重同步
1. SSE 断 → `reconnecting` → 带 `Last-Event-ID` 重连。
2. 命中 replay → 补发缺失事件 → 回 `live`。
3. 命中 `resync-required` → `resyncing` → 重拉 snapshot + 重置 ViewState → 回 `live`。

### UC5 执行 web-safe slash 命令
1. 用户在 Composer 输入 `/`，web 懒加载/缓存 `GET /v1/commands?surface=tui` 的命令目录，并使用 `ohbaby-sdk` 的 web-safe helper 过滤。
2. 候选面板只展示真实返回且 web-safe 的命令（`/status`、`/help`、`/new`、`/mcps`、`/skills`）；`/connect`、`/connect-search`、`/compact` 不出现。
3. 用户用 `↑/↓` 选择、`Tab` 补全、`Enter` 执行；web 使用 `ohbaby-sdk` 的 slash parser/resolve 再次校验。
4. resolve 成功 → `POST /v1/commands`，带 `clientInvocationId`、`surface:"tui"`、当前 sessionId（如有）。
5. SSE 推 `command.started` → 显示 running `CommandNotice`；随后 `command.result.delivered` 或 `command.failed` 更新为结构化只读弹层或安全 fallback notice。
6. 非 slash 输入仍走 UC2 的 prompt 流。

---

## 3. Responsibility Boundaries（责任边界）

贯穿四个用例：

- **web 负责**：投影（事件→ViewState）、UI 呈现与交互、维护 `lastAppliedSeqNum` 游标、连接态机推进、重连/重拉的客户端编排。
- **daemon 负责**：会话真相、prompt 队列调度（含跨连接 FIFO）、权限归属校验、SSE replay 缓冲与 resync 信号、workspace scope 解析。
- **web 绝不做**：自己判定权限归属、补发/重放命令、跨 backend 实例同步状态（ND9）、解析 scope（ND10）。

> controller/service 不在 web 侧膨胀：`http`/`events` 是 adapter，`eventReducer` 是纯投影，编排集中在 `client` 门面，UI 不含会话业务逻辑。

---

## 4. Failure & Decision Points（失败点与决策点）

| 用例 | 失败/决策点 | web 预期行为 |
|------|------------|-------------|
| UC1 | token 失效 → `401` | 进 `disconnected`，提示"重启 `ohbaby serve` / 重新打开" |
| UC1 | clients/snapshot 请求失败 | 停在 `connecting`，可重试，不静默 |
| UC2 | `202` 后链路中断（run 进行中） | **不自动重放 prompt**（对齐 server N3）；据 ConnectionState 提示用户重提 |
| UC2 | abort 与 run 自然结束竞态 | 以 `run.updated` 为准，UI 不抢先标记终态 |
| UC3 | 审批错主 → `403` | 提示"该审批属于另一连接"，不误标为已处置 |
| UC3 | 待决时断线 | resync 后据新 snapshot 重建队列——该请求可能已被它端处置而消失 |
| UC4 | `resync-required` | 必须丢弃 ViewState 重建，**绝不静默错位**（核心正确性） |
| UC4 | 重连退避 | 有上界，不紧循环空转 |
| UC5 | 命令目录拉取失败 | 不执行命令，显示可关闭错误，draft 保留 |
| UC5 | 未知/不可用命令 | 不发送到 daemon，显示解析错误 |
| UC5 | 命令执行失败 | 通过 `CommandNotice` 显示错误，不吞掉 |
| UC5 | 命令带交互 action | 不进入候选面板；手写 POST 也被 server 400 拒绝 |
| UC5 | 未接线命令（connect/compact） | 不进入候选面板，不展示伪表单 |

> 这些失败点与 [`test.md`](./test.md) 的 Critical Scenarios 一一对应。
