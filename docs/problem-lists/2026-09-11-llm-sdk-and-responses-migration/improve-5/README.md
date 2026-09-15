# improve-5 · 三协议缓存观测与可信 Step 累计

> 2026-09-14 开始研究；2026-09-15 用户确认关键取舍并授权撰写文档。状态：实施完成，最终 preflight 与基本三协议实网通过；扩展八组通过、百炼 Responses 一组未通过，详见 05。
> 基线：`codex/improve-4-usage-calibration@114f1e512fb77a3ffef144a9886414fc37a0bd80`。实施分支：`codex/improve-5-cache-accounting`，承接全部规划文档；完成分批实施与独立审查，仅本地分批提交，暂不 merge/push。

> 第二轮实网复验（2026-09-15）：加入 DeepSeek V4 Flash、Claude Sonnet 5、GPT-5.6 Luna 后共14组，11组完整通过、3组未通过；参数省略诊断也未使两组原生模型完整通过。逐项命中率及兼容缺口见 [06 复验报告](./06-real-cache-revalidation.md)。

让 Chat Completions、Responses 和 Anthropic Messages 的可信单步缓存用量进入同一主代理 session 累计。某一步没有缓存读取明细，只跳过这一步；保留其他步骤及历史累计。Web/TUI 继续仅在 `/status` 显示 `hit N%` 或 `hit —`。

## 阅读顺序

| 文档                                                                                | 职责                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------ |
| [00-discussion](./00-discussion.md)                                                 | 用户确认的新规则、范围与原话         |
| [01-problem-analysis-and-current-state](./01-problem-analysis-and-current-state.md) | 当前代码、旧规则与实际缺口           |
| [02-optimization-plan-and-change-scope](./02-optimization-plan-and-change-scope.md) | 后续实施合同、数据入口与改动面       |
| [03-reference-projects](./03-reference-projects.md)                                 | 七个本地项目的事实与取舍             |
| [04-test-and-acceptance](./04-test-and-acceptance.md)                               | 固定样本、集成边界、真实观测与验收门 |
| [05-implementation-acceptance](./05-implementation-acceptance.md)                   | 本轮实施后记录实际结果与验收证据     |
| [06-real-cache-revalidation](./06-real-cache-revalidation.md)                       | 第二轮模型替换、命中率对比与兼容缺口 |

00 约束产品语义，02 定义实施目标，04 定义验收。01 是基线事实，不能用它的旧行为覆盖 02。实际实现、测试数字、失败与适配限制以 05 为准。

## 与前四轮及旧缓存方案的关系

- improve-1 升级 SDK；improve-2 接入受限 Responses provider；improve-3 整理内部 LLM 类型；improve-4 核对用量与校准合同。本轮承接 improve-4 已主动切出的 cache 统计议题，用户明确要求开启，非按实施次数另分轮。
- 基线已经解析 Responses 缓存读取与写入明细，本轮并非从零增加 parser。主要变化在纳入粒度和消费链路。
- [2026-08-27 session-cache-hit](../../2026-08-27-session-cache-hit/README.md) 中“只收完整 Run、任一步缺明细则整 Run 跳过”的规则，被本轮 00/02 **由本轮实现替代**；01 中仍保留旧基线事实。
- session 累计、输入 token 加权、主代理展示、未知与零分开、换模型和压缩不清空、进程重启归零等旧合同继续保留。旧 00–05 保留历史，不追溯改写当时验收。
- improve-4 的 `usageComplete`、总用量聚合、校准入参及调用时机保持原义。缓存统计不再拿 Run 完整性作为所有 Step 的共同门槛。

## 明确边界

本轮包含单步可信判断、一次记账、异常后保留已有数据、session 隔离、子代理已有记录验证、SDK/CLI/Web 一致性，以及三协议实际用量观测。

本轮不改变 system prompt、前缀布局、`cache_control`、缓存 key、TTL、Responses observe-only 策略；不改窗口占用、校准、压缩算法；不增加覆盖率/缺失计数/提示字段；不把子代理用量合入主界面；不建立跨重启缓存账本或失败请求估算；不扩大 Responses 原生续接能力。

实施按 02 的 Stage A–C 推进，同属 improve-5。没有未决产品问题；实施时若发现必须扩大以上边界，应提出具体原因，不能把候选功能自动加入本轮。
