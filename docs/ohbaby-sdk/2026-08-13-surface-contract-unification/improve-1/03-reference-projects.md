# 3. 优秀项目借鉴

> 参考用于验证取舍，不作为照搬理由。路径均为 2026-08-13 本机可读仓库。

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|------|------|----------|
| Codex | `/Users/hansunwork26/workspace/projects/code-cli/codex` | core Op/Event 与 app-server 对外具名 RPC 的分层 |
| OpenCode | `/Users/hansunwork26/workspace/projects/code-cli/opencode` | OpenAPI/SDK、具名 HTTP 方法、多客户端共享合同 |
| Kimi Code | `/Users/hansunwork26/workspace/projects/code-cli/kimi-code` | node SDK RPC、protocol events、transcript 独立记录职责 |
| Kun | `/Users/hansunwork26/workspace/projects/code-cli/Kun/kun` | TUI client、HTTP route contract、RuntimeEvent/SSE |
| SpeedClaw | `/Users/hansunwork26/workspace/projects/SpeedClaw` | protocol Op/Event/envelope、TUI 和 appserver 边界 |
| ohbaby | 当前仓库 | UiBackendClient、UiEvent、fake-RPC、HTTP/SSE/JSON-RPC |

## 3.2 可借鉴点

| 项目 | 做法 | 对 ohbaby 的影响 |
|------|------|------------------|
| Codex | 内核数据可记录，对外仍提供语义清楚的具名 RPC | 采用“外层具名方法、下层记录”，不让 UI 直接喂通用 Op |
| OpenCode | 一份合同服务多个客户端，运输层负责 HTTP 细节 | SDK 成为权威能力；Web 不再手抄相同方法签名 |
| Kimi | RPC 边界与 transcript/记录职责分开 | `UiCommandRecord` 是记录事实，不成为新的调用协议 |
| Kun | 读写由具名 HTTP route 表达，事件走统一 runtime event | Query/Command 用于职责和记录边界；不要求 TUI HTTP 化 |
| SpeedClaw | 明确的命令/事件 ID 便于关联 | 借鉴“关联规则明确”，但保留 ohbaby 各领域 ID 的不同语义 |
| 多数项目 | 出站事件适合 discriminated union；入站命令常用具名方法 | 保留 `UiEvent` + 具名方法这一已有正确基础 |

## 3.3 明确不借鉴

| 项目/做法 | 不借鉴内容 | 原因 |
|-----------|------------|------|
| SpeedClaw / Codex core | 用单一 `Submit(Op)` 替代 SDK 具名方法 | ohbaby 已有可读调用面，重写只增加偶然复杂度 |
| OpenCode | 立即引入全套 OpenAPI 生成链 | 当前主要问题是语义而非生成器；可后置评估 |
| 任一项目 | 把运输 request ID 当作业务幂等 ID | 生命周期不同，重试时会破坏关联 |
| 任一项目 | 默认记录完整命令参数 | Prompt 与密钥输入存在直接泄露风险 |
| 任一项目 | 为审计先建数据库和回放产品 | 没有当前消费者与合规要求，违反 YAGNI |
| Kun/OpenCode HTTP 拓扑 | 让 TUI 也必须走网络 transport | ohbaby 同进程 TUI 是合理部署选择，不是缺陷 |

## 3.4 对 02 的直接影响

1. Codex 的“双层”影响 `UiCommandRecord` 只位于记录面，不取代具名方法。
2. OpenCode 的“一份合同”影响 Query/Command/Backend 成为 SDK 权威类型，并在 improve-2 让 Web 实现。
3. Kimi 的职责分离影响 recorder 不承担命令执行与 transport。
4. SpeedClaw 的 ID 可追踪性影响 correlation 设计，但 ohbaby 选择保留不同领域 ID，而不是制造单一万能 ID。
5. 参考项目都没有构成本轮引入审计数据库、CQRS 或新消息总线的证据，因此这些方案明确排除。
