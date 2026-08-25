# Context 参考项目源码调研索引

> 本目录保存六个本地项目的逐项目源码勘测。它们是 [03-reference-projects.md](../03-reference-projects.md) 的补充证据，不是 OhBaby 的规范或实施进度记录。

## 使用规则

- 以具体符号和调研基线定位；行号只作快照，代码演进后允许漂移。
- 明确区分 production、rewrite、scaffold 和本地镜像；“存在源码”不等于“已进入生产路径”。
- 只借鉴机制与因果，不复制框架、目录或事件溯源形式。
- 正式 adopt/adapt/reject 结论以 `03-reference-projects.md` 为准，测试 ID 以 `04-test-and-acceptance.md` 为准。

## 报告地图

| 项目 | 报告 | 重点 | 边界提醒 |
|---|---|---|---|
| DeepSeek Harness | [deepseek-harness.md](./deepseek-harness.md) | durable compaction bracket、busy/stale orphan、property、SIGKILL | event-sourced session；不能照搬到 MessageStore |
| Claude Code Best | [claude-code-best.md](./claude-code-best.md) | summary prompt-too-long 收缩、失败熔断、cache break diagnosis | 本地镜像，不代表 Anthropic 官方协议 |
| Codex | [codex.md](./codex.md) | raw/normalized view、deterministic repair、compact/resume/fork、Memory | 类型名与 memories 运行路径以当前源码为准 |
| Kimi Code | [kimi-code.md](./kimi-code.md) | replay、summary overflow shrink、revision recheck、resume parity、scope | observed provider window 只记录为 P2，不纳入本轮实现 |
| OpenCode | [opencode.md](./opencode.md) | production compaction、claims、cache、timing regressions | `packages/opencode` production 与 `packages/core` rewrite 必须分开 |
| Pi | [pi.md](./pi.md) | append-only projection、manual/auto concurrency、retry/abort | 下一代 harness/lanes 尚含 scaffold，不当作现行能力 |

## 对 OhBaby 最直接的证据映射

| OhBaby 风险 | 主要参考证据 | 进入正式契约 |
|---|---|---|
| summary request 自身 overflow | Claude Code、Codex、Kimi；OpenCode 反例是 overflow 后 stop | D9、CMP-13 |
| compaction 部分写与 crash | DeepSeek、Kimi resume parity、Pi append-only projection | D4、CMP-03～07/12、LIF-09 |
| 同 scope auto/manual 竞态 | Pi 7150/7253、Kimi history revalidation | D8、CMP-09a～09c、LIF-08 |
| deterministic tool repair/cache prefix | Codex UUIDv5 repair、Kimi fold/projector repair | D10、INV-04/10/13、PFX-12 |
| primary/subagent scope | 六项目各自的 session/scope 边界 | INV-08/11、SCP-01～11 |

## 当前完整性

六份报告均已有可阅读的 A～F/G 结构。Kimi 原始调研回传从 D 节开始，本轮已依据同一调研基线补齐 A～C；补齐内容只整理已核实源码，不新增 OhBaby 决策。
