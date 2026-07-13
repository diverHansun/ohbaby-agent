# system-prompt 模块 goals-duty.md

本文档定义 `system-prompt` 模块的设计目标与职责边界。

---

## 一、模块定位

`system-prompt` 是系统提示词模板与分层组装中心，负责把静态提示词模板、任务契约、代理附加提示、工具提示、运行环境和用户自定义指令组装为最终 system prompt。

如果没有该模块：

- 默认系统提示词会散落在 agents、context、runtime 等调用方中。
- primary agent 与 subagent 的任务契约无法统一维护。
- 工具提示、环境提示和 custom instructions 的边界容易混淆。
- 提示词内容无法被独立审查和版本化。

---

## 二、设计目标

### G1: 模板统一管理

静态提示词模板统一放在 `packages/ohbaby-agent/src/core/system-prompt/prompts/` 下，以 `.md` 文件作为内容源。

`.md` 只是模板载体，内容可以是 Markdown、XML block，或 Markdown 与 XML block 的混合结构。

### G2: 分层组装

primary prompt 的层顺序是：

1. base
2. task
3. agent addon
4. subagent roles
5. tools
6. environment
7. custom

subagent prompt 的层顺序是：

1. subagent base
2. subagent task
3. agent addon
4. tools
5. minimal environment

其中 subagent roles 和 tools 是条件层：分别只在存在可用子代理角色或工具描述时输出。

### G3: 运行时上下文延迟注入

静态模板不保存 cwd、date、git 状态、工具列表、工具片段或 custom instructions。运行时上下文由 layer renderer 在组装时注入。

### G4: 安全加载用户自定义指令

模块负责加载项目/全局的 `OHBABY.md`、`AGENTS.md`、`CLAUDE.md` fallback，并对 prompt-like 内容做安全扫描和截断。

### G5: 适配 ContextManager

`createSystemPromptProvider()` 是面向 context manager 的适配器。它解析 agent name、task kind、environment、tools 和 custom instructions，然后调用 `SystemPrompt.assemble()`。

### G6: 分离稳定行为策略与工具接口契约

跨工具调用的稳定 Agent 行为放在 primary `base.md`。工具 description 与 JSON schema 只描述当前工具的接口语义和输入约束，避免同一策略在 base、`<tool_guidance>` 和原生工具定义中重复。Todo 的启用时机、更新节奏和生命周期属于 base 行为；读写、全量替换与数量限制属于工具契约。

---

## 三、职责

### D1: 存储静态模板

存储并导出 primary base、primary task、subagent base、subagent task 等静态模板。

### D2: 组装系统提示词

`SystemPrompt.assemble()` 按 primary/subagent 边界返回 `string[]` 层数组。调用方决定是否 join。

### D3: 渲染运行时层

生成 environment、tool guidance、subagent roles、custom instructions、agent addon 等运行时层。

### D4: 安全加载 custom instructions

读取 custom instruction 文件，处理不存在、读取失败、超长和可疑 prompt-like 内容。

### D5: 提供 provider adapter

`createSystemPromptProvider()` 将 context manager 的输入适配为 system-prompt 的组装参数。

---

## 四、非职责

### N1: 不管理代理配置

agent profile、tools、permission、maxSteps 等由 agents/config/runtime 模块负责。

### N2: 不选择模型或 provider

LLM provider、model 和 API 调用由服务层负责。本轮不实现 provider/modelFamily 差异化 prompt overlay。

### N3: 不执行工具或审批权限

工具注册、权限审批、并发调度和执行由 tool-scheduler、permission、runtime 负责。

### N4: 不做动态 prompt 生成

本模块不调用 LLM 来生成或重写 prompt。

### N5: 不注入 memory

memory 与消息历史由 context 模块处理；system-prompt 只生成系统提示词层。

---

## 五、设计约束

- 静态模板以 `.md` 为内容源，并生成 checked-in TS 快照供源码运行和打包使用。
- `.md` 文本在生成脚本中规范化换行，避免 Windows/Unix 换行影响输出。
- `SystemPrompt.assemble()` 返回 `string[]`，不返回层元数据对象。
- 继续使用 assembler 内的数组字面量表达层顺序，不引入 `LAYER_ORDER + sort`。
- 子代理不加载 primary custom instructions。
- 不为 Todo 等稳定行为新增专用动态 prompt layer；只有真正随运行时变化的上下文才进入 renderer。

---

## 六、文档自检

- [x] 能说明模块存在的意义。
- [x] 能说明模块不该负责什么。
- [x] 层顺序与代码和测试一致。
- [x] 文档不把不存在的返回模型描述为正式 API。
- [x] 稳定 Agent 行为与工具接口契约的归属清楚。
