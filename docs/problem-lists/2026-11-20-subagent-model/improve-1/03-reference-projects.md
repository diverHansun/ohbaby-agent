# 3. 参考项目

> 2026-11-20 由子代理阅读本地源码后整理，路径相对 `/Users/hansun025/Projects/code-cli/`。行号是当时的快照。

## 3.1 借鉴来源

| 项目 | 调研范围 |
|---|---|
| codex | `codex-rs/core/src/agent/child_config.rs`、`codex-rs/config/src/config_toml.rs` |
| kimi-code | `packages/agent-core-v2/src/session/subagent/configSection.ts`、`apps/kimi-code/src/tui/commands/config.ts` |
| claude-code | `src/utils/model/agent.ts`、`src/utils/model/model.ts`、AgentTool |
| opencode | `packages/core/src/tool/plugin/subagent.ts`、`packages/core/src/session/runner/model.ts` |
| pi | `packages/coding-agent/src/core/model-resolver.ts`、`examples/extensions/subagent/` |
| ZCode、Step-Code、deepseek-harness、minimax-code | 浅读，只看子代理模型怎么来 |

## 3.2 全局默认与会话模型

五个主要参考项目都把“全局默认模型”和“当前会话的模型”分开：

- claude-code：`/model` 只改当前会话，故意不写回 settings.json，防止一个会话的选择影响别的会话（`src/state/onChangeAppState.ts:93-99`）。
- opencode：配置里的 `model` 注明是“没有会话或 agent 模型时用的默认模型”（`packages/schema/src/config.ts:33-34`）。
- pi、kimi-code、codex：选模型时可以只改当前会话，也可以同时保存为默认。

这支持 00 D1：保留 Default，它管的是还没有自己选择的会话。

## 3.3 子代理模型的做法

| 项目 | 优先级（从高到低） | 全局子代理设置 | 工具参数选模型 | 按 agent 配置 |
|---|---|---|---|---|
| codex | 角色配置文件里的模型 → spawn 参数 `model` → `[agents] default_subagent_model` → 继承父线程 | 有，另有 `default_subagent_reasoning_effort` | 有，可隐藏 | 有（角色配置文件） |
| kimi-code | 工具参数 `model`（必须在池里）→ `[secondary_model].default_model` → 继承调用方；fork 总是继承 | 有，`/subagent-model` 命令可改，下一次 spawn 生效 | 池里多于一个模型时才暴露 | 没找到 |
| claude-code | 环境变量 `CLAUDE_CODE_SUBAGENT_MODEL` → 工具参数 → agent 定义的 `model:` → `inherit` | 只有环境变量，没有设置界面 | 有，`sonnet / opus / haiku` | 有 |
| opencode | 工具参数 → agent 的 `model` → 父会话模型 | 无 | 有，描述里写着“除非用户要求，否则别用” | 有 |
| pi | （扩展示例）agent frontmatter 的 `model` → 父会话模型 | 无 | 无 | 有 |
| ZCode | Settings 的 Subagents 编辑器里每个子代理选模型，可选 `inherit` | 未确认 | 未确认 | 有 |
| minimax-code | 总是继承 | 无 | 无 | 只接受 `inherit` |

## 3.4 可借鉴点与取舍

| 来源 | 做法 | 为什么相关 | ohbaby 取舍 |
|---|---|---|---|
| codex `default_subagent_model` + `default_subagent_reasoning_effort` | 一个全局子代理模型，再加一个全局子代理档位；没设就继承父线程的模型和档位（`child_config.rs:163-169`、`:230-232`） | 和 00 D3、D5 几乎一样 | **采用**。档位不单独做全局字段，跟着子代理模型一起存（02 P2），因为档位只对特定模型有意义 |
| kimi-code `[secondary_model]` 与 `/subagent-model` | 没配置就继承；配了就用池里的默认模型；TUI 命令修改后下一次 spawn 生效，不用重启（`configSection.ts:250-276`、`config.ts:707-738`） | 00 D8 要求 TUI 借鉴它 | **改造后采用**。不新增斜杠命令，在 `/models` 里按 `s` 进入同样的选择流程；“下一次生效”对应 02 P10 |
| codex 的可用性检查 | 设置的子代理模型不在可用列表里时报错（`child_config.rs:237-264`） | 设置可能失效 | **改造后采用**。ohbaby 不报错，退回继承并提示（02 P7），不让主代理的任务中断 |
| claude-code 的 “Inherit from parent (default)” | agent 编辑器下拉框第一项是继承（`agent.ts:126`） | 界面上怎么表示“继承” | **采用**。Web 和 TUI 的第一项都是 “Follow chat” |
| kimi-code、claude-code 的 fork 继承 | fork 出来的子代理共享父历史，总是继承模型以复用缓存 | 换模型会让缓存失效 | **暂不涉及**。ohbaby 的子代理不共享父历史，没有 fork 模式 |

## 3.5 明确不借鉴

- **工具参数选模型**（claude-code、opencode、codex、kimi-code）：几个项目都给它加了限制（提示词约束、可隐藏、只在多个候选时暴露），说明模型自己挑并不好控制。00 §4 已排除。
- **按 agent 配置模型**（claude-code、opencode、ZCode）：本轮只做全局设置。以后要做时，顺序按 codex 和 claude-code 的经验放在全局设置之上。
- **环境变量硬覆盖**（claude-code 的 `CLAUDE_CODE_SUBAGENT_MODEL`）：ohbaby 用 Settings 管理模型，不再加一条看不见的配置路径。
- **专门的小模型**（opencode 的 `small_model`、claude-code 的 `ANTHROPIC_SMALL_FAST_MODEL`）：00 §4 已排除。

## 3.6 对 02 的影响

- 02 P1、P3：全局设置，没设就继承，来自 codex 和 kimi-code。
- 02 P2：档位跟着子代理模型一起存，是对 codex 两个独立全局字段的简化。
- 02 P7：设置不可用时退回继承并提示，是对 codex 报错做法的改造。
- 02 Stage 4：TUI 的选择流程借鉴 kimi-code 的 `/subagent-model`。
