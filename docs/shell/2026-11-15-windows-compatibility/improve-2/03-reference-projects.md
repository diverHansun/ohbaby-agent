# 03 · 本地项目借鉴

2026-11-16 阅读本地源码，只借鉴与已复现问题直接相关的实现。

| 项目 | 证据 | 取舍 |
| --- | --- | --- |
| dsh | `D:/Projects/code-cli/deepseek-harness/packages/shell/pwsh-local/src/resolve.ts:46` 的 candidateExists 用 lstat，注释说明 Store alias stat EACCES 但 CreateProcess 能执行；显式配置直接返回。 | 借鉴 lstat 对文件/链接的判断，保留 ohbaby 既有解释器限制。 |
| OpenCode | `packages/core/src/shell/select.ts:86` 在 stat 前检查 execution alias；`util/which.ts:19` 仍要求 existsSync。 | 知道别名问题，但辅助函数不适合本机 exists=false 的情况，不照抄。 |
| ZCode | `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts:282` 对裸 cmd 放过 accessSync 失败，其他候选仍检查。 | 说明存在性预检需要平台语义；不引入其整套 provider。 |

不借鉴独立 runner、挂起创建或通用 OS 服务。本轮只修 detector 与相关测试。输出收尾如需借鉴，先以实际诊断证据判断是否相关。
