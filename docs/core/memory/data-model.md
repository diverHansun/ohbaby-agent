# memory 模块：已移除

2026-10-19 的子代理提示词修复移除了独立 `MemoryLoader` 及 Context 的自动 `<memory>` 注入。该模块不再提供生产接口。

`OHBABY.md`、`AGENTS.md`、`CLAUDE.md` 统一作为可选项目／全局说明，由主、子代理共用的 custom instruction loader 读取。当前契约见 [system-prompt/data-model](../system-prompt/data-model.md)；变更范围见[子代理提示词方案](../../problem-lists/2026-10-18-subagent-system-prompt/02-optimization-plan-and-change-scope.md)。

共享路径、旧文件迁移和 Goals 的 `ToolCategory: "memory"` 保留；它们不代表仍存在 MemoryLoader 或长期记忆服务。用户文件及历史消息中原有的 `<memory>` 文本不被删除或改写。旧设计可从 Git 历史和本目录既有改进记录查阅。
