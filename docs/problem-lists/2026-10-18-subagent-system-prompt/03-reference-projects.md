# 参考项目

> 2026-10-19 源码复核。固定 commit 与调研局限见 [system-reminder/03](../2026-10-18-system-reminder/03-reference-projects.md)。Claude Code 为非正式重构源码；下文区分默认路径、可配置行为和示例扩展。

## 1. 六个项目的子代理路径

| 项目 | 已确认行为 | 借鉴边界 |
| --- | --- | --- |
| claude-code | 普通子代理使用自己的基础与角色提示词，同时默认加载 user context 中的 CLAUDE.md；Explore、Plan 可用 omitClaudeMd 跳过 | 独立角色和项目指令可并存；并非所有子代理都省略项目约定 |
| codex | child config 继承当前有效 base/developer instructions，允许角色覆盖；AGENTS.md 还涉及子会话自身的发现与 WorldState 构建 | 配置继承不能单独证明文件如何发现；要看子会话构建链 |
| opencode | 子会话进入同一上下文管线；General 与 Explore 可以使用不同基础提示词；tools/skills/MCP 等可按权限过滤 | 不能把权限过滤推广为所有项目文件都被裁剪；独立历史仍需保持 |
| kimi-code | 普通 spawn 使用独立 profile；模板包含 agents_md 变量时会得到项目指令，自定义模板可能不含；fork 另有继承历史路径 | 不能声称任意自定义子代理都会无条件得到同样的项目文件 |
| deepseek-harness | 子代理结合角色 persona、作用域配置与独立循环，委派信息放入 runtime context | 角色说明和委派任务不必混进固定系统提示词；不能概括为所有子代理系统提示词完全相同 |
| pi | 核心没有统一子代理调度，示例扩展调用正常 Pi CLI 并追加角色说明；未关闭默认 context-file 加载，因此仍可发现全局/祖先 AGENTS.md、CLAUDE.md | “没有手写注入代码”不等于“子代理没有项目指令”；示例独立进程与 ohbaby 可恢复子代理并不等价 |

## 2. 关键代码入口

路径相对各参考仓库，定位以符号为准：

- Claude：`packages/builtin-tools/src/tools/AgentTool/runAgent.ts:377-419`，区分 getUserContext、omitClaudeMd 与角色说明。默认 child 和 fork 路径不同。省略只读 agent 指令的节省数据是源码注释，不是本轮实测。
- Codex：`codex-rs/core/src/agent/child_config.rs` 的 build_agent_spawn_config；结合 `core/src/session/world_state.rs` 核对项目文件上下文。配置中的 developer 覆盖与 AGENTS 文件发现是两件事。
- OpenCode：`packages/core/src/session/context.ts:127-158`，子会话复用的上下文准备管线。
- Kimi：`packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts` 的 systemPromptVars/agents_md，以及普通 spawn 与 fork 的 profile 构建。自定义模板需实际引用变量。
- DeepSeek：`packages/subagent/subagent/src/child-agent.ts:165-216`，独立 agent 的角色与委派上下文。
- Pi：`packages/coding-agent/examples/extensions/subagent/index.ts:300,333-347` 的 CLI 参数；`packages/coding-agent/src/core/system-prompt.ts:172-183` 的附加提示、项目上下文与技能组装。

## 3. 对 ohbaby 的选择

保留 base、task、addon，再追加可选项目与全局说明。用户确认这些文件不定位为长期记忆，ohbaby 统一使用说明入口；这是本项目的职责选择，不把参考项目不同的 memory 命名强行统一。主代理和子代理复用加载代码，但不共享对话历史、父 Todo 或父 Goal。注入到系统提示词末尾是 ohbaby 按现有组装方式作出的选择，不是参考项目的统一位置。

ohbaby 的 Explore 当前包含 write、edit、bash，不能照搬 Claude 对只读角色省略指令的策略。此次也不新增只读角色或调整工具权限。

项目文件有可用内容就读，没有就跳过，不增加警告或启动阻断。动态提醒服务不负责通知指令文件缺失。技能正文继续按需读取，子代理的压缩后提示只反映本作用域曾用技能。
