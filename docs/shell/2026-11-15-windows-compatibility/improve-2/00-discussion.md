# 00 · 已确认的讨论决定

2026-11-16，用户原话：

> 同意，继续使用plan-code-improvement记录这些问题，记录可以放到improve-2.按你建议的顺序逐项修复和测试，保持KISS，不要过度设计。输出收尾先查清原因，再决定怎么改。完成后让子代理和pi审核，分批commit，先不merge。

按本次明确授权，在同一会话内完成记录与实施；沿用上一轮原生 Windows/macOS、runtime 拥有任务的原则。

顺序：商店版 PowerShell 执行别名 → 换行与测试环境 → 跨平台进程夹具。输出收尾独立诊断，有因果证据再改。不引入 OS 抽象层、helper 服务、新依赖或自动换解释器。不靠整批跳过 Windows 测试或放宽清理证据解决失败。

审查使用子代理与此前指定的 Pi `copilot/gemini-4-carbon high`。修复可分批提交，不 merge、不自动 push。macOS 实机不可用时明确记为未验证。

收尾时用户进一步确认 shell 选择边界：商店版绝对路径仅是隔离验收输入，不写死为 Windows 默认配置。runtime 尊重合法的显式 SHELL；未指定时发现 pwsh，再找系统 PowerShell。Git Bash 使用原生 Windows 完整路径；WSL 应运行独立 Linux runtime。工具名仍为 bash，由描述告知实际解释器，不自动翻译命令或失败后切换。保留现有设计，本轮不增加 shell 管理配置层。

来源会话：[用户验收](http://127.0.0.1:4096/#directory=D%3A%5CProjects%5Ccode-cli%5Cohbaby-agent&session=session_1794805487241_lif4e11)。另经用户授权，实点 Cancel 的补测会话为 `session_1794807673815_52wpf52`。
