# 04 · 测试与验收标准

沿用仓库 Vitest 分类与现有 setup，不另建测试体系。

| ID | 场景 | 通过标准 |
| --- | --- | --- |
| A1 | 支持/缺失/目录/WSL 路径和 macOS shell 选择 | detector 单测通过；Windows 文件/链接可作为候选，目录和缺失路径被拒绝，POSIX 规则不变。 |
| A2 | 实际 Store pwsh 的绝对 SHELL，嵌套运行 | 真正启动并捕获标记，清理 confirmed；未安装 Store 版本的机器可以明确 skip，本机不得模拟通过。 |
| A3 | core.autocrlf=true 的 Windows 检出 | format:check 通过；git diff 没有上千个文件的格式重排，不修改全局 Git 设置。 |
| A4 | Node 25 默认环境的 Web 测试 | 不依赖手工 NODE_OPTIONS，BackgroundTasksPage 13 项通过；Node 24 定向复测通过。 |
| A5 | shell-jobs 真实进程测试 | registry/persistence 的功能用例实际执行，进程可终止且 cleanup 有证据；symlink 权限不足明确 skip，不把整组 Windows skip。 |
| A6 | 超时与用户取消输出 | 固定合法 PowerShell/Node 命令，核对开始标记、终止后无后续输出；记录所有生命周期事件，原因未明前不改输出语义。 |
| A7 | 请求与 Web 回归 | 原有请求测试通过；必要时使用当前 glm-5.2 high / OpenAI-compatible，在临时工作区验证；UI 取消事实与数据库一致。 |

每批定向验证后运行必要的 lint/typecheck/build。格式门恢复后可重跑完整 preflight，失败必须分清本轮问题、存量测试缺口及外部依赖故障，不以定向通过冒充全量通过。完成后独立子代理和 Pi 审查，05 记录实际命令、结果、skip、残余风险和提交。

对抗性重点：不可执行路径被误接受、别名被误拒绝；工作区换行处理覆盖用户改动；测试伪造清理成功；强制停止后管道残留；后台任务在所属 runtime 以外被错误停止。
