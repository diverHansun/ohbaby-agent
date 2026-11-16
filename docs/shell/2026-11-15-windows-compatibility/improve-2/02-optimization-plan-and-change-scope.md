# 02 · 最小改动范围

## Stage 1：执行别名

修改 `packages/ohbaby-agent/src/shell/detector.ts` 的 Windows 显式路径判断，使用能看见重解析点本身的 lstat，接受文件或链接；保留支持名单、缺失路径报错、WSL 排除及 macOS/POSIX 行为。最终执行错误交给现有 spawn 路径。不增加试运行进程、回退或新的发现机制。

在现有 detector 单测及原生集成测试补回归，覆盖绝对 Store alias 通过 SHELL 传给嵌套 runtime 后仍可运行。

## Stage 2：工程环境

- `.gitattributes` 明确文本 LF，保留必要特殊格式。只在验证工作区无内容修改后，把受影响工作区文本换行恢复到约定；不提交全库格式重排，不修改用户全局 Git 配置。
- 在现有 Vitest setup 内让 DOM 测试使用所属 window 的 Storage，或采用等价的集中测试入口修正。Node 环境及浏览器产品代码保持原行为，不升级整套依赖。
- 不启用当前未生效的 prettier 配置，不顺带改变代码风格。

## Stage 3：测试夹具

修正 `shell-jobs/registry.integration.test.ts`、`persistence.integration.test.ts` 的 POSIX 专用命令，优先使用已有 Node 夹具；直接 spawn 的夹具在 Windows 绑定实际 Job。共享仅限确有重复的测试帮助，不建立平台框架。

文件 symlink 用例仅在实际创建权限不足时明确 skip，保留原防护断言，不能改成硬链接冒充验证。

## Stage 4：输出收尾

先记录 exit、close、stdout/stderr end、Job 为空与 drain 截止的真实时序；比较 Node、Windows PowerShell、Store pwsh。区分命令不合法、进程退出与输出管道关闭。只有复现证明实现有错才改对应点；否则记录限制。不得通过延长等待、伪造 outputComplete 或放宽 Job 清理证据掩盖原因。

无需数据迁移或协议变化。各批可独立回滚。发布边界仍包括未完成的 macOS 实机、remote TUI 与 PTY 矩阵；它们不由本轮局部测试替代。
