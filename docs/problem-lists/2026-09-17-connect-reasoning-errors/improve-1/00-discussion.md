# 讨论记录与已确认要点

> 2026-09-17 与用户讨论定稿。正式方案见 01–04。
> 来源：发布前三项 Web 故障排查会话、`tests/models-4-tests.md` 真实三协议请求、Anthropic / OpenAI 官方 API 文档。

---

## 1. 背景与动机

v0.1.13 发布前 Web 出现三类现象：ZenMux OpenAI（Luna Responses）发出去没有回复；Gemini 显示「推理默认 · 检测中」且慢；Claude Sonnet 5 显示「推理默认」，长时间等待后自动停止。最初向 Claude 的 `/api/v1` 地址发出的最小 Anthropic Messages 请求返回 200，因此当时不能据此断定地址错误。旧温度被继承、未知档位被写成中文默认、发送失败对用户沉默都已确认。2026-09-18 的完整请求对照进一步定位了该地址与 `/api/anthropic` 的差异，见文末更新。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/problem-lists/2026-09-17-connect-reasoning-errors/improve-1/` |
| 轮次 | 一轮 `improve-1`；实施分 Stage，不预开 improve-2 |
| 关键改动清单 | **写**：精简承重项（路径 + 符号 + 行号快照），禁止全量文件表 |
| 未知档位文案 | 英文 `unknown`；不要中文「推理默认」 |
| 检测中 | 大脑**只转圈、不写字**；转圈只表示「档位还在确认」 |
| `/effort` | 检测中显示 loading，不要空列表或假档位 |
| 关不了思考 | 强度按钮**不消失**；没有 Off 选项，但整颗控件仍在 |
| 温度 UI | **不做**温度卡片，`/connect` 也不加温度框 |
| 温度请求 | **不主动传**；交给服务端默认。产品加载路径忽略 `model.json` 里的温度键（旧 0.7 不重存也不上线）。Chat/Anthropic provider 仍允许请求对象显式带温度（单测与未来 UI）；本轮没有温度框，手改 json 也不会发出去 |
| OpenAI Responses | 保存时清空 `temperature`；禁止输入（无框即禁止）；请求里不出现该字段 |
| Anthropic + 思考 | 不传温度。官方：思考开启时温度只能是 `1` 或不传；Claude 4.7+ / Sonnet 5 即使思考关着，非默认温度也 400 |
| Base URL × 协议 | 保存前只提醒有证据的风险；**不改写、不拦截保存**。2026-09-18 的完整 Web 请求证明 ZenMux `/api/v1` + Anthropic Claude Sonnet 5 连续返回 500，`/api/anthropic` 成功，因此增加此精确组合的提醒；最小请求 200 不再作为完整运行可用的证据 |
| 发送失败 | 有限暴露原因，含服务端 400/401/402 一类错误 |
| 错误展示 | Web 与 TUI **吃同一份 run 错误**（`UiPromptError`），不多处设计错误提示字段 |
| `model.json` | 动态配置：每次编辑保存后字段可增删改查；读取当前配置走现有 `getCurrentModel()` |
| 档位缓存 | 按目标模型的协议、地址和名称查已有 profile；匹配且能力可信就保留。A→B→A 也保留 A 已确认的档位 |
| 大脑转圈很久 | 本轮先这样，不改 probe 超时 |

## 3. 已确认：真实请求（不传温度）

2026-09-17 对 `tests/models-4-tests.md` 三种消息接口做最小真实请求（不跑 agent 工具）。**不传 `temperature` 全部 HTTP 200。**

| 组合 | 不传温度 | 传 `0.7` |
|------|----------|----------|
| Luna Chat | 200 | 200 |
| Luna Responses | 200 | **400** `Unsupported parameter: 'temperature'` |
| DeepSeek Chat / Responses / Anthropic（含 thinking） | 200 | Chat 传 0.7 也 200 |
| Claude Anthropic（默认） | 200 | **400** `` `temperature` is deprecated for this model `` |
| Claude Anthropic + adaptive thinking | 200 | **400** `temperature may only be set to 1 when thinking is enabled` |
| GLM Chat | 200 | 200 |
| Qwen Chat / Anthropic（含 thinking） | 200 | 200（Dashscope 更松，仍不主动传） |

因此「干脆都不做温度、也不主动传」不仅是 KISS，而且是唯一能同时避开 Luna Responses 与 Claude Sonnet 5 的路径。不给 Anthropic 注入 `temperature: 1`。

## 4. 已确认：错误提示现状判断

| 通道 | 现状 |
|------|------|
| 连接 / 保存 / SSE hello | Web 横幅、TUI connect 错误**已有** |
| 发送失败（run 已启动） | **展示缺失**：失败后 `runtime` 拉回 idle；空失败助手被丢掉；Web 在 userMessage 已进会话后不再投影 failed prompt |
| 400 正文 | 后端**已抹平**为 `LLM provider request failed`，即使展示也看不到 `temperature is deprecated` |
| 401/403 | 后端有认证失败映射，但发送路径 UI 看不到 |
| 402 | 无单独映射，与 400 一样变成那句空话 |

结论：发送失败是**双缺**（展示 + 400/402 原因被抹掉），不是只缺 UI。补法是改 `normalizeRunError` 的有限暴露，并让 Web/TUI 渲染同一条 `prompt.error`。

## 5. 已确认：边界（不做的事）

| 项 | 本轮不做 |
|----|----------|
| 温度输入框 / 温度卡片 | 不是必需字段 |
| 按协议分叉「Chat 保留 0.7、Responses 清空」作为产品默认 | Chat 也不主动传；分叉只留在「手改 model.json 之后协议层仍允许」 |
| 自动改写 Base URL | 只提醒 |
| 把 ZenMux `/api/v1` 一概判错 | Chat、Responses 不因这个路径告警；Anthropic 只针对完整 Claude 请求已复现的组合给非阻断提醒 |
| 直接复制 DeepSeek v4 Flash 的 builtin 给 v4.1 Flash | 已探测的 v4.1 档位与 v4 不同，先继续使用精确 profile/probe |
| 调整 30s probe 超时 | 先接受转圈久 |
| Agent 配置里的 `agents.*.temperature` | 另一条配置面 |
| 为 Web 和 TUI 各发明错误字段 | 只用现有 `UiPromptError` |
| 本规划会话写代码 | 实施另开会话 |

## 6. 已确认：与关联议题的关系

| 文档 | 关系 |
|------|------|
| [llm-sdk-and-responses-migration improve-2](../../2026-09-11-llm-sdk-and-responses-migration/improve-2/00-discussion.md) | 当时写「temperature 跟 Chat 一样发」。**本议题在产品 Connect 路径上取代该条**：缺省不传。协议层仍允许请求对象带可选温度。 |
| [improve-5.5 真实 native 推理](../../2026-09-11-llm-sdk-and-responses-migration/improve-5.5/06-real-native-reasoning-validation.md) | 测试 profile 已省略 temperature；与本轮产品默认对齐，但当时未改 writer 继承。 |
| [improve-5 真实缓存复测](../../2026-09-11-llm-sdk-and-responses-migration/improve-5/06-real-cache-revalidation.md) | 已记录 Claude / Luna 因温度 400；当时只在测试包装层临时省略，明确没改生产参数管理。本轮补上生产侧。 |
| [`docs/core/llm-client/architecture.md`](../../../core/llm-client/architecture.md) | 仍可「为请求填充 temperature」——语义改为**有才填**。不必把该文档改成「禁止温度类型」。 |

## 7. 用户确认记录

- 2026-09-17：未知写 `unknown`；检测中只转圈；关不了思考则按钮不消失；Responses 清温度且请求不出现该字段；Chat 可不主动传；Anthropic 查官方后不传温度；URL 轻量提醒；发送失败有限暴露；`model.json` 动态 CRUD；不新建温度卡片；同路由重存保留档位；Web/TUI 同一份 run 错误。
- 2026-09-17：同意 KISS——没有 `/connect` 温度框就不做温度，也不主动传，保持服务端默认。
- 2026-09-17：文档落点确认为本目录；02 写精简关键改动清单。
- 2026-09-17：用三种真实消息接口测清单模型；最小请求不传温度全部可行。此结果不能证明 Claude 带工具的完整 agent 请求可行。
- 2026-09-17：复核后确认 `/api/v1` + Anthropic 最小请求返回 200；DeepSeek v4.1 已探测档位不能照搬 v4；Claude 完整运行 500 必须在发布前复测。
- 2026-09-18：真实 Web 对照中，Claude Sonnet 5 + Anthropic + `/api/v1` 在 high/medium、输出上限 8192/4096 均得到 HTTP 500 并重试耗尽；同模型 medium + 4096 + `/api/anthropic` 正常回复。用户确认增加仅针对该地址/协议组合的非阻断提醒。
