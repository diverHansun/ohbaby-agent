# 连接发送：温度、档位检测与 run 错误

> 状态：**实施与验收中**（本地临时分支，尚未合并或推送）。
>
> 日期：2026-09-17
>
> 议题：Connect / 发送路径上，旧温度字段、档位检测 UX、协议 URL 提醒、以及 provider 4xx 失败对用户不可见。

## 1. 议题

发布前在 Web 上看到三类现象：Luna（OpenAI Responses）发出去没有回复；Gemini 档位停在「推理默认 · 检测中」且回复慢；Claude 停在「推理默认」后长时间无答复再自动停止。它们涉及几处已确认的产品缺口，但不能认定为同一个根因：

1. `model.json` 里残留的 `temperature: 0.7` 被 writer 继承。Luna Responses 会在请求前因本地校验失败；最小 HTTP 请求证明 Luna Responses 和 Claude Sonnet 5 带此温度会返回 400。后续完整 Web 请求对照显示，Claude 在 ZenMux `/api/v1` 连续返回 500，改用 `/api/anthropic` 后成功。
2. 档位未确认时 UI 写成中文「推理默认」，检测中把大脑按钮换成文字；`/effort` 在检测中变成空列表。
3. 发送失败时账本里有错误，但 400 正文被抹成空话，Web/TUI 又把状态拉回 idle、丢掉空失败消息，界面像没发生过。

本轮把这三件事收成一次产品修复：**不传温度、档位英文 unknown / 转圈、同一份 run 错误有限暴露。**

## 2. 轮次地图

| 轮次 | 开启日期 | 触发事件 | 状态 | 文档 |
|------|----------|----------|------|------|
| improve-1 | 2026-09-17 | 首轮规划与实施 | 验收中 | [improve-1/](./improve-1/) |

只有一轮。实施若分多次会话，用 improve-1 的 02 Stage，不预开 `improve-2/`。

## 3. 本轮文档地图

| 文档 | 作用 |
|------|------|
| [improve-1/00-discussion.md](./improve-1/00-discussion.md) | 已确认产品决策与边界 |
| [improve-1/01-problem-analysis-and-current-state.md](./improve-1/01-problem-analysis-and-current-state.md) | 现状、代码锚点、真实三协议请求结果 |
| [improve-1/02-optimization-plan-and-change-scope.md](./improve-1/02-optimization-plan-and-change-scope.md) | 实施契约：Stage 1–4、改动面、关键改动清单 |
| 03 | **跳过**：无外部参考项目可借鉴；Anthropic / OpenAI / Zenmux / Dashscope 官方结论写在 01 |
| [improve-1/04-test-and-acceptance.md](./improve-1/04-test-and-acceptance.md) | 单测、回归与发布门 |
| [improve-1/05-implementation-acceptance.md](./improve-1/05-implementation-acceptance.md) | 实施、真实模型与 Web 验收记录 |

推荐阅读顺序：`00 → 01 → 02 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

## 4. In scope / Out of scope

**In scope**

- Connect 保存时删除并停止继承 `llmParams.temperature`；请求编译层不主动传该字段。
- 档位检测中只转圈；结束后未知显示英文 `unknown`；关不了思考则强度按钮保留。
- 同一协议 + 同一地址 + 同一模型重存，不清掉已确认档位。
- 保存前只对有证据的 Base URL 风险轻量提醒（不改写、不拦截）。ZenMux `/api/v1` + Anthropic Claude Sonnet 5 的完整 Web 请求连续返回 500，改用 `/api/anthropic` 后成功；仅此精确模型/协议/地址组合给出专用提醒，Chat/Responses 和其它 Anthropic 模型不误报。
- 发送失败与服务端 400/401/402 走同一份 `UiPromptError`；Web 与 TUI 只渲染它。
- `model.json` 在每次编辑保存后按现有 writer 做字段增删改查（含删除温度键）。

**Out of scope**

- 新建温度卡片或 `/connect` 温度输入框。
- 自动改写用户填写的 Base URL。
- 调整档位 probe 超时（大脑可转很久，本轮接受）。
- Agent 配置 `agents.*.temperature`。
- 为 Web / TUI 各写一套错误文案字段。
- 未验证能力就把 DeepSeek v4.1 Flash 复用为 v4 Flash 的 builtin 档位。
- 扩大至无证据的网关地址或模型组合。

## 5. 实施契约

已按 `improve-1/02` 与 `improve-1/04` 在本地临时分支实施。完成最终测试与用户审查前，不合并、不推送；Claude 须以完整 agent 请求和 Web 对话复测，不能用最小 HTTP 200 代替。
