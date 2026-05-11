# personal-agents 04 — 借鉴、警惕与微调建议

本文是参考资料目录的**最终回归**：综合 `01-overview` 的项目定位、`02-mechanism-comparison` 的机制对照、`03-problem-comparison` 的问题对照，整理 ohbaby-agent 应**借鉴**什么、应**警惕**什么、有哪些**实现与文档脱节的细节**值得引以为戒，以及当前可以做的**微调建议**（仅建议，不给具体 diff）。

任何被采纳的建议**应反映到对应模块的 `goals-duty.md` / `architecture.md`**，本文档不承担规范作用。

---

## 一、应该借鉴的设计

### 1. Hermes：session_key 与 session_id 的二元结构

**来源**：`gateway/session.py:594` `build_session_key()`

**做法**：
- session_key 由 `(platform, chat_type, chat_id, thread_id, user_id)` 拼出，**确定性**
- session_id 是每次 reset 后的唯一 epoch
- 同一用户始终走同一 key（路由稳定），但 idle/daily 重置换新 id（上下文清零）

**借鉴意义**：当 ohbaby 未来支持"同一用户跨会话续聊"或"多端共享 session"，把"会话身份"和"会话生命周期"分离比塞进一个 ID 干净得多。即使现阶段单进程 SDK 不需要，**把字段命名规划好可以避免日后改 schema**。

**应用位置**：`runtime/sessions`。

---

### 2. OpenClaw：wake-coordinator 的合并窗 + 优先级 + busy-skip-reason

**来源**：`src/infra/heartbeat-wake.ts`，公网索引 <https://docs.openclaw.ai/gateway/heartbeat>（注意公网描述的是上层 agent-tick，不是这里的下层 wake-coordinator）

**做法**：
- 250ms 合并窗（多次唤醒请求合并为一次）
- 优先级：immediate / manual > retry > scheduled > default
- busy-skip 显式 reason：`requests-in-flight` / `cron-in-progress` / `lanes-busy`

**借鉴意义**：ohbaby 当前 `runtime/heartbeat` 是**上层语义**（agent 状态机：active/paused/blocked/sleeping），处理"agent 现在能不能干活"。一旦 cron + outbound delivery + hook + scheduled retry 同时往 agent 推，需要一个**下层 work-pacer** 解决"现在该不该真的开一轮"。

**应用位置**：未来在 `runtime/heartbeat` 之外新增 `runtime/wake-coordinator`，或在 heartbeat 内部新增一个独立的 pacer 子组件（不要污染 HeartbeatMachine 的状态语义）。

---

### 3. OpenClaw / Ohbaby 共有：把"断层"做成显式协议事件

**来源**：
- OpenClaw：客户端 `lastFrameId` + `onGap` 主动重连
- Ohbaby：`stream-bridge` 的 `stream.gap` 协议事件

**借鉴意义**：方向已经一致，**保持**。具体可强化两点：
1. 当 `stream-bridge` 切到 SSE/WebSocket 实现，可借 OpenClaw 的"per-connection lastFrameId"做更细的恢复粒度（per-event id 之外加 per-frame id）
2. `stream.gap` 事件的 payload 应包含 `oldestRetainedEventId`（已规划），让 client 立即知道要从哪里恢复

---

### 4. Hermes：恢复的"新鲜度窗口"

**来源**：`gateway/run.py:177`，配置 `HERMES_AUTO_CONTINUE_FRESHNESS`

**做法**：进程崩溃后，session 标记 `resume_pending`，但只有"transcript 最后活动 < 1 小时"才允许续起来；否则丢弃 in-flight 状态，开新 epoch。

**借鉴意义**：ohbaby 的 `interaction-broker` 已经声明"pending interaction 不持久化"，但 **`run-ledger` 的 in-flight run 在重启后该如何处理没有显式策略**。Hermes 这条"新鲜度窗口"是个朴素而有效的兜底：避免从 12 小时前的死状态复活。

**应用位置**：`runtime/run-manager` 与 `runtime/run-ledger` 的恢复策略文档。

---

### 5. OpenClaw：session 编码 trust level + 对应沙箱模式

**来源**：<https://ppaolo.substack.com/p/openclaw-system-architecture-overview>

**做法**：session 标识本身（`agent:main` / `agent:<channel>:dm:<id>` / `:group:<id>`）就编码了信任级别，对应不同的工具访问与沙箱策略。

**借鉴意义**：ohbaby 现在没有 multi-tenant 需求，但**未来若需要支持远程接入或 multi-user**，这个模型比 Hermes 的"PII hash 注入 system prompt"稳健得多。Hermes 的方案依赖 LLM 自觉把 hash 当 ID 处理，是脆弱的协议假设。

**应用位置**：未来引入 `runtime/connectivity` 或 `runtime/security` 时，session 类型应内含 trust level，而非额外字段。

---

### 6. OpenClaw：device pairing 用本地 keypair + OS keychain

**来源**：`src/gateway/device-auth.ts`，参考 <https://skywork.ai/skypage/en/openclaw-gateway-pairing/2037432393570009088>

**做法**：设备本地生成 keypair，公钥注册到 gateway，私钥存系统 keychain。token 长期有效，设备元数据变化触发 re-pair。

**借鉴意义**：当 ohbaby 未来引入远程接入，**避免学 Hermes 的"短码 + 文件 allowlist"模式**：短码 + 文件方式简单但不可扩展，每次新设备都需要操作员介入。OpenClaw 的设备身份模型在第一次 pair 后即"自动"。

**应用位置**：`runtime/connectivity` 子模块（暂不存在）。

---

## 二、应该警惕的设计

### 1. Hermes：在 system prompt 里塞 PII hash

**问题**：`gateway/session.py` 的 `build_session_context_prompt()` 在 system prompt 中注入 hashed user_id（安全平台）或真实 ID（不安全平台）。这要求 LLM 把 hash 当 ID 看待。

**警惕原因**：
- LLM 行为不是协议保证；不同模型对 hash vs ID 的处理可能不同
- 一旦 LLM 把 hash 误认为可读字符串、暴露给工具调用，会造成信息泄漏
- 真正的 multi-tenant 隔离应该在协议层做，而不是依赖 prompt 自觉

**对 ohbaby 的含义**：未来 multi-tenant **不要走这条路**。优先 OpenClaw 的"session 编码 trust level + 工具访问层硬隔离"。

---

### 2. OpenClaw：服务端不持久化 session

**问题**：客户端断线重连时从头重建，1–5s 延迟。

**警惕原因**：
- 该取舍对 OpenClaw 的"实时控制平面"定位合理，但**不适合 ohbaby 的"进程内 SDK + 稳定 transcript"定位**
- 别被它的简洁性诱惑去掉持久化

**对 ohbaby 的含义**：**保持当前方向**——SQLite 单写入者 + run-ledger 持久化。

---

### 3. Hermes：把"崩溃恢复"挂在 IM 收消息上

**问题**：`resume_pending` 必须等下一条用户消息触发。

**警惕原因**：
- 对 IM 场景对（用户输入是天然驱动）
- 对 SDK 场景**完全不对**（client 重连不带用户输入语义）

**对 ohbaby 的含义**：恢复机制必须是**主动**的（如 stream-bridge 的 `stream.gap`），不能等"下一次外部输入"。

---

### 4. OpenClaw：`heartbeat` 一词同时承担两层完全不同的职责

**问题**：见下文"三、其它细节 - 矛盾点 1"。

**警惕原因**：命名混淆是工程交流成本中**最被低估的来源**。

**对 ohbaby 的含义**：详细见"四、微调建议 (D)"。

---

### 5. OpenClaw：daemon 模块自带 OS 服务注册

**问题**：`src/daemon/` 包含 launchd plist / systemd unit / Windows Task Scheduler 注册逻辑。

**警惕原因**：把进程托管揉进 runtime 代码，让 daemon 模块同时做"装配"和"系统集成"两件事，违反单一职责。OpenClaw 这么做是产品需求（要给非技术用户 one-click 安装）。

**对 ohbaby 的含义**：**保持当前方向**——`runtime/daemon` 只做装配，进程托管由 systemd / launchd / pm2 / Docker 承担。已在 daemon `architecture.md` 第四节"放弃的方案"里明确，继续守住。

---

## 三、其它细节（含两个矛盾点）

### 矛盾点 1：OpenClaw 的 "heartbeat" 实际上是两个完全不同的东西

**事实**：
- 公网文档（<https://docs.openclaw.ai/gateway/heartbeat>）描述的 heartbeat：
  - 默认 30 分钟一次，Anthropic OAuth 模式 1 小时
  - 给 agent 喂 prompt（"读 HEARTBEAT.md，无事可做回 HEARTBEAT_OK"）
  - 是 **agent-level 语义触发器**
  - 明确声明"不是 TCP keepalive"，且 heartbeat-only 回复**不阻止 idle 过期**
- 代码 `src/infra/heartbeat-wake.ts` 中的 `requestHeartbeat`：
  - 250ms 合并窗 + 优先级队列
  - 处理 cron / hook / outbound 等内部事件源
  - 是 **infra-level wake coordinator**

**这是同一个名字下并存的两层完全不同的机制**。任何只读公网文档或只读代码的人，对"heartbeat"的理解都会偏。

**含义**：
- 在外部讨论中引用 OpenClaw heartbeat 时**必须明确指代上层还是下层**
- ohbaby 设计自己的同类机制时，**给两层不同的名字**（详见微调建议 D）

### 矛盾点 2：Hermes 的 pairing 短码长度，公网文档与代码不一致

**事实**：
- 公网 DeepWiki（<https://deepwiki.com/NousResearch/hermes-agent/7.4-security-and-pairing>）声称 12 字符
- 仓库代码 `gateway/pairing.py:151` 实际是 8 字符（去除 0/O/1/I 的 32 字符不混淆字母表）
- 仓库为准

**含义**：
- 引用外部项目时**必须以源码为准，文档作辅助**
- 对 ohbaby 的启示：`docs/runtime/*` 与 `src/runtime/*` 应保持同步评审节奏，避免我们自己变成同样的反例。建议在 PR 模板里加一项"对应模块的 architecture.md 是否需要更新"

### 其它细节

- **OpenClaw "single gateway per host" 是被 WhatsApp 单设备协议强制约束**（公网博客明确指出）。这在 ohbaby 当前模型下天然满足（SQLite 单写入者），但**还没显式声明理由**。建议在 daemon 文档加一句"single daemon per data dir"作为约束。
- **Hermes 的 cron tick 是 60s 轮询粒度**，对 IM 场景够用，但**不要拿来作为 ohbaby scheduler 设计的参考**。ohbaby 应坚持事件驱动 + DeferredQueue 模型，而不是周期轮询。
- **OpenClaw 的 channel adapter 用 `stall-watchdog` 检测无活动通道**，是另一种"心跳"思路（探测对端，不是主动 ping）。ohbaby 的 stream-bridge `stream.gap` 在思想上更接近 stall-watchdog 而非主动 ping，方向正确。

---

## 四、ohbaby 可以做的微调（建议，不给 diff）

### (A) daemon 文档加一节"进程外接入边界"

**位置**：`docs/runtime/daemon/goals-duty.md` 或 `architecture.md` 的"职责边界"段。

**建议内容**：显式声明
- daemon **不暴露** WebSocket / HTTP 等远程入口
- daemon **不做** 设备配对、节点在线感知、跨进程身份验证
- 这些职责由未来的 `runtime/connectivity` 子模块承担（暂不存在）

**理由**：避免日后做"远程接入"时把代码塞到 daemon 里，重蹈 hermes gateway 14 文件、openclaw daemon 兼任 OS 服务注册的覆辙。

---

### (B) interaction-broker 留好"远程响应者"扩展点

**位置**：`docs/runtime/interaction-broker/architecture.md` 的"对外稳定接口"。

**建议内容**：在 `respond(interactionId, response)` 的接口形状里**预留** `responderContext` 字段（当前可为 `undefined`）。文档中说明"未来支持远程响应时承载身份/通道信息，现阶段同进程调用可省略"。

**理由**：现在不实现，但接口形状一旦定型，未来加 multi-actor 响应不需要破坏 SDK 协议兼容性。

---

### (C) heartbeat 的 disposition 通用化

**位置**：`docs/runtime/heartbeat/architecture.md` 的 `Disposition` 类型定义。

**建议内容**：把当前的 `accepted / deferred / rejected / started` 扩展为带 `reason` 字段的对象（沿用 OpenClaw 的 `requests-in-flight` / `cron-in-progress` / `lanes-busy` 这类显式 reason）。

**理由**：为未来引入 wake-coordinator（建议 D）预留同一组事件 schema，避免事件协议分裂。

---

### (D) 命名警告：未来引入 wake-coordinator 时**不要叫 heartbeat**

**位置**：`docs/runtime/heartbeat/goals-duty.md` 的"职责边界"段，同时在 `_references/personal-agents/04-takeaways.md`（即本文）保留警示。

**建议内容**：明确写"如果未来需要引入下层 work-pacer / wake-coordinator，**不复用 heartbeat 这个名字**"。建议名字：
- `wake-coordinator`（取自 OpenClaw 实际语义）
- `work-pacer`（强调"节奏控制"）
- `tick-merger`（强调"合并窗"）

**理由**：避免重蹈 OpenClaw "heartbeat 一词承担两层" 的覆辙（见矛盾点 1）。**ohbaby heartbeat 当前已经占了"agent 状态机"的语义**，这个语义不要被稀释。

---

### (E) PR 模板加一项"对应模块文档同步"

**位置**：`.github/PULL_REQUEST_TEMPLATE.md`（如不存在则新建）。

**建议内容**：勾选项 "[ ] 对应模块的 `docs/runtime/*/architecture.md` 与本 PR 改动一致"。

**理由**：避免我们重蹈 Hermes "公网文档说 12 字符、代码 8 字符" 的覆辙（见矛盾点 2）。文档与代码的脱节是项目演进过程中**最容易发生且最难补救**的腐烂。

---

### (F) daemon 文档加约束："single daemon per data dir"

**位置**：`docs/runtime/daemon/architecture.md` 第四节"约束与权衡"。

**建议内容**：显式约束 "同一数据目录（含 SQLite）只能有一个 daemon 实例"，理由是"SQLite 单写入者 + run-ledger 一致性"。pid 文件已经实现了这个约束，但**理由没写**。

**理由**：把隐式约束变成显式契约，避免未来做"集群部署"时误以为可以多实例。

---

### (G) sessions 模块设计时采纳"key vs id 二元结构"

**位置**：`docs/runtime/sessions`（如尚未存在则新建）。

**建议内容**：参考 Hermes session_key vs session_id 模型（见借鉴 1）。即使 ohbaby 当前是 SDK 场景没有"路由"概念，**预留这个分离**未来若引入跨进程接入会感谢自己。

---

## 五、与模块文档的衔接

下表标注每条建议**采纳后应落到哪个模块文档**：

| 建议 | 模块 | 文档 |
|---|---|---|
| (A) 进程外接入边界 | daemon | goals-duty / architecture |
| (B) responderContext 扩展点 | interaction-broker | architecture |
| (C) Disposition 带 reason | heartbeat | architecture |
| (D) 命名警告 | heartbeat | goals-duty |
| (E) PR 模板 | （仓库根） | `.github/` |
| (F) single daemon per data dir | daemon | architecture |
| (G) key vs id | sessions | architecture |

**采纳路径**：
1. 在对应模块文档先开 PR 写入决策与理由
2. 在本文档（04-takeaways）相应条目追加 "✅ 已采纳，见 `<模块路径>`"
3. 不要让本文档变成"建议堆"——采纳后**及时收编**，未采纳的定期重审

---

## 六、未触及的设计空间

下列方向三家都没有完整答案，本系列对照不下结论，列出供未来设计参考：

- **多 daemon 实例的协同**（hermes 不支持 / openclaw single per host / ohbaby 单进程）
- **灰度 / 蓝绿部署的 in-flight 切换**（三家都缺）
- **跨设备实时 session 共享**（hermes mirror 是日志级；openclaw 节点共享 gateway 但仍 trust 分层；ohbaby 不涉及）
- **弱网环境的协议优化**（三家都依赖 TCP/WS 默认行为）

ohbaby 若需要进入这些方向，应回到 `01-overview` 重新评估"我们到底是什么定位"，而不是直接抄某一家的方案。
