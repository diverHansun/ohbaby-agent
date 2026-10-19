# memory 模块：迁移后的测试归属

独立 MemoryLoader 与专属测试已移除。文件读取、候选回退、安全扫描、大小限制和说明范围由 [system-prompt 测试](../system-prompt/test.md) 覆盖；Context 测试继续验证 run 快照稳定、说明只出现一次及历史字面 `<memory>` 留存。

幽灵 `memory_*` 工具契约回归移至 `packages/ohbaby-agent/src/tools/memory-surface.unit.test.ts`。Goals 的 `category: "memory"` 及其调度行为保留，继续由工具调度和 Goals 测试覆盖。

本批证据见[实施验收](../../problem-lists/2026-10-18-subagent-system-prompt/05-implementation-acceptance.md)。
