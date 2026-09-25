# ohbaby-server · use-case（用例编排）

> 说明职责如何落为可执行的业务动作（先做什么、由谁负责），不写实现。
> 前置：[`goals-duty.md`](./goals-duty.md)、[`architecture.md`](./architecture.md)、[`dfd-interface.md`](./dfd-interface.md)。

---

## 1. Use Case Overview（用例概览）

| UC  | 动作                                             | 追溯职责 |
| --- | ------------------------------------------------ | -------- |
| UC1 | Serve Backend（前台启动并暴露 backend）          | D1, D6   |
| UC2 | Handle RPC Call（处理前端 RPC 调用）             | D2       |
| UC3 | Subscribe & Replay Events（订阅事件并断线补发）  | D3       |
| UC4 | Route Permission Request（同根会话多页共享审批） | D3       |
| UC5 | Queue Prompt Runs（prompt 串行调度）             | D3       |
| UC6 | Attach Remote Client（显式连接已有 server）      | D5       |

---

## 2. Main Flow Description（主流程）

### UC1 Serve Backend

1. 接收 `ohbaby serve` 启动意图（host/port/token/cors 选项）。
2. lifecycle/foreground 装配 transport（Hono）+ 注入 backend 工厂。
3. 套上 auth + CORS 中间件，挂载 jsonrpc/web 路由。
4. 绑定监听，输出 ServerHandle（**打印 address + token + 停止方式**）。
5. 收到 Ctrl+C → 优雅关闭。

### UC2 Handle RPC Call

1. 接收 RPC 请求。
2. auth 校验（失败 fail-closed 拒绝）。
3. CORS 放行（web 跨 origin）。
4. 协议适配器解析 → 调用 `CoreApiHost`。
5. 返回结果 / 错误信封。

### UC3 Subscribe & Replay Events

1. 前端建 SSE，可带 `Last-Event-ID`。
2. event-bus 判定补发区间（见失败点）。
3. 先补发缓冲内 `(Last-Event-ID, now]`，再转实时。
4. 持续广播新 EventEnvelope；前端更新 cursor。

### UC4 Route Permission Request

1. REST 注册或 RPC initializeClient 通过 `getSessionIndex()` 建立客户端独立根会话绑定，不读取聊天历史；没有选择时 root 为 null，不返回全局审批。
2. 安装 SSE 订阅后发送 hello，携带 permissionEpoch、rootSessionId、bindingGeneration；初连、重连与选择成功都触发审批独立同步。
3. backend 同步提交审批后，经专用订阅投递 requested/resolved/unavailable。permission-router 在认证 workspace 内按 root 过滤；同 root 的多页共享，子会话不能作为审批入口。
4. `GET /v1/permissions` 与 RPC getPermissionSnapshot 读取同一独立基线。查询和回答携带预期 epoch/root/bindingGeneration，异步范围验证后再次核对绑定；server 不按发起 client 独占审批。
5. `POST /v1/permissions/:id` 与 RPC respondPermission 校验公开 choice 并交给 backend 一次决议。已合法回答可幂等完成；已撤销/未知 ID 返回 PERMISSION_NOT_PENDING，客户端重新同步。公开返回仍为 Promise<void>，成功回执不代表工具已执行。
6. 页面切换或全部断连不撤销请求。单连接写入失败关闭该连接；严重权威故障返回 PERMISSION_UNAVAILABLE，冻结受影响 root，其他 root 继续工作。

### UC5 Queue Prompt Runs

1. prompt 请求进入。
2. 按 session 归入 PromptLane（同 session FIFO）。
3. lane 内逐个驱动 backend；完成后取下一个。

### UC6 Attach Remote Client

1. `ohbaby attach <url>` 用 remote `UiBackendClient` 连接。
2. 走同一 `UiBackendClient` 契约（与 in-process 等价）。
3. 连接失败只报错，**不自动启动、不重放**（N2/N3）。

---

## 3. Responsibility Boundaries（责任边界）

| 步骤                                     | 本包负责            | 外部负责                                  |
| ---------------------------------------- | ------------------- | ----------------------------------------- |
| 鉴权/CORS/路由                           | ✅ auth + transport | —                                         |
| 协议信封解析                             | ✅ protocols        | —                                         |
| 排队/审批路由/事件打号缓冲               | ✅ coordination     | —                                         |
| **agent run 实际执行、工具调用、持久化** | ❌                  | ✅ ohbaby-agent backend                   |
| 选 local/remote 模式                     | ❌                  | ✅ ohbaby-agent 的 core-api-factory（N2） |
| UI 渲染                                  | ❌                  | ✅ ohbaby-cli / web 前端                  |

防胖原则：本包是"传输+协调"的薄层，**绝不把领域执行逻辑吸进来**。

---

## 4. Failure & Decision Points（失败点与决策点）

| 场景                                      | 本包预期行为                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| **重连请求的 `Last-Event-ID` 早于缓冲窗** | 不静默丢；明确返回"需全量重同步"信号，前端重新拉取完整状态（关键正确性点）  |
| auth 缺失/错误                            | fail-closed 拒绝，绝不放行（修 S4）                                         |
| web 跨 origin 未在白名单                  | 拒绝预检；不默认全开（修 S2 的同时不牺牲安全）                              |
| server 断开（attach 模式）                | 提示用户重新提交 prompt，**不自动重放**（N3）                               |
| 客户端断连但已有排队未启动的 prompt       | 需决策：清理待决项 vs 继续执行（S9，迁移时定，倾向清理待决、不取消已启动）  |
| 同 session 多写者竞争                     | 单写者不变量：由 server 仲裁串行；非 server 路径由文件锁/lease 拒绝或只读化 |

---

## 自检

- 每个 UC 都能追溯职责？✅ 见概览表。
- 是否把外部行为误写成自身职责？无——agent run / 持久化 / 模式选择均划归外部。
- 是否过细侵入实现？无类名/函数名。
- 是否至少一类关键失败点？✅ replay 窗口外重同步为核心失败点。
