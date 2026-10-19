# 问题分析与现状

> 基线：main / `e527285e`。路径相对 `packages/ohbaby-agent/src`。行号以基线为准。

## 1. 主代理与子代理的提示词差异

`core/system-prompt/assembler.ts` 里，两边的组装逻辑是分开的。

主代理（`:138-144`）：

```
generateBasePrompt(),
getPrimaryTaskPrompt(taskKind),      // plan.md | agent.md
generateAgentAddonPrompt(addon),
generateSubagentRolesPrompt(roles),
generateCustomInstructionsPrompt(customInstructions)
```

子代理（`:128-136`）：

```
SUBAGENT_BASE_PROMPT,
getSubagentTaskPrompt(kind),
generateAgentAddonPrompt(addon)
```

差别有三处：主代理身份、子代理角色目录、自定义指令。前两处是有意设计；第三处是缺失。

## 2. 缺失发生在哪里

`createSystemPromptProvider.build`（`assembler.ts:190-226`）：

- 子代理分支（`:203-210`）直接返回，不调用 `customInstructionLoader`。
- 主代理分支（`:212-226`）读取指令，再传给 `assemble`。

`SystemPrompt.assemble` 的 `AssembleOptions` 里其实已经有 `customInstructions` 字段，子代理分支只是没用。已有字段可以复用。最新方案只保留说明入口，不再增加跨加载器的来源路径传递链。为落实用户确认的项目优先规则，说明项需从字符串改为带 project／global 范围的数据；provider 的最终返回仍为字符串。Context 内旧 memory 依赖与字段仍需同步清理。

## 3. 项目指令与 memory 是两条路

| 来源 | 加载器 | 内容 | 主代理 | 子代理 |
| --- | --- | --- | --- | --- |
| 自定义指令 | `core/system-prompt/services/custom-instruction-loader.ts:22-27` | 项目 `OHBABY.md`，回退 `AGENTS.md`、`CLAUDE.md`；全局配置目录同名文件；安全扫描；每文件 50 × 1024 个 UTF-16 编码单元 | 加载，放系统提示词末尾 | 不加载 |
| memory | `core/memory/memory-loader.ts:93-115` | 全局与项目 `OHBABY.md`，加标记后拼到系统提示词 | 加载（`core/context/serializer.ts:70-75`） | 不加载（同一处对子代理跳过） |

在两条路径均采用同一可用文件时，主代理会重复包含它。2026-10-19 在本仓库根目录直接运行 loader → provider → serializer，本仓库 OHBABY 项目标记出现两次；子代理分支没有该标记。这证明本地源码组装行为，不证明用户实际运行版本或那次远端请求已经收到内容。用户反馈实际会话未注入，尚未取得对应请求材料。

仓库当前 `OHBABY.md` 主要写项目身份，五条中文工作规则位于 `CLAUDE.md`；读取候选是首个可用即停止，二者不会自动合并。该行为不是过滤错误；不能据此把用户未说明的实际现象断言成 CLAUDE 被遮蔽。

当前 loader 按项目、全局返回字符串数组（custom-instruction-loader.ts:199-202），renderer 仅写 Source 1/2（layers/custom.ts:8-14）；只剩全局文件时同样变成 Source 1，不能据位置判断范围。现状没有明确项目／全局冲突规则。

用户最新决议把文件定位为项目／全局说明，不作为长期记忆。[00](./00-discussion.md) 因此采用统一说明入口，退出旧 memory 注入路径。历史模块文档中的“长期文件记忆”属于待更新的旧定位，不是目标契约。

## 3.1 子代理的工作目录不一定是项目根

子代理的 run directory 是 `environmentWorkdir ?? projectRoot`（`core/agents/runner.ts:154-162`），spawn 时还可能传入独立的 workdir（`agents/subagent-host.ts:1591`）。自定义指令加载器只查给定目录及其配置子目录，不向上找项目根（`custom-instruction-loader.ts:144-169`）。如果直接拿子代理的工作目录去加载，在 worktree 或子目录场景会静默读不到项目根指令。

现有子会话由父会话项目根创建（`agents/subagent-host.ts:1001`），instance 已收到 `session.projectRoot`（`:1564`）。runner 向 run 传递执行目录时，没有把项目根单独传下去。目标是透传这个已有字段，不让 provider 从 workdir 重新解析根目录。子代理在另一个工作目录执行时，仍遵守其会话项目的说明。

## 4. 子代理基础提示词里的相反要求

`core/system-prompt/prompts/subagents/base.md`：

- `:14`：你看不到主代理的对话历史。
- `:17`：不要加载用户自定义指令，也不要创建更多子代理。
- `:18`：使用自己的 scope-local Todo。

第 17 行和本议题的目标直接冲突，必须改。第 14、18 行保持不变。

## 5. 测试固化了旧行为

`core/system-prompt/__tests__/assembler.test.ts:117-142`：

```ts
customInstructions: ["This must not leak to subagents."],
...
expect(fullPrompt).not.toContain("This must not leak");
```

测试名是 "assembles subagent prompts without identity or custom instructions"。改行为时这条断言要反过来，但"不含主代理身份、不含子代理角色目录"仍要保留断言（`:134-141`）。

同一文件 `:183-195` 还有一条子代理不带自定义指令的用例，也要一起改。`provider.test.ts:85-105` 还断言子代理不调用 loader；应与 loader／custom renderer 的字符串夹具一并更新。

## 6. 子代理已有的上下文

- 运行上下文：`buildRuntimeContext` 对子代理使用 `minimal` 环境（`assembler.ts:230-246`），MCP 菜单照常生成。
- 历史：子代理有独立的 `contextScopeId`，消息、Todo 都按这个作用域隔离。
- 工具：内置子代理（generic、explore、plan、research）都允许 `skill` 和 `skill_resource`，能看到同一份工具描述里的 skill 目录。

## 7. 普通读取失败与组装入口

- `custom-instruction-loader.ts:84-98` 对不存在和普通读取错误返回空；非 ENOENT 错误只调用可选 warning 回调。`composition.ts:601-634` 未接这个回调。用户确认本轮不新增此类警告或启动阻断。
- 安全扫描省略与扫描器抛异常是不同路径；不能引用 memory 的 catch 来断言所有自定义 loader 异常都会被吞掉。
- `context-manager.ts:511` 的 run 快照以外，`:457` 的无快照组装也直接加载 memory 和系统提示词，手动压缩会走该入口；上下文用量预览也使用 assemble。移除 memory 注入必须覆盖这些路径以及用量重建，不能只改 run 快照。

## 8. 结论

子代理缺的只有项目与用户指令这一块。补上之后，子代理的提示词结构就和主代理对齐了：稳定的通用规则、按任务定制的说明、项目约定。同时把项目／全局说明统一到一个入口，退出旧 memory 注入，更新文案、类型、用量计算和验收；自动长期记忆留到后续。
