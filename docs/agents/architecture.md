# agents 架构

`agents` 管理 agent 配置与子代理编排，`core/agents` 提供统一执行原语。当前数据流和生命周期契约见 [dfd-interface.md](./dfd-interface.md)。

```text
用户 / Goal / 后台结果 / 空闲监督
            ↓
   SessionExecutionGate → AgentService → AgentInstance
                                            ↓
agent 工具 → SessionSubagentHost → AgentInstance
                    ↓                       ↓
         instance / execution stores   core/agents.runAgent
                                            ↓
                                     RunManager / Lifecycle
```

`AgentRegistry` 合并内置、全局和项目配置；`AgentManager` 解析 RuntimeAgent；`AgentService` 负责主会话启动。`SessionSubagentHost` 负责六个子执行名额、实例复用、取消与收尾，委托 `AgentInstance` 执行，不能另建模型循环。

子代理相关小模块各自拥有一项职责：`monitor` 读取历史，`execution-message-channel` 处理运行中输入，`continuation-coordinator` 对接请求确认，`session-supervisor` 检查会话状态并申请唤醒。最终准入仍由 adapter 的既有会话执行门负责。

`core/agents` 不依赖 `agents`、adapters 或 runtime 具体实现；runtime 不依赖 agents。组合层通过端口装配消息通道、shell 清理、权限事实和运行服务。

旧 `Task` 工具、`AgentTaskManager` 和 durable FIFO 自动续跑已经退出当前路径。历史表中的字段可为读取和恢复兼容保留，不构成新的执行入口。
