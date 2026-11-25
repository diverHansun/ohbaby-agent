# system-prompt 模块 goals-duty.md

本文档定义 `system-prompt` 模块的设计目标与职责边界。

---

## 一、模块定位

`system-prompt` 是系统提示词模板与分层组装中心，负责把静态模板、任务契约、代理附加提示和可委派角色组装为稳定 system prompt，并向 Context 提供运行环境。

如果没有该模块：

- 默认系统提示词会散落在 agents、context、runtime 等调用方中。
- primary agent 与 subagent 的任务契约无法统一维护。
- MCP 公告、环境提示和 custom instructions 的边界容易混淆。
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

subagent prompt 的层顺序是：

1. subagent base
2. subagent task
3. agent addon

subagent roles 仅由主代理输出。environment 与 MCP 菜单由各自的 reminder provider 追加到 user 历史；MCP 菜单只含当前 scope 内已准入而未加载的精确本地名及固定说明。

### G3: 运行时上下文延迟注入

静态模板不保存 cwd、date、git 状态、工具列表、MCP description/schema 或 custom instructions。当前会话可用的文件指令、环境和工具目录由 reminder collector 按步收集。

### G4: 保持文件指令的动态性

文件指令放在 user 侧的快照 reminder 中。同一 run 中，用户修改指令后，下一次模型请求可使用新内容，已发送的 system 前缀保持稳定。主、子代理各自在自己的活跃历史里判断是否需要追加快照。[文件指令职责](../../services/instructions/goals-duty.md)

### G5: 适配 ContextManager

`createSystemPromptProvider()` 是面向 context manager 的适配器。`build()` 解析 agent name、task kind、roles 和 addon，再调用 `SystemPrompt.assemble()`；`detectEnvironment()` 提供当前执行目录的环境信息。

### G6: 分离稳定行为策略与工具接口契约

跨工具调用的稳定 Agent 行为放在 primary `base.md`。工具 description 与 JSON schema 只描述当前工具的接口语义和输入约束，并只随原生工具定义发送；system prompt 不复读这些内容。MCP 未加载工具只以精确名称和固定说明公告。Todo 的启用时机、更新节奏和生命周期属于 base 行为；读写、全量替换与数量限制属于工具契约。

---

## 三、职责

### D1: 存储静态模板

存储并导出 primary base、primary task、subagent base、subagent task 等静态模板。

### D2: 组装系统提示词

`SystemPrompt.assemble()` 按 primary/subagent 边界返回 `string[]` 层数组。调用方决定是否 join。

### D3: 渲染运行时层

渲染 subagent roles 和 agent addon。Context 在同一 run 中复用组装后的 system 快照。

### D4: 提供 prompt-security 扫描器

文件指令与 MCP 工具描述等调用方可使用扫描器识别可疑内容。文件读取、大小限制和告警去重由各调用方负责。

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

### N5: 不提供长期记忆

文件指令属于全局或项目约定，由 `services/instructions` 读取。Context 负责消息历史投影。

---

## 五、设计约束

- 静态模板以 `.md` 为内容源，并生成 checked-in TS 快照供源码运行和打包使用。
- `.md` 文本在生成脚本中规范化换行，避免 Windows/Unix 换行影响输出。
- `SystemPrompt.assemble()` 返回 `string[]`，不返回层元数据对象。
- 继续使用 assembler 内的数组字面量表达层顺序，不引入 `LAYER_ORDER + sort`。
- 主、子代理共用说明，但保留各自身份；Global 先于 Project，项目具体约定优先。用户当前明确要求、宿主权限和委派边界仍优先于说明。
- MCP loaded 集由运行时 composition 按 `sessionId + contextScopeId` 维护，跨 context compaction 保留；应用重启或无法恢复时清空，并在下一轮重新公告可加载工具。
- 不为 Todo 等稳定行为新增专用动态 prompt layer；只有真正随运行时变化的上下文才进入 renderer。

---

## 六、文档自检

- [x] 能说明模块存在的意义。
- [x] 能说明模块不该负责什么。
- [x] 层顺序与代码和测试一致。
- [x] 文档不把不存在的返回模型描述为正式 API。
- [x] 稳定 Agent 行为与工具接口契约的归属清楚。
