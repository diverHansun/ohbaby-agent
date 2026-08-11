# 参考项目与借鉴原则

## 1. 本批的参考方式

本批不是引入一个新的 memory 产品能力，而是删除一个没有接入运行时的虚假契约。因此参考重点是“如何保持边界清晰”，而不是照搬某个项目的 memory tool schema。

此前对 /Users/hansun025/Projects/code-cli/ 下同类实现的调研对本批有两点直接启发：

1. 工具是否可用应以真实 registry/executable adapter 为准，不能以孤立 metadata 或 agent include 列表为准。
2. context 注入、领域状态和 LLM tool surface 应分层；清理一个 surface 不应连带删除领域服务。

## 2. 借鉴与不照搬

| 原则/模式 | 借鉴 | 不照搬 |
|-----------|------|--------|
| 运行时注册表是真相 | 用 builtin registry 与 prompt resolver 验证工具可见性 | 不为已有静态 metadata 重新补一个未经确认的 adapter |
| Context 与工具面分层 | 保留 MemoryLoader → ContextManager → serializer 链 | 不把内部能力包装成模型工具 |
| 小改动、可回滚 | 只删除 ghost contract，保留 memory 数据流 | 不顺手引入向量检索、记忆策略或持久任务系统 |
| 规范跟随代码 | active docs 反映“被动注入”事实 | 不重写所有历史设计记录 |

## 3. 本批不需要的外部能力

- 不需要 embedding、memory search 或新的自动记忆策略。
- 不需要独立 memory daemon、跨进程 store 或迁移协议。
- 不需要统一 Tool response envelope。
- 不以“同类项目有 memory tool”为理由恢复当前不存在的 LLM 工具面。
