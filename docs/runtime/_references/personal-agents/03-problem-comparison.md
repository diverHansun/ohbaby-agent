# personal-agents 03 — 按问题对照

本文按"工程问题"维度对照 hermes-agent / openclaw / ohbaby-agent。每个问题先给一行对照表，再给数据流或场景说明。当你正在解决某个具体问题时，从本文入手；想横向了解某个机制时，看 `02-mechanism-comparison`。

---

## 一、总览：问题对照矩阵

| 工程问题 | hermes 的答 | openclaw 的答 | ohbaby 的答 |
|---|---|---|---|
| Q1 设备如何被信任接入 | IM 一次性短码 + 速率限制 | 操作员审批 + 设备 keypair 签名 + 本地 keychain | 不涉及（同进程） |
| Q2 用户消息如何路由到 agent | 平台 adapter → SessionStore → AgentLoop | WS Frame → method dispatch → Agent Runtime | SDK 直调 |
| Q3 agent 输出如何流式回到设备 | StreamConsumer：按 40 字符 + 1 秒节流 edit IM 消息 | WebSocket Event Frame，client 用 `lastFrameId` 检测 gap | stream-bridge 发事件，client 用 `stream.gap` 拉 snapshot |
| Q4 远端如何被定时唤醒 | scheduler 每 60s tick，调 DeliveryRouter | cron + heartbeat-wake 250ms 合并窗 | scheduler + Heartbeat.SignalDisposition 协议 |
| Q5 多设备同时在线如何感知 | 不涉及（IM 平台保证） | `node.presence.alive` 事件 + 版本广播 | 不涉及 |
| Q6 多通道路由怎么做 | DeliveryRouter（origin / local / platform / 显式 chat:thread） | 通道规范化 `{channel, from, to, text, threadId}` + stall watchdog | 不涉及 |
| Q7 进程崩溃后 in-flight 状态怎么处理 | `resume_pending` + 1 小时新鲜度窗口，靠下条消息触发 | 客户端从头重连；服务端不持久化 session | pending interaction 不持久化；run-ledger 持久化 |
| Q8 跨平台/跨设备 transcript 如何一致 | mirror.py 写"delivery-mirror"条目到双方 transcript | 节点共享同一 gateway，无需镜像 | 不涉及 |
| Q9 untrusted 输入与 trusted 输入如何隔离 | PII hash 注入 system prompt（contentious） | session 编码 trust level，对应不同沙箱 | 暂无；security 方向待定 |

---

## 二、Q1 — 设备如何被信任接入

**Hermes（IM 一次性短码）**：

```
未知用户首次 DM
  │
  ▼
SessionStore 检测：not in allowlist
  │
  ▼
gateway/pairing.py:151
  │ 生成 8 字符短码（去除 0/O/1/I）
  │ 存 ~/.hermes/pairing/{platform}-pending.json (0600)
  │ 速率限制：每用户每 10 分钟 1 次；失败 5 次锁 1 小时
  ▼
回复用户：'你的配对码是 ABCD2345，请在终端运行 hermes pairing approve ABCD2345'
  │
  ▼
operator 在 host 上运行该命令 → approved.json
  │
  ▼
后续消息直接放行
```

**OpenClaw（设备签名 + token）**：

```
新设备首次连 WS（role: node）
  │
  ▼
device-auth.ts 校验 v3 payload 签名
  │ 包含 deviceId / clientId / mode / scopes / signedAtMs / nonce / platform / deviceFamily
  │
  ▼
未知 deviceId → 拒绝；触发 issuePairingChallenge
  │
  ▼
operator 在 host 运行 'openclaw pairing approve <channel> <code>'
  │
  ▼
颁发 device token（落 macOS Keychain / Windows Credential Manager）
  │
  ▼
后续连接带 token，免再 challenge；元数据变化需重新 pair
```

**对照点**：
- hermes 的 trust 边界是"用户身份"（IM user_id）；openclaw 的 trust 边界是"设备身份"（deviceId + 签名）
- hermes 在 pending 阶段就回复短码；openclaw 在审批后才颁 token
- hermes 短码 1 小时 TTL，openclaw token 长期有效（直到设备元数据变化）

---

## 三、Q3 — agent 输出如何流式回到设备

**Hermes**：受限于 IM 平台编辑频率（Telegram ~1Hz）：

```
agent 工作线程
  │ on_delta(text) — 同步回调
  ▼
GatewayStreamConsumer.queue (asyncio)
  │ 缓冲 40 字符
  │ 节流 1 秒
  ▼
edit 同一条 IM 消息（光标"▉"）
  │
  ▼
工具边界 / 长输出 → finalize 当前消息，开新条；
长 preview（>配置时长）发新消息而非 edit final
```

**OpenClaw**：WebSocket 帧序列：

```
agent 工作
  │ produces event frames
  ▼
WS Connection (per device)
  │ each frame: { type, id (lastFrameId+1), method?, data }
  ▼
Client 收到 frame，记录 lastFrameId
  │
  ▼
检测到序号跳跃 → onGap callback → reconnect 时带 lastFrameId 让 server 补发
```

**Ohbaby**：进程内 RingBuffer + gap 协议事件：

```
runtime/run-manager
  │ publish(scope, event, data)
  ▼
InMemoryStreamBridge
  │ scope = 'app' | 'run/<runId>'
  │ 分配 per-scope 单调 eventId
  │ append 到 RingBuffer（覆写最旧）
  ▼
subscribe(scope, lastEventId?) → AsyncIterable
  │ 若 lastEventId < buffer.oldestId - 1 → 发 stream.gap 事件
  │ client 收到 stream.gap → 调 getSnapshot() 重建状态
```

**对照点**：
- hermes 解决"IM 平台限频" → 节流 + edit
- openclaw 解决"长连接断线重连" → 帧序号
- ohbaby 解决"进程内消费者断点续传 + 未来 SSE 切换" → 事件 id + gap 协议

三者都不静默丢弃，都把"断层"变成显式协议事件 —— 这是个**正确的方向，可作为 ohbaby 的设计共识**。

---

## 四、Q4 — 远端如何被定时唤醒

**Hermes**：scheduler 每 60s tick（`cron/scheduler.py`），到期 job 直接执行 agent，输出经 DeliveryRouter 投递。**简单粗暴的轮询**。

**OpenClaw**：两层叠加：
- 上层 agent-tick heartbeat（30 min / 1 hour）— 让 agent **自己**周期性检查"有没有 urgent follow-up"
- 下层 wake-coordinator (250ms 合并窗) — 处理 cron / hook / outbound 等内部事件源

**Ohbaby**：
- `runtime/scheduler` 触发 `Scheduler.Event.JobFired`
- `runtime/heartbeat`（HeartbeatMachine）订阅，根据 agent 状态决策（active 立即跑 / paused 入 DeferredQueue / sleeping 判断提前唤醒）
- 通过 `Heartbeat.Event.SignalDisposition` 回报 `accepted / deferred / rejected / started`

**对照点**：
- 三者都有"定时机制"，但**协调粒度差别巨大**
- hermes 60s 粒度对 IM 场景够用，但若引入秒级响应需求会捉襟见肘
- openclaw 的 250ms 合并窗 + 优先级 + busy-skip-reason 是**最成熟的 wake coordinator 模型**
- ohbaby 的 HeartbeatMachine 是**更高语义层**（agent 状态机），与 openclaw 下层是正交的

---

## 五、Q5 — 多设备同时在线如何感知

**Hermes / Ohbaby**：不涉及。

**OpenClaw**：

```
设备启动
  │ WebSocket 连入 gateway
  ▼
节点发 'node.presence.alive' { reason: 'connect' }
  │
  ▼
gateway upsertPresence()
  │ 维护节点列表（含 last seen, capabilities）
  │
  ▼
broadcastPresenceSnapshot()
  │ 带 stateVersion 的 snapshot
  │ dropIfSlow=true（慢 client 不阻塞广播）
  ▼
所有连接的客户端收到更新

设备进入后台
  │ iOS silent push / Android bg-app-refresh / location event
  ▼
节点发 'node.presence.alive' { reason: 'silent_push' }
  │
  ▼
（同上广播）

>60–120s 无 alive → gateway 摘除节点
```

**关键设计**：alive 事件携带 `reason` 字段，**让服务端理解节点为什么醒着**（用户主动 / 后台 / 推送 / 位置变化）。这对调度策略有用：iOS 后台短窗口期内只能跑短任务，不能下发长任务。

---

## 六、Q7 — 进程崩溃后 in-flight 状态怎么处理

**Hermes（懒恢复）**：
- session 标记 `resume_pending=True`
- 等下一条用户消息触发 → 检查"transcript 最后活动 < 1 小时"（`HERMES_AUTO_CONTINUE_FRESHNESS`）→ 续 session_id
- 不主动恢复，**因为 IM 场景天然由用户输入驱动**

**OpenClaw（客户端重建）**：
- 服务端不持久化 session
- 客户端重连时带 `lastFrameId`
- 重建延迟 1–5s 可接受

**Ohbaby（显式声明持久化边界）**：
- `interaction-broker` 文档明确："pending interaction 不持久化，daemon 重启后全部失效"
- `run-ledger` 持久化 run 状态
- 没有"新鲜度窗口"概念

**对照点**：
- hermes 的"懒恢复 + 新鲜度窗口"对 SDK 场景**不适用**（SDK client 重连不带用户输入语义）
- openclaw 的"客户端重建"是合理的工程取舍，但 ohbaby 持久化 run-ledger 的方向更稳健
- **可借鉴**：把"哪些状态在重启后保留 / 哪些丢弃"显式写在 daemon 文档里，目前 ohbaby 只在 interaction-broker 里写了一条

---

## 七、Q9 — untrusted 输入与 trusted 输入如何隔离

**Hermes（PII hash）**：
- 安全平台（Telegram）：system prompt 注入 hashed user_id
- 不安全平台（Discord/Slack 需要原始 ID 做 @mention）：注入真实 ID
- **依赖 LLM 把 hash 当 ID 用**

**OpenClaw（session trust level + 沙箱）**：
- `agent:main` — 操作员，原生执行
- `agent:<channel>:dm:<id>` / `:group:<id>` — 默认 Docker 沙箱
- system prompt 仍是"软指引"，**真正的强制来自通道访问控制和沙箱**

**Ohbaby**：
- 暂无对应机制
- 未来若需要 multi-tenant，**openclaw 的 session-编码-trust 模型比 hermes 的 hash 注入更稳健**（详见 `04-takeaways`）

---

## 八、问题清单的留白

下列问题在三家中**都没有完美答案**，留作未来设计参考：

| 问题 | 现状 |
|---|---|
| 多个 daemon 实例的协同 | hermes 不支持；openclaw 明确"single gateway per host"；ohbaby 单进程模型 |
| 灰度 / 蓝绿部署的 in-flight 切换 | 三家都没有 |
| 跨设备的 session 共享（同用户 PC + 手机看同一对话） | hermes mirror 是日志级，不是实时；openclaw 节点共享 gateway 但 session 仍按 trust 分层 |
| 弱网环境的协议优化 | 三家都不优化（依赖 TCP / WS 默认行为） |

---

## 九、本文档与 02 / 04 的衔接

- **想看"机制怎么实现"** → `02-mechanism-comparison`
- **想看"ohbaby 该怎么办"** → `04-takeaways`
- **本文档的定位** → 把"问题"作为索引，方便在解决具体场景时快速定位别人的解法
