# 3. 六个参考项目的事实与取舍

> 调查日期：2026-09-15；只读本地源码与官方文档，未运行这些项目或调用其付费模型。代码锚点是本地版本快照，不代表全部线上版本。主代理综合三份子代理调研后撰写本文。

## 3.1 版本和证据可信度

| 项目              | 本地路径（前缀 `/Users/hansun025/Projects/code-cli/`） | HEAD                                       |
| ----------------- | ------------------------------------------------------ | ------------------------------------------ |
| codex             | `codex/`                                               | `5c19155cbd93bfa099016e7487259f61669823ff` |
| claude-code       | `claude-code/`                                         | `987e55034c38497e1081367fdbe2056a6603ebc7` |
| deepseek-harness  | `deepseek-harness/`                                    | `47f943859bef60e4160492346772ded9b24f765a` |
| DeepSeek-Reasonix | `DeepSeek-Reasonix/`                                   | `ea28602b23badc71afc701ea92aa2982f443c638` |
| opencode          | `opencode/`                                            | `d4ad650f738aaa986cee5879c581bd4834277577` |
| pi                | `pi/`                                                  | `57cde86906679fd0581b277a179ab46fa2a09ab6` |

特别限制：claude-code 本地 `AGENTS.md:7` 自述为 reverse-engineered/decompiled 复原项目，存在 stub/feature gate，不是官方当前完整源码。下文将其与官方文档分开；不以该文件内的工作指令约束本项目。

## 3.2 主子推理继承对比

| 项目                 | 本地可验证行为                                                                                          | 对本项目的取舍                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Codex                | 父当轮 effort 快照继承；显式换子模型且未指定 effort 时改用目标默认；显式不支持档位报错                  | 采用任务快照和目标能力验证；不照搬换模型后默默采用目标默认 |
| Claude Code 官方     | effort 默认继承 session；v2.1.198 起 thinking 开关也继承；可按子代理配置 effort                         | 支持本轮开关/强度继承；显式子强度覆盖留后续                |
| Claude Code 本地复原 | effort 继承/覆盖，但普通子代理 thinking 仍关闭，full fork 才继承                                        | 属于旧行为证据，不采用其普通子代理强制关闭                 |
| deepseek-harness     | fresh child 显式继承 provider/model/maxTokens，未复制当轮 effort；fork 可从同 route 历史恢复显式 effort | 不把“模型相同”误当“强度已继承”                             |
| Reasonix             | 无覆盖则复用父 provider；覆盖模型/effort 时重新解析并验证                                               | 采用父默认与目标验证，不复制多层覆盖系统                   |
| opencode             | 同模型传父 variant；子 agent 显式换 model 时不直接传父 variant                                          | 采用强度属于目标模型的认识，不直接复用父 wire              |
| pi                   | 核心默认 medium；示例 subagent 启动独立进程，没有传父 --thinking                                        | 默认值相同不等于继承；不能称示例为核心统一规则             |

代码锚点（相对各项目根）：

- Codex：`codex-rs/core/src/tools/handlers/multi_agents_common.rs:177–185,234–267,360`；`multi_agents/spawn.rs:89`。完整历史 fork 的覆盖限制在 common 约 193 行；内置 awaiter 在 `core/src/agent/builtins/awaiter.toml` 使用 low。
- Claude 复原：`packages/builtin-tools/src/tools/AgentTool/runAgent.ts:490,688–693`。
- harness：`packages/subagent/subagent/src/child-agent.ts:68–82`；`packages/subagent/subagent-fork-in-process/src/index.ts:68–74`；`packages/core/agent-loop/src/agent.ts:417–435`。
- Reasonix：`internal/agent/profile_spec.go:202–218`、`task.go:682–696,1508–1517`、`internal/boot/boot.go:989–1018`。
- opencode：`packages/opencode/src/tool/task.ts:179–210`；配置合并在 `session/llm/request.ts:80–91`。
- pi：`packages/coding-agent/src/core/defaults.ts:3`、`core/sdk.ts:224–242`、`examples/extensions/subagent/index.ts:294–296`。

Claude 当前官方规则见 [子代理文档](https://code.claude.com/docs/en/sub-agents)；它比本地复原 checkout 的普通子代理关闭行为更新。这里只采用继承原则，不导入其环境变量、组织上限等完整配置层级。

## 3.3 标题、摘要、压缩不是同一种任务

| 项目            | 标题/展示摘要                                                                       | 上下文压缩                                                                                 |
| --------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Codex           | 本次未定位到与 ohbaby 同等的 LLM 标题主流程，不作推断                               | 本地和远端 compact 都传当轮 effort                                                         |
| Claude 本地复原 | 标题 queryHaiku 与 awaySummary 关闭 thinking                                        | 默认 cache-sharing fork 保持父配置；fallback 独立摘要才关闭；AgentSummary 也可能保留父配置 |
| harness         | session-title 在 adapter 强制 disabled，保留短输出额度给正文                        | compaction 不显式指定 effort，使用 adapter/deployment 默认，不保证父当轮档位               |
| Reasonix        | 自动标题固定 disabled；显式改标题有 disabled/none/low 能力选择及请求级 low override | 复用 executor provider，不单独覆盖 effort；拒绝空/截断摘要                                 |
| opencode        | title agent → small model → 当前 model；small 模式不套用户 variant                  | 可专配 compact model，仍尝试目标模型上的用户 variant                                       |
| pi              | 本次没有定位到核心自动 LLM 标题流程；branch summary 不传当前 thinkingLevel          | 手动/自动 compact 都传当前 thinkingLevel                                                   |

“没有传 reasoning”只能说明未显式传递，不能说明上游关闭了推理。参考项目不存在“所有辅助请求都关闭”的统一规则。

关键锚点：

- Codex：`codex-rs/core/src/compact.rs:668–674`、`compact_remote_request.rs:85–91`。
- Claude 复原：`src/utils/sessionTitle.ts:92`、`src/services/api/claude.ts:3425`、`src/services/awaySummary.ts:48`、`src/services/AgentSummary/agentSummary.ts:129`、`src/services/compact/compact.ts:1213,1332`。
- harness：`packages/session/session-title-llm/src/index.ts:253–259`、`packages/llm/llm-deepseek/src/serialize.ts:38,169–170`、`packages/compaction/compaction-basic/src/summarizer.ts:153–185`。
- Reasonix：`internal/control/session_title.go:17–24,42–50,89–107`、`internal/provider/openai/effort.go:77–84`、`internal/serve/serve.go:164–196`；压缩在 `internal/agent/compact.go:366–453`。
- opencode：`packages/opencode/src/session/prompt.ts:216–235`、`session/llm/request.ts:80–91`、`provider/transform.ts:1315–1337`、`session/compaction.ts:328–401`。`session/summary.ts` 的文件 diff 汇总不是同等 LLM 摘要，不能据名称推断策略。
- pi：`packages/coding-agent/src/core/agent-session.ts:1848–1856,2122–2130,2984–2999`；`core/compaction/compaction.ts:539–552`、`branch-summarization.ts:345–351`。

本项目取舍：子代理默认跟随父开关/强度；压缩直接沿用所属代理当前配置，不额外覆盖 medium，与用户最后确认一致，也接近 Codex/pi 的做法。标题保留关闭建议。用户随后确认摘要也优先沿用所属代理强度；本基线 context-summary 就是压缩入口，不增加摘要专用档位或新服务。

## 3.4 模型能力与默认 medium

harness `packages/llm/llm-deepseek/src/adapter.ts:194–208` 在该版本公开 off/high/max，默认 high；`packages/llm/llm/src/index.ts:720–764` 对不支持的显式 effort 报错，不自动 clamp。Reasonix `internal/config/effort.go:53–161` 根据能力和配置解析，有二态模型与显式档位验证。pi 默认 medium 后会按模型 clamp。

本项目采用精确能力校验；不照抄 pi 的静默 clamp，也不把 harness 的保守词表当成 DeepSeek 平台永久支持集合。默认 medium 是产品意图，遇到不能表达 medium 的模型必须记录合法映射或明确不支持，不能随意猜高档位。

官方资料（2026-09-15 核对）：

- [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)：元数据含支持档位、默认开关/强度及强制推理标记；仅对该平台有效。
- [Anthropic Models API](https://platform.claude.com/docs/en/api/models)：提供 effort/thinking 能力；支持集合不等于已选择档位。
- [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort)：effort 不等同 thinking 开关；配置变化可能影响缓存。
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)：reasoning 已在输出总量/额度内，无需另加一次。
- [Claude thinking 用量](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)：输出总量包含 thinking，文字摘要不能代替实际 thinking 用量。

## 3.5 原生状态的保序、来源和持久化

opencode `packages/opencode/src/session/processor.ts:280–310` 保存 reasoning Part/providerMetadata；`session/message-v2.ts:245,262–275,362–375` 检查模型来源并处理签名块顺序。它在跨模型时可能把文字转正文；本项目不采用这个降级，以免把 private thinking 变成用户内容。

pi `packages/ai/src/api/openai-responses-shared.ts:219–245,657–677` 保存并回放 reasoning item 与 text phase；约 515–529 行处理 terminal 才补 encrypted_content 的情况。`anthropic-messages.ts:1178–1211` 回传 thinking/signature/redacted 数据；`transform-messages.ts:95–124` 依据 provider/api/model 判断同源。消息完整落盘在 `packages/coding-agent/src/core/session-manager.ts:984,1021,1057`。

采用：最终状态需保真保序、需要落盘、同源回放、terminal 补全不能丢。调整：本项目用独立内部 model-state，而非前端 reasoning.text。拒绝：跨模型把思考文字降为正文、盲目相信第一次 item.done 已含最终全部状态。

## 3.6 对 02 的约束

参考证据支持请求快照、子强度继承、能力靠近模型适配层、标题与压缩区分、持久化原生状态。它们不授权改变本项目 cache 口径、system prompt、工具权限、前端展示或压缩算法。

后续“由主代理显式选择子代理 effort”方向已由用户提出并确认留后续；本批只记录默认继承，不复制 Reasonix/Codex 的整套工具配置接口。
