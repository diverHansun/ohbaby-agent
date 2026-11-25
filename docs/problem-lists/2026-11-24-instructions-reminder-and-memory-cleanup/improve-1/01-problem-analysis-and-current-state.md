# 1. 问题基线与当前实施状态

> 时间口径：基于 `ohbaby-agent` 仓库 `main` 分支基线提交 `e7ecdc52`（2026-11-24）分析。本文只记录**当前现状与问题诊断**，改造方案见 [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md)。

---

## 1.1 问题陈述

1. **易变指令文件耦合在静态 System Prompt 尾部，直接破坏下游缓存前缀并抬高信任级别**
   `createSystemPromptProvider().build()` 在每次新 run 构建 `systemPrompt` 时读取磁盘指令文件，并通过 `SystemPrompt.assemble()` 拼入 `system` 消息末尾。用户编辑 `CLAUDE.md` / `AGENTS.md` 后，从 `system` 尾部指令段起的整段后续对话历史前缀全部缓存失效；同时放在 `system` 角色内与「低优先级项目用户指南」的定位相悖。
2. **与既有的 `system-reminder` 架构割裂**
   `ohbaby-agent` 已经把易变的 `environment`、`mode`、`mcp-catalog`、`todo`、`skill-usage` 全部迁移到 `services/reminder/` 管道（持久化、`user` 侧、锚定排序、压缩后自动重检），唯独用户/项目指令仍停留在 `core/system-prompt/` 中，形成两套并行的动态上下文机制。
3. **私有文件名 `OHBABY.md` 与“全局记忆”旧路径包袱仍在运行主路径上**
   加载器仍以 `OHBABY.md` 为最高优先级，执行“三选一不合并”策略，并探测 `~/.ohbaby-agent/`、`<project>/.ohbaby/`、`<project>/.ohbaby-agent/` 及 `~/.config/ohbaby-agent/OHBABY.md` 等旧记忆路径；若项目同时维护内容不同的 `AGENTS.md` 和 `CLAUDE.md`，后者会被静默丢弃。
4. **长期记忆（Memory）残留横跨路径、迁移、工具调度、权限分类与文档**
   尽管早先删除了 `MemoryLoader`，但 `paths`、`migration`、`core/tool-scheduler`、`permission`、`goals`、`tools` 测试及 `docs/core/memory/`、`docs/project/` 仍遍布 `"memory"` / `"memory-write"` / `LegacyGlobalMemory` 概念，误导维护者与后续 AI 开发者。

---

## 1.2 已确认的产品/技术分界

依据 [00-discussion.md](./00-discussion.md)：

```text
当前现状：
  ~/.ohbaby / ~/.ohbaby-agent / ~/.config/ohbaby-agent/OHBABY.md
  <projectRoot> / .ohbaby / .ohbaby-agent (OHBABY.md > AGENTS.md > CLAUDE.md, 三选一)
    ──► core/system-prompt/services/custom-instruction-loader.ts
    ──► SystemPrompt.assemble() ──► system role 消息（破坏 Cache + 权限过高）

目标分界（见 02 与 docs/services/instructions/）：
  ~/.ohbaby/{AGENTS.md, CLAUDE.md} + <projectRoot>/{AGENTS.md, CLAUDE.md}（全读 + 内容去重）
    ──► services/instructions (ReminderProvider)
    ──► services/reminder Collector ──► 持久化 user 侧 <system-reminder>（Append-only 保 Cache）
  SystemPrompt.assemble() ──► 纯静态 system prompt（与文件 I/O 彻底解耦）
```

---

## 1.3 `core/system-prompt` 模块现状

### 1.3.1 goals-duty
- **文档说**：[docs/core/system-prompt/goals-duty.md](../../../core/system-prompt/goals-duty.md) 的 `G2`、`G4`、`D3`、`D4` 将 `custom instructions` 加载、fallback（`OHBABY.md > AGENTS.md > CLAUDE.md`）与渲染归为 `system-prompt` 核心职责。
- **代码做**：[assembler.ts:110-133](../../../../packages/ohbaby-agent/src/core/system-prompt/assembler.ts#L110-L133) 在 primary 与 subagent 分支末尾都调用 `generateCustomInstructionsPrompt()`；[assembler.ts:185-204](../../../../packages/ohbaby-agent/src/core/system-prompt/assembler.ts#L185-L204) 在 `build()` 中默认调用 `loadCustomInstructions()`。
- **Gap**：文档与代码一致，但该职责本身把“静态提示词模板组装”与“易变外部文件 I/O + 上下文注入”硬绑在一起，直接制造了 KV Cache 破坏。

### 1.3.2 architecture
- 关键文件：
  - [services/custom-instruction-loader.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/services/custom-instruction-loader.ts)（214 行）：承担路径解析、文件读取、截断、安全扫描、旧路径回退。
  - [layers/custom.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/layers/custom.ts)（29 行）：渲染 `<custom_instructions>` 块。
  - [security/index.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/security/index.ts)（212 行）：纯函数 prompt-injection 扫描器，同时被 `mcp/integration/dynamic-tool-menu.ts` 复用。
- **Gap**：`core/system-prompt` 直接依赖 `paths/ohbaby-home.ts` 中的 `resolveLegacyGlobalMemoryPath`、`resolveLegacyOhbabyHome`、`resolveLegacyProjectOhbabyRoot`，依赖方向偏重且混入迁移历史细节。

### 1.3.3 data-model
- [types.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/types.ts) 中 `AssembleOptions.customInstructions` 与 `CustomInstruction`（`{ scope: "global" | "project"; text: string }`）丢失了文件路径、内容哈希与截断状态，无法支持去重、来源标注或快照比对。

### 1.3.4 dfd-interface
- `SystemPrompt` facade 暴露 `loadCustomInstructions`，`core/system-prompt/index.ts` 与 `layers/index.ts` 导出了 `CUSTOM_INSTRUCTIONS_FILE_NAME`、`CUSTOM_INSTRUCTIONS_FALLBACK_FILE_NAMES`、`getProjectCustomInstructionsPath`、`getProjectConfigCustomInstructionsPath`、`getGlobalCustomInstructionsPath`、`generateCustomInstructionsPrompt` 等 8 个符号。
- `adapters/ui-runtime/composition.ts:798-824` 通过 `createSystemPromptProvider({ onSecurityFinding })` 将安全扫描结果转发至 `options.onNotice(noticeFromPromptSecurityFinding(finding))`。

### 1.3.5 use-case
- 当前仅支持“run 启动时一次性读入 system prompt”：
  - 若用户在会话进行中修改或删除了指令文件，同 run 内无法感知；下一 run 重建 `systemPrompt` 时则直接把整段历史前缀缓存打废。
  - 若仓库同时有 `AGENTS.md` 与 `CLAUDE.md` 且内容互补，[custom-instruction-loader.ts:132-143](../../../../packages/ohbaby-agent/src/core/system-prompt/services/custom-instruction-loader.ts#L132-L143) 的 `readFirstInstructionFile` 只读第一个，直接吞掉第二个文件。

### 1.3.6 non-functional
- **Cache 破坏**：`systemPrompt` 字节受用户外部文件变动影响。
- **安全边界**：已有 `scanPromptLikeContent` 与 `50 * 1024` 字符上限，但放在 `system` 角色里本身削弱了角色层级隔离；且目前未针对 `<system-reminder>` 做防逃逸转义。

### 1.3.7 test
- 现有单测与根级集成测试：[custom-instruction-loader-service.unit.test.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/__tests__/custom-instruction-loader-service.unit.test.ts)、[custom.test.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/__tests__/custom.test.ts)、[assembler.test.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts)、[provider.test.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts)、[prompt-security.unit.test.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/security/prompt-security.unit.test.ts)，以及仓库根 `tests/integration/` 下的 [custom-instructions.integration.test.ts](../../../../tests/integration/adapters/ui-runtime/custom-instructions.integration.test.ts)、[project-instructions.integration.test.ts](../../../../tests/integration/core/context/project-instructions.integration.test.ts)、[environment-reminders.integration.test.ts](../../../../tests/integration/core/context/environment-reminders.integration.test.ts)。
- **Gap**：测试全部锁定在旧的 `OHBABY.md` 优先、三选一、进 `systemPrompt` 与「同 run 不刷新」契约上，缺少“文件变更不破坏历史缓存前缀”“共存去重”“符号链接越界拒读”“删除失效通知”等关键风险测试。

---

## 1.4 `services/reminder`、`core/context` 与 `core/lifecycle` 现状

### 1.4.1 goals-duty & architecture
- [services/reminder/index.ts](../../../../packages/ohbaby-agent/src/services/reminder/index.ts) 已实现统一的 reminder 收集器 `createReminderCollector`，支持固定顺序 `REMINDER_ORDER = ["environment", "mode", "mcp-catalog", "todo", "skill-usage"]`、按 `audience`（`primary` / `subagent` / `both`）过滤、`snapshot` 按最近 `key` 去重与 `event` 跨压缩去重。
- [core/context/context-manager.ts:1608-1827](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L1608-L1827) 在 `prepareTurnUnlocked()` 中收集 reminder、在 compaction 改变活跃历史后**同一次调用内重新收集**并仅持久化第二次候选，经 [core/context/reminder-history.ts](../../../../packages/ohbaby-agent/src/core/context/reminder-history.ts) 锚定在对应 assistant 之前。
- [core/context/serializer.ts:95-112](../../../../packages/ohbaby-agent/src/core/context/serializer.ts#L95-L112) 将 `system-reminder` 消息投影为 `role: "user"` 文本块（`source: "system-reminder"`）；[core/message/origin.ts:12-21](../../../../packages/ohbaby-agent/src/core/message/origin.ts#L12-L21) 确保其对前端 transcript 隐藏。

### 1.4.2 dfd-interface Gap（两处关键断裂）
- **Gap A（`Lifecycle` 未透传每步 `projectRoot`）**：[core/lifecycle/lifecycle.ts:645-661](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L645-L661) 创建 `promptSnapshot` 时传入了 `projectRoot: params.projectRoot`，但 [core/lifecycle/lifecycle.ts:669-697](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L669-L697) 构造每步 `stepInput` 时**遗漏了 `projectRoot`**（仅传 `directory: params.directory`，且强制压缩重试也复用该 `stepInput`）。若只改 `ContextManager`，每步 `input.projectRoot` 仍为 `undefined`，导致工作在子目录的主/子代理读错项目目录。
- **Gap B（`ReminderContext` 缺少路径字段）**：[services/reminder/index.ts:16-28](../../../../packages/ohbaby-agent/src/services/reminder/index.ts#L16-L28) 的 `ReminderContext` 缺少 `directory` 和 `projectRoot` 字段，需由 `context-manager.ts:collectReminders()` 直接透传 `input.directory` 与 `input.projectRoot`。
- **Gap C（压缩摘要规则未排除可重建的外部指令）**：[core/context/compression-prompt.ts](../../../../packages/ohbaby-agent/src/core/context/compression-prompt.ts) 要求保留用户要求与约束，但未区分“可由宿主在压缩后从磁盘自动重载的外部指令文件”，若摘要顺手抄录了旧仓库指令而随后文件被删，会遗留过时约束。
- 注：现有 `services/reminder/` 尚无独立设计文档目录；本次新增的 `services/instructions` 将在 `docs/services/instructions/` 补齐完整 `plan-module-design` 文档。

---

## 1.5 `paths` 与 `migration` 模块现状（A 类长期记忆残留）

- [paths/ohbaby-home.ts:140-152](../../../../packages/ohbaby-agent/src/paths/ohbaby-home.ts#L140-L152) 定义并由 [paths/index.ts:9](../../../../packages/ohbaby-agent/src/paths/index.ts#L9) 导出了 `resolveLegacyGlobalMemoryPath()`（且经 [packages/ohbaby-agent/src/index.ts:175](../../../../packages/ohbaby-agent/src/index.ts#L175) 公开重导出），指向 `~/.config/ohbaby-agent/OHBABY.md`。
- [migration/ohbaby-home.ts:487-498](../../../../packages/ohbaby-agent/src/migration/ohbaby-home.ts#L487-L498) 在 `migrateOhbabyConfig()` 中有专用的 `legacyMemoryPath` 迁移分支；此外，[migration/ohbaby-home.ts:417](../../../../packages/ohbaby-agent/src/migration/ohbaby-home.ts#L417) 的通用目录复制 `migrateConfigTree()` 也会把 `~/.ohbaby-agent/` 与 `<project>/.ohbaby-agent/` 中的普通文件（含 `OHBABY.md` / `AGENTS.md` / `CLAUDE.md`）复制到新目录。这些迁移代码由前置专题整体删除（见 00 §6 R3）。
- 单测：[paths/ohbaby-home.unit.test.ts:95-96](../../../../packages/ohbaby-agent/src/paths/ohbaby-home.unit.test.ts#L95-L96)、[migration/ohbaby-home.unit.test.ts:76-114](../../../../packages/ohbaby-agent/src/migration/ohbaby-home.unit.test.ts#L76-L114) 仍专门覆盖该旧全局记忆路径与迁移行为。
- 仓库根目录仍跟踪 [OHBABY.md](../../../../OHBABY.md)；单数 `AGENT.md` 与 `CLAUDE.md` 是被 `.gitignore` 忽略的本地文件；根 `README.md:156`、`README.zh.md:156` 与 [packages/ohbaby-cli/README.md:156](../../../../packages/ohbaby-cli/README.md#L156) 都仍记载旧的 `OHBABY.md > AGENTS.md > CLAUDE.md` 规则。

---

## 1.6 `tool-scheduler` / `permission` / `goals` / `tools` 现状（A/B 类残留）

### A 类幽灵测试残留
- [tools/memory-surface.unit.test.ts](../../../../packages/ohbaby-agent/src/tools/memory-surface.unit.test.ts)：整份文件仅用于断言幽灵工具 `memory_list/read/add/update/remove` 未注册。
- [permission/classifier.unit.test.ts:46-59](../../../../packages/ohbaby-agent/src/permission/classifier.unit.test.ts#L46-L59)：专门断言这 5 个幽灵工具名称被当作普通未知写工具处理。

### B 类借用 `memory` 命名的运行态类型
| 文件与位置 | 当前代码 | 实际语义 |
| --- | --- | --- |
| [core/tool-scheduler/types.ts:21](../../../../packages/ohbaby-agent/src/core/tool-scheduler/types.ts#L21) | `ToolCategory` 含 `"memory"` | 仅由 `goals` 4 个内部状态工具声明；`scheduler.ts` 运行逻辑未对 `"memory"` 做任何分支判断 |
| [permission/types.ts:61](../../../../packages/ohbaby-agent/src/permission/types.ts#L61) | `PermissionToolCategory` 含 `"memory"` | 透传 `ToolCategory` |
| [permission/classifier.ts:9,68-70,97](../../../../packages/ohbaby-agent/src/permission/classifier.ts#L9-L97) | `PermissionCallKind` 含 `"memory-write"`；`todo_write`（自身在 [tools/todo.ts:591](../../../../packages/ohbaby-agent/src/tools/todo.ts#L591) 注册为 `category: "write"`）与 `category === "memory"` 均映射到 `kind: "memory-write"` | 实际语义就是测试注释写的 `"internal state update"`（会话内状态更新，默认 level 下免审批） |
| [permission/evaluator.ts:83,104](../../../../packages/ohbaby-agent/src/permission/evaluator.ts#L83) | `case "memory-write": return allow();` 且尾部存在兜底 `default: return deny(...)` | 自动放行会话内部状态更新（注意 `default` 分支会掩盖漏改的 `kind`，需配合 `never` 穷尽检查与测试锁定） |
| [goals/tools.ts:17-22,106,170,205,245](../../../../packages/ohbaby-agent/src/goals/tools.ts#L17) | 4 个真实工具 `CreateGoal` / `UpdateGoal` / `GetGoal` / `SetGoalBudget` 均标 `category: "memory"` | 实际是会话目标状态管理，非长期记忆 |

- 同步受影响的测试与文档：
  - 测试：`core/tool-scheduler/scheduler.unit.test.ts`、`core/tool-scheduler/capacity.integration.test.ts`、`permission/classifier.unit.test.ts`。
  - 权威文档：`docs/core/tool-scheduler/{data-model,dfd-interface,architecture}.md`、`docs/permission/{data-model,dfd-interface,architecture,test}.md`、`docs/goals/{data-model,dfd-interface}.md`。

### 明确保留的 C 类（RAM 内存，非长期记忆）
- `InMemoryShellJobStore`、`InMemoryGoalPersistence`、`InMemorySubagentExecutionStore`、SQLite `:memory:`、`adapters/ui-state/memory-store.ts`、`runtimeInputMemory`、`core/tool-scheduler/source-cleanup.ts` 的 `memoryNamespaces`、`shell/windows-job.ts` 进程内存限制字段、`mcp` 测试中第三方包名 `@modelcontextprotocol/server-memory` 等。

---

## 1.7 跨模块一致性与改动影响面

- **跨模块数据流缺口**：
  1. `ContextManager` → `ReminderCollector` 缺少 `directory`/`projectRoot` 透传。
  2. `composition.ts` 当前把 `onSecurityFinding` 挂在 `createSystemPromptProvider()` 上；迁移后需改挂在 `createInstructionsReminderProvider()` 上，`noticeFromPromptSecurityFinding` 保持兼容（键前缀 `prompt-security:` 不变，CLI/TUI 事件过滤逻辑零破坏）。
- **包级影响面**：
  - `packages/ohbaby-agent`：主要改动面（新增 `services/instructions/`，精简 `core/system-prompt/`，扩展 `services/reminder/`、`core/context/`、`core/lifecycle/`，清理 `permission/`、`goals/`、`core/tool-scheduler/`、`tools/` 及 `adapters/ui-runtime/{composition,prompt-context}.ts`；`paths/`、`migration/` 与 `utils/project-env.ts` 由前置专题先处理）。
  - `packages/ohbaby-cli`：仅更新 README 说明及若干测试夹具中硬编码的 `OHBABY.md` 示例路径（不改业务运行时）。
  - `packages/ohbaby-llm`、`packages/ohbaby-sdk`、`packages/ohbaby-server`、`apps/ohbaby-web`：无生产代码改动（`ohbaby-llm` 的 prompt cache 契约天然兼容尾部追加的 `user` reminder）。
- **单轮承载评估**：全部改动在 `packages/ohbaby-agent` 内部闭环、依赖链清晰、无不可逆外部协议破坏，适合在 `improve-1/` 单轮内按 4 个 Stage 纵切落地，无需分轮。

---

## 1.8 SWE 原则审视摘要

对照 `learn-swe-before-after-implement` 原则透镜：
1. **关注点分离与单一职责（SRP / 02 基础受力）**：`core/system-prompt` 混杂了“静态模板组装”与“外部磁盘 I/O + 易变用户上下文注入”，拆分后 `system-prompt` 只管静态系统提示，`services/instructions` 只管外部指令发现与提醒渲染，职责清晰。
2. **消除偶然复杂度（00 哲学 / KISS）**：复用已有的 `services/reminder` 管道，避免另造状态持久化或文件 watcher；清理 `OHBABY.md` 与旧记忆迁移路径直接消灭无用历史分支。
3. **代码为人而写与命名诚实（00 哲学 / 06 代码工艺）**：用 `"memory"` / `"memory-write"` 命名 `goals` 和 `todo_write` 的内部状态权限，会持续误导后来者以为项目里还有长期记忆；正名为 `"internal-state"` 后概念自解释。
4. **反教条克制（03 护栏 / YAGNI）**：不为了“未来可能支持 monorepo 嵌套发现”而提前引入目录树遍历或 tool hook，保持当前最简、可逆的 4 路径探测模型。

---

## 1.9 与既有文档关系

| 既有文档 | 当前状态 | 本轮关系 |
| --- | --- | --- |
| `docs/core/memory/*` | 历史重定向空壳 | **本轮整目录删除** |
| `docs/core/system-prompt/{goals-duty,architecture,data-model,dfd-interface,test}.md` | 权威文档（含 custom instructions 章节） | **本轮同步删改**，移除 custom instructions 职责并改为引用 `docs/services/instructions/` |
| `docs/project/{architecture,data-model,dfd-interface,goals-duty}.md` | 含过期的「Memory 模块管理 OHBABY.md」描述 | **本轮同步清理**过期引用 |
| `docs/core/tool-scheduler/*`、`docs/permission/*`、`docs/goals/*` | 权威文档（含 `"memory"` / `"memory-write"`） | **本轮同步正名**为 `"internal-state"` |
| `docs/core/context/architecture.md:96`、`docs/tools/architecture.md:460` | 现行架构文档（含“指令仅下一 run 生效”与 `memory_*` 示例） | **本轮定点同步更新** |
| `docs/services/instructions/*` | 本轮新建 | **新增权威文档**（按 `plan-module-design` 产出） |
