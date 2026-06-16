# ohbaby-server · non-functional（非功能约束）

> 只写对本包真正重要的工程约束，不写通用最佳实践清单。前置：[`goals-duty.md`](./goals-duty.md)、[`dfd-interface.md`](./dfd-interface.md)。

---

## 1. Quality Priorities（质量优先级，有序）

1. **事件投递正确性 > 一切**：SSE 断线不得静默丢事件。前后端状态发散是正确性 bug，不是体验问题（S1）。replay 或"需重同步"信号二选一，绝不沉默。
2. **可预测性 > 吞吐**：默认 CLI 不经过本包；server 失败必须可解释（启动失败/认证失败/连接失败/已退出），而非隐式重连掩盖。
3. **显式生命周期 > 便利**：宁可让用户手动 `serve`/`attach`/停止，也不要隐藏后台进程（这是 daemon 痛点根因）。
4. **实现简单 > 远程能力**：当前阶段优先把本机 CLI+web 跑稳，不追求 LAN/多用户。

---

## 2. Operational Constraints（运行约束）

- **绑定范围**：默认仅 `127.0.0.1`，不开放 LAN（N4）。远程绑定+TLS 是后续触发点。
- **单写者**：后面只有一个 backend，所有写经 server 串行仲裁；本包不做多 backend 聚合（G5）。
- **内存有界**：EventRingBuffer 必须有容量上界，旧事件淘汰；不得无界增长拖垮长跑 server。
- **进程形态**：foreground 为主路径，靠终端管生命周期；detached 降级、不打磨（N6）。
- **吞吐已知限制**：`__fresh__` lane 跨客户端过度串行（S8）属已知约束，迁移时再优化，不在本期硬指标内。

---

## 3. Reliability & Observability（可靠性与可观测性）

- **鉴权 fail-closed**：token 未配置/不匹配一律拒绝，常量时间比较（修 S4）。不接受 fail-open。
- **不静默失败**：replay 窗口外、auth 拒绝、CORS 拒绝都要有明确响应/信号，前端可据此动作。
- **连接状态可感知**：建议经 sdk 暴露 `ConnectionState`（connected/reconnecting/closed），让前端区分"在连/断开/已关"。
- **server 端结构化日志**：记录连接建立/断开、replay 区间、auth 拒绝原因，便于回溯一次会话的投递路径。default CLI（in-process）无此负担。
- **断连不自动重放 prompt**：可自动重连传输，但 prompt 必须用户重提（避免重复执行/扣费，N3）。

---

## 4. Trade-offs & Deferred Requirements（权衡与暂缓）

| 暂缓项 | 原因 |
|--------|------|
| LAN 绑定 / mDNS / TLS / 多用户 authn-z | ohbaby 是即开即关 coding CLI，非全天候服务（N4/N6）；远程 app 立项再做 |
| detached 后台常驻打磨 | 同上，foreground 已覆盖本机 web/attach |
| 领域事件投影层（A1） | CLI+web 共用 UiEvent 无痛点，YAGNI（N5）；ACP/A2A 接入时再补 |
| 队列吞吐优化（S8 fresh-lane） | 正确性已满足，吞吐非本期瓶颈，记 backlog |
| OpenAPI / 协议文档自动化 | 协议成员只有 jsonrpc+web，未到投资点 |

> 提醒：以上是**刻意延后**，不是遗漏缺陷。

---

## 自检

- 写了有序优先级而非全部并列？✅。
- 至少一类运行约束？✅ 绑定/内存/单写者。
- 失败处理 + 可观测性？✅ fail-closed / 不静默 / 连接状态 / 日志。
- 至少一项暂缓？✅ LAN/detached/投影/吞吐。
- 避免最佳实践大全？✅ 全部绑定本包语境。
