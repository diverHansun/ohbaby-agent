# 3. 优秀项目借鉴

> 本轮沿用 improve-1 的本地参考仓库调研。参考只用于校验 surface 采用、client/facade 和事件流边界，不把其他项目的完整协议栈搬进 ohbaby。

## 3.1 参考问题

本轮只回答四个问题：

1. 多前端是否应依赖一份权威业务合同？
2. 有状态 SDK client 与应用 runtime/façade 是否可以同时存在？
3. in-process TUI 与浏览器 remote client 是否必须共用运输拓扑？
4. snapshot、实时事件、transport 控制消息应如何分层？

## 3.2 借鉴结论

| 项目 | 可验证做法 | 对 improve-2 的直接影响 |
|------|------------|--------------------------|
| OpenCode | 对外提供一份具名 API/合同，多客户端在各自 transport 层适配 | BrowserDaemonClient 直接实现 SDK 权威合同；HTTP wire 不成为第二业务 API |
| Codex | 内层协议/记录与外层人类友好方法分层；app runtime 仍可管理连接和状态 | 保留具名 SDK client，也保留 Web runtime façade；两者职责不同，不是重复 |
| Kimi Code | 同进程可用 fake-RPC 保留边界，transcript/事件与命令调用分工明确 | TUI 不为统一而改 HTTP；共享类型与语义即可 |
| Kun | HTTP 写、事件流读，runtime event 统一进入客户端状态 | Web 保持 HTTP command + SSE event；统一解包与分发而非新造总线 |
| Claude Code | 默认 CLI 生命周期与显式 server/remote 能力分开 | CLI/TUI 继续本地 host，Web/attach 才承担断线、重连、scope 等复杂度 |
| SpeedClaw | 命令和事件用关联 ID 追踪，但 surface 仍可有具名方法 | 延续 correlation 规则；不把 operationId 或 command record 塞进全部 Web event |

## 3.3 关于“双层”的校正

参考项目中的“双层”不等于两个 client 实现。对本项目准确映射为：

```text
业务层：UiBackendClient 的具名方法
记录层：UiCommandRecord 的统一结构
```

Web 中 `OhbabyWebRuntime` 是应用 façade，不是上述“记录层”，也不是第二业务 client。它管理浏览器上下文里 SDK 不应知道的 workspace、navigation、store 和连接生命周期。

## 3.4 关于单一事件流的校正

参考项目普遍区分：

- transport handshake/error/reconnect；
- 业务 event union；
- 当前状态 snapshot。

因此本轮不把 `hello`、`resync-required` 加进 SDK `UiEvent`。所谓“一条事件流”指业务事实进入客户端后走一个分发点，不表示网络层只能创建一次 socket，也不表示 HTTP snapshot 必须伪装成服务端 SSE 消息。

ohbaby 已有 `snapshot.replaced`，最小方案是 BrowserDaemonClient 在接收 HTTP snapshot 后本地构造该 `UiEvent`，复用同一 reducer/subscriber 顺序。sequence number 继续是 Web transport 的排序元数据，不扩大 SDK 全局事件合同。

## 3.5 明确不借鉴

| 做法 | 不采用原因 |
|------|------------|
| 为“一份合同”立即引入全套 OpenAPI codegen | 当前漂移可通过 SDK 类型依赖和 mapper 消除；生成链是独立投资 |
| 为让 TUI/Web 完全同形，把 TUI 改成 HTTP/SSE | 同进程直接调用更简单，网络拓扑不是合同统一的必要条件 |
| 新建通用 `BaseClient`、`SdkWebClient`、`BrowserClient` 多层继承 | 没有两种浏览器业务实现，抽象无第二消费者 |
| 让 runtime 逐方法代理全部 UiBackendClient | 这只会重建被删除的手抄接口，UI 可直接使用 `runtime.client` |
| 给每个 subscriber 单独连接 SSE | 连接、顺序、buffer 和 resync 会成倍复杂化 |
| 把 snapshot、hello、error 全塞进一个超大 union | transport 状态与 SDK 业务状态生命周期不同 |
| 把审计 recorder 放进 Browser client | 浏览器不是后端原子写的权威执行入口，且会与 Server 重复 |
| 为兼容永远保留旧 submit 和 feature detection | 本轮目标就是删除双轨；0.x 也需明确 breaking change |

## 3.6 对方案的约束性影响

1. 一份合同：促成 `BrowserDaemonClient implements UiBackendClient` 和 Web 手抄接口删除。
2. façade 合理：促成 `OhbabyWebRuntime` 保留浏览器专有生命周期，而不是塞入 SDK。
3. 拓扑按场景：促成 CLI/TUI 继续 in-process、Web 继续 REST+SSE。
4. 事件分层：促成 transport 控制消息留连接层、`UiEvent` 单点分发、snapshot 使用已有事件。
5. 不过度抽象：促成只保留一份 Browser client class，不增加继承体系、生成器或新消息总线。
