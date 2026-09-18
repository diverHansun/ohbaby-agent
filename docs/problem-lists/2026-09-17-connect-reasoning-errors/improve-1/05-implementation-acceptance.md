# 5. 实施与验收记录

> 状态：本地临时分支验收中；不代表发布批准。代码尚未合并或推送。
>
> 分支：`temp/connect-reasoning-errors-improve-1`；基线：`985e8f06`。

## 5.1 实施范围

| Stage | 已实施的行为 | 关键验证 |
|---|---|---|
| 1 温度与档位资料 | Connect 保存删除旧温度；读取旧配置也不带温度；请求缺省不传温度。同一精确协议、地址、模型的能力资料继续复用，切换模型后可恢复先前已确认的档位。 | writer、manager、apply、LLM client 单测及集成测试 |
| 2 档位界面 | Web 检测中转圈，未知显示 `unknown`；不能关闭推理的模型仍能选强度。TUI `/effort` 检测中显示 loading，识别后更新档位。 | Web App、TUI 契约测试；真实 Web 模型切换与 high/low/medium 选择 |
| 3 地址提醒 | 请求资源路径重复风险只提醒，不改写、不拦截。仅 ZenMux 主机 + Anthropic 协议 + `/api/v1` + `anthropic/claude-sonnet-5` 给出 `/api/anthropic` 建议；Chat/Responses 和其它 Anthropic 模型不误报。 | SDK、Web、TUI 测试；真实 Claude 地址对照 |
| 4 运行错误 | 已识别的温度废弃和余额不足错误映射为固定、安全的原因；未知上游正文不进入持久化错误。Web/TUI 展示同一份已保存的 prompt 错误，下一次运行时不让旧错误占位。 | error-detail、Web App、TUI 契约测试 |

## 5.2 真实请求

用 `tests/models-4-tests.md` 对应的真实密钥和模型，调用应用内完整 agent loop。审查依据为本地 `.ohbaby/test-evidence/improve-7/live-loop/` 下的审计 JSON；该目录没有纳入 Git。

| 协议 | 模型 | 结果 | 本地审计文件 |
|---|---|---|---|
| OpenAI Responses | `openai/gpt-5.6-luna` | E1 完整循环成功，保存最终回复 | `zenmux-gpt56-luna-responses-context-e1-1789661529451-audit.json` |
| OpenAI Chat | `deepseek/deepseek-v4.1-flash` | E1 完整循环成功，保存最终回复 | `zenmux-deepseek-v41-chat-e1-1789661587017-audit.json` |
| Anthropic | `anthropic/claude-sonnet-5`，`/api/anthropic` | E1 完整循环成功，包含工具调用及结果 | `zenmux-claude-sonnet5-anthropic-context-e1-1789661658522-audit.json` |

另一次 Luna `stage-a` 运行没有通过**测试脚本的严格工具顺序断言**：模型先调用 `skill`，得到工具业务错误，再成功调用 `read` 并完成回复。HTTP 与回复本身正常，但这次不计为 `stage-a` 通过；审计文件为 `zenmux-gpt56-luna-responses-context-stage-a-1789661330752-audit.json`。

真实 Web `/connect` 与对话验收：

- Luna Responses 保存成功，选 `high` 后收到预期回复。
- DeepSeek Chat 保存成功，选 `low` 后收到预期回复。
- ZenMux `google/gemini-3.8-flash` 通过 Chat 协议保存成功；主动探测返回上下文窗口 `1,048,576`，界面给出 `minimal/low/medium/high/xhigh` 五档。新会话选 `medium` 后，真实对话收到预期回复。探测显示的五档来自该模型的实际能力资料，不沿用 DeepSeek 档位。
- Claude Anthropic 用 `https://zenmux.ai/api/v1` 完整发送：`high/medium` 与输出上限 `8192/4096` 的尝试均返回 HTTP 500，项目内重试耗尽；失败在 Web 可见。该结果与先前**最小** Anthropic HTTP 200 不矛盾：请求形状不同，最小请求不足以证明完整应用运行可用。
- 同一 Claude 模型改用 `https://zenmux.ai/api/anthropic`，`medium`、输出上限 `4096`，完整 Web 对话收到预期回复。故地址提醒只覆盖上述精确组合，不推断其它 ZenMux 模型、路径或网关。
- 最终构建的 Web 中，把 Claude Sonnet 5 设为 Anthropic + `/api/v1` 可见专用警告且“Save model”仍成功；把模型改为其它 Anthropic 名称后警告消失。验证后连接恢复到 Gemini Chat。

## 5.3 自动化与审查

- 最终 `pnpm run preflight` 通过：格式、lint、类型检查、**362 个测试文件 / 3750 项测试通过**（另 6 个文件、17 项跳过），所有包和 Web 构建成功。临近收尾对 TUI 模型编辑时的实时 warning 计算做了两行修订，另跑对应 TUI/SDK/后台推理测试与静态检查。
- 子代理完成阶段性代码审查，指出上游错误正文可能回显未知格式密钥；现改为固定文案，并增加对抗性测试。还指出 TUI 协议输入的防御性边界，已补有效协议检查。
- 回归曾发现已保存的推理能力遇 429 时没有标记 `stale`。已用现有 `background-reasoning.integration.test.ts` 复现并修复，目标测试 5/5 通过。

## 5.4 仍需收尾

1. 按 Stage 提交；等待用户审查。不要合并到 main 或推送。

本记录如实区分“真实请求通过”“脚本断言失败”与“尚待验收”。
