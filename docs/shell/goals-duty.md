# Shell 目标与职责

Shell 模块为 `bash` 工具提供可用原生解释器选择、真实方言、成熟 AST 分析、静态政策与既有进程树清理。

目标是让审批描述、路径检查和真实执行对应同一原始命令及解释器，并明确区分分析能力不足、权限拒绝、准备失败和实际命令失败。优先复用现有 scheduler、permission、sandbox 和 ShellJobRegistry，保持 KISS。

职责包括选择解释器、生成非交互 argv、从 Bash/PowerShell WASM AST 提取可靠字面事实、给出完整性和风险、保留已有系统破坏及下载执行政策、交付运行时资产、提供已有进程清理证据。

权限规则、主会话审批和根会话归属由 permission 与 scheduler 管理。Bash 实例固定执行参数，ShellJobRegistry 管理前后台任务生命周期。Shell 不求值变量或命令替换，不改写命令，不在执行失败后换解释器，不适配 WSL，也不提供 OS 沙箱或完整副作用证明。

平台默认、准备数据流和发布包资产见 [架构](architecture.md)；接口与旧 API 迁移见 [接口](dfd-interface.md)；回归范围见 [测试](test.md)。
