# personal-agents 02 — 按机制对照

本文按"机制名"维度对照 hermes-agent / openclaw / ohbaby-agent。每个机制先给一行总览表，再展开关键差异。读者可作为查阅手册按机制定位。问题视角的对照见 `03-problem-comparison`。

---

## 一、总览：机制对照矩阵

| 机制 | hermes-agent | openclaw | ohbaby-agent（现状） |
|---|---|---|---|
| **Gateway 形态** | IM 平台适配器集合（Python） + TUI gateway（WS+stdio JSON-RPC） | 单端口 WebSocket 多路复用器（127.0.0.1:18789） | 不存在；daemon 仅装配，不暴露远程入口 |
| **Daemon 进程模型** | 自托管，用户用 systemd/screen 启动 | daemon 模块自动注册 launchd/systemd/Task Scheduler | Composition Root + Supervisor，**不做进程托管** |
| **Pairing** | IM 一次性短码（8 字符，去除 0/O/1/I） + 速率限制 + 失败锁 | 操作员审批 + 设备 keypair 签名 + 本地 keychain | 不涉及（同进程） |
| **Session 模型** | session_key (确定性路由) ≠ session_id (上下文 epoch)；idle/daily 重置 | trust 分层：`agent:main` / `dm:<id>` / `group:<id>`，对应不同沙箱策略 | run-ledger + sessions 模块（设计中） |
| **Stream 回传** | GatewayStreamConsumer：40 字符阈值 + 1 秒节流，progressively edit IM 消息 | Frame `lastFrameId` + `onGap` 客户端重连，per-conn 序号 | RingBuffer + `stream.gap` 协议事件，per-scope 单调 eventId |
| **Heartbeat** | 不存在显式心跳；靠 session 时间戳推断活跃度 | **两层并存**：上层 agent-tick（30min）+ 下层 wake-coordinator（250ms 合并窗，代码内） | agent 状态机：active / paused / blocked / sleeping + DeferredQueue |
| **Presence** | 隐式（IM 通道在线状态由平台保证） | 显式 `node.presence.alive` 事件 + 版本广播 + 60–120s 摘除 | 不涉及 |
| **Multi-channel routing** | DeliveryRouter：`origin` / `local` / `<platform>` / `<platform>:chat:thread` | 通道适配规范化为 `{channel, from, to, text, threadId}` + stall watchdog | 不涉及 |
| **断线/崩溃恢复** | `resume_pending` + 1 小时新鲜度窗口；下一条用户消息触发恢复 | 客户端 `lastFrameId` + `onGap`；服务端不持久化 session | interaction-broker 显式声明"pending interaction 不持久化"；run-ledger 持久化 |
| **配对/工具桥** | 平台原生（@bot 等） | MCP stdio 服务器作为 LLM 工具桥 | 直接由 SDK 调用 |

---

## 二、Gateway 对照

### Hermes：平台适配器集合

```
gateway/
├── platforms/        # 一平台一文件
├── session.py        # SessionStore，确定性 session_key
├── delivery.py       # DeliveryRouter，目标解析
├── stream_consumer.py# 流式编辑
├── pairing.py        # 一次性短码
├── mirror.py         # 跨平台 transcript 镜像
└── ...

tui_gateway/
├── server.py         # JSON-RPC dispatch（stdio 与 WS 共用）
├── ws.py             # WebSocket handler
└── transport.py      # ThreadPoolExecutor 路由
```

**形态特征**：每个 IM 平台一个 adapter，共用 session/delivery/stream，所有 adapter 在同一个 Python 进程里。TUI gateway 是另一条入口，给 CLI 和 Web。两者**不共享传输层**，但共享 agent loop。

### OpenClaw：单端口 WebSocket 多路复用

```
src/gateway/
├── server/ws-connection.ts  # 帧协议：Request / Response / Event
├── device-auth.ts           # v3 签名 payload
└── server/presence-events.ts# 节点 presence 广播
```

**形态特征**：所有客户端（macOS app / iOS / Android / CLI / Web 扩展 / MCP）都连同一个 WebSocket 端口，靠帧 `method` 与 `role` 字段区分。一台机器一个 gateway 实例（被 WhatsApp 单设备协议强制约束，公网博客明确指出）。

参考：<https://docs.openclaw.ai/concepts/architecture>、<https://ppaolo.substack.com/p/openclaw-system-architecture-overview>

### Ohbaby：不存在 gateway

`runtime/daemon` 是 Composition Root，仅做依赖装配 + 信号处理 + pid 文件，**显式声明不暴露远程入口**。所有对外协议事件通过 `runtime/stream-bridge` 的 app scope 投递，由调用方（未来的 server / SDK adapter）自己决定如何暴露给外部。

---

## 三、Daemon 进程模型对照

| 项 | hermes | openclaw | ohbaby |
|---|---|---|---|
| 进程托管位置 | 用户自管（systemd / screen / launchctl） | 项目自带：launchd plist / systemd unit / Windows Task | 显式不做（系统工具承担） |
| 单例保护 | 平台 lock | gateway 端口绑定 | pid 文件 + 文件锁 |
| 重启语义 | 无优雅 handoff | `launchd-restart-handoff` 保持 socket | 10s 超时强退 |
| 关闭顺序 | 不显式 | 不显式 | 显式反向拓扑（heartbeat → ... → database） |

**关键差异**：openclaw 把"daemon 注册到 OS 服务"也封进了项目代码，hermes 与 ohbaby 都把这件事推给系统工具。**ohbaby 的取向更接近 hermes**，两者都认为"进程监督是系统的事"。

---

## 四、Pairing 对照

### Hermes：IM 一次性短码

源码 `gateway/pairing.py:151`：
- 8 字符（去除 0/O/1/I 的 32 字符不混淆字母表）
- 速率限制：每用户每 10 分钟 1 次
- 失败 5 次锁 1 小时
- 存储：`~/.hermes/pairing/{platform}-pending.json` 与 `-approved.json`，权限 0600
- TTL：1 小时；待审批最多 3 个

> ⚠️ 公网文档（<https://deepwiki.com/NousResearch/hermes-agent/7.4-security-and-pairing>）声称"12 字符"，与代码不符。详见 `04-takeaways` 第三节。

### OpenClaw：设备身份签名

源码 `src/gateway/device-auth.ts`：
- v3 payload：`deviceId + clientId + mode + role + scopes + signedAtMs + nonce + token? + platform + deviceFamily`
- 本地 keypair 签名，token 落系统 keychain（macOS Keychain / Windows Credential Manager）
- 配对流程：未知设备发 challenge → 操作员 `openclaw pairing approve <channel> <code>` → 颁发 token
- 重连用 token，无需再走 challenge

参考：<https://skywork.ai/skypage/en/openclaw-gateway-pairing/2037432393570009088>

### Ohbaby

不涉及。未来若引入远程接入，需要单独的 `runtime/connectivity` 子模块决定走哪条路（短码 vs 设备签名）。

---

## 五、Session 对照

### Hermes：key vs id 二元结构

`gateway/session.py:594` `build_session_key()`：
- session_key 由 `(platform, chat_type, chat_id, thread_id, user_id)` 拼出，**确定性**
- session_id 是每次 reset 后的唯一 epoch（时间戳 + 8 字符 UUID）
- 同一用户始终走同一 key（路由稳定），但 idle（默认 30 min）/ daily 重置会换新 id（上下文清零）

### OpenClaw：trust 分层 session

公网博客（<https://ppaolo.substack.com/p/openclaw-system-architecture-overview>）描述：
- `agent:main` — 操作员，原生执行（无沙箱）
- `agent:<channel>:dm:<id>` — DM，默认 Docker 沙箱
- `agent:<channel>:group:<id>` — 群组，默认 Docker 沙箱

**session 编码 trust level**，决定工具访问策略和沙箱模式。

### Ohbaby

`runtime/sessions/` 模块设计中。当前文档未明确 key/id 是否分离，也未引入 trust level 概念。

---

## 六、Stream 回传对照

| 项 | hermes | openclaw | ohbaby |
|---|---|---|---|
| 抽象层级 | 单条 IM 消息的渐进 edit | 帧序号 + gap 检测 | 事件流 + gap 协议事件 |
| 单调序号粒度 | 无显式（按消息 edit） | per-connection `lastFrameId` | per-scope `eventId`（app + run/<runId>） |
| 节流策略 | 40 字符阈值 + 1 秒节流（IM 平台限频） | 帧大小：18KB pre-auth，更大 post-auth | RingBuffer 容量限制 |
| 断点恢复 | platform-side 消息可见性 | 客户端发 `onGap` 主动重连 | bridge 发 `stream.gap` 让 client 拉 snapshot |

**ohbaby 的方向与 openclaw 一致**：把"断层"做成显式协议事件，而不是悄悄丢掉或伪造连续。

---

## 七、Heartbeat 对照（重要：openclaw 内部存在两层）

### Hermes：不存在显式 heartbeat

活跃度推断：
- session 的 `updated_at` 时间戳
- idle / daily 重置触发器
- `has_active_processes_fn` 防止重置带工具运行的 session
- 客户端连接靠平台 TCP keepalive

### OpenClaw：上层 agent-tick + 下层 wake-coordinator

**两个完全不同的东西，共用 "heartbeat" 这个名字**：

**上层（公开文档定义）**：
- 默认 30 分钟一次（Anthropic OAuth 模式下 1 小时）
- 给 agent 喂一段 prompt（"读 HEARTBEAT.md，如无事可做回 HEARTBEAT_OK"）
- agent 可发起工具调用、可送通知
- 明确声明"不是 TCP keepalive"，且 heartbeat-only 回复**不阻止 idle 过期**
- 来源：<https://docs.openclaw.ai/gateway/heartbeat>

**下层（代码 `src/infra/heartbeat-wake.ts`）**：
- `requestHeartbeat({ source, intent })`，意图 = `scheduled / event / immediate / manual`
- 250ms 合并窗，多个请求合并成一次执行
- 优先级：immediate / manual > retry > scheduled > default
- busy-skip 原因：`requests-in-flight` / `cron-in-progress` / `lanes-busy`
- 本质是 wake coordinator / work-loop pacer

ohbaby 的 `runtime/heartbeat` 偏向"上层"语义但侧重不同（agent 状态机：active / paused / blocked / sleeping），**与 openclaw 这两层都不完全对应**。详细的命名警告见 `04-takeaways` 第三节。

---

## 八、Presence 对照

| 项 | hermes | openclaw | ohbaby |
|---|---|---|---|
| 模型 | 隐式（平台保证） | 显式 `node.presence.alive` 事件 | 不涉及 |
| 触发源 | — | `background / silent_push / bg_app_refresh / significant_location / connect / manual` | — |
| 广播 | — | 版本号化的 snapshot 广播 | — |
| 摘除策略 | — | 60–120s 无 alive 摘除 | — |

OpenClaw 的 presence 设计是**为 mobile background execution 量身定制**的。iOS silent push、Android Doze mode 这些场景下，连接不可能保持，只能靠 OS 触发的事件汇报"我醒了"。ohbaby 当前不涉及移动端，无需引入；但若未来接 mobile，**presence event-based 模型比 TCP keepalive 更现实**。

---

## 九、Multi-channel routing 对照

### Hermes：DeliveryRouter

`gateway/delivery.py` 解析 target：
- `origin` — 回到消息源 chat
- `local` — 写 `~/.hermes/cron/output/`
- `<platform>` — 该平台的 home channel（env 配置 `TELEGRAM_HOME_CHANNEL` 等）
- `<platform>:<chat_id>:<thread_id>` — 显式寻址

超长消息（>4000 字）存盘并把路径回填消息体。

### OpenClaw：通道规范化 + stall watchdog

通道（WhatsApp / Telegram / Slack / Discord / Signal / iMessage / Matrix）适配为统一形：`{channel, from, to, text, threadId, metadata}`。`src/channels/transport/stall-watchdog.ts` 检测无活动通道，触发重连。

### Ohbaby

不涉及。

---

## 十、本文档与模块文档的关系

本对照只描述外部项目当前形态，**不规范 ohbaby 行为**。任何"该不该借鉴"的判断在 `04-takeaways`。任何被采纳的借鉴必须落到对应模块的 `goals-duty.md` / `architecture.md`，本文档不承担规范作用。
