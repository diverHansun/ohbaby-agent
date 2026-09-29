# 执行可靠性：main 集成验收

日期：2026-09-29。用户已审查本轮实施，并明确授权分阶段简要复审、显式合入 `main`、清理本轮本地开发分支及推送远程。本记录汇总本次集成检查，不将历史证据或未执行场景记为本轮重新通过。

## 范围与结论

- 审查范围：`93d4482c...82ceab39`，包含 A/B/C 和 improve-1 至 improve-4.1 的全部已提交实施。
- 三个只读子代理分别执行全阶段 Spec、前半程 Standards/正确性、后半程 Standards/正确性简审，未发现新增、可确认的 P1/P2 合并阻塞。这是重点抽查，不是逐行重新审查全部改动。
- 本轮补充提交：`71ca6e19`。只同步一条过时 E2E 断言和格式，不改生产行为。
- 显式合并提交：`32a7448f6c7a481143880fc092e0c7705cbf2b9c`，由 `git merge --no-ff codex/improve-4.1` 产生；父提交为原 `main` 的 `93d4482c` 与实施分支的 `71ca6e19`。
- 合并后与实施分支文件树逐项比较无差异；本机环境为 macOS、Node v26.3.1、pnpm 9.15.0。

## 分阶段简要验收

| 阶段 | 本次复核结论与原始记录 |
| --- | --- |
| A | 当前 run 的最终正文、空结果、失败和中断返回链与原验收一致；见 [A/B 记录](pre/prerequisite-follow-ups.md)。 |
| B | Read 游标、UTF-8、Grep 预算、完整编辑及原子写入已落地；见 [B](pre/b-file-tools.md)。 |
| C1/C2/C3 | 文件保护等到真实操作结束，容量归还与清理 owner 分离，来源限制不扩大为全部会话冻结；沿用 [C 组合验收](pre/05-implementation-acceptance.md) 的 macOS 范围。 |
| improve-1 | 审批身份、独立回答、撤销与恢复链闭合；上次四项 P2 修复仍在当前实现中。见 [05](improve-1/05-implementation-acceptance.md)。 |
| improve-1.1 | 版本恢复、分页、独立控制及原请求回执恢复已接线；见 [05](improve-1.1/05-implementation-acceptance.md)。 |
| improve-2 | 逐项持久交付、整批模型交付屏障、计时及保存失败停止准入已落地；见 [05](improve-2/05-implementation-acceptance.md)。 |
| improve-2.1 | 对应实施分支名为 `codex/improve-2.2`；权威空会话复用、客户端占用和 Web 模块整理已闭合；见 [05](improve-2.1/05-implementation-acceptance.md)。 |
| improve-3 | 子代理执行账本、结果交付、Steer、有限等待及输入确认有对应实现和测试；见 [05](improve-3/05-implementation-acceptance.md)，其部分组合未实测限制仍保留。 |
| improve-3.1 | 连续子会话、阅读窗口、旧历史降级和后续 UI 补修已实施；见 [实施记录](improve-3.1/implementation-notes.md)。验证仍有缺口，不改称全部验收门通过，也不补造 05。 |
| improve-4 | Stop、原 owner 保存恢复、retained、服务关闭和冷恢复已有组合证据；见 [05](improve-4/05-implementation-acceptance.md)。 |
| improve-4.1 | 健康切换、工具历史、命名和命令反馈收尾与最新实现一致；见 [05](improve-4.1/05-implementation-acceptance.md)。 |

## 本轮实际检查

| 检查 | 结果 |
| --- | --- |
| 合并前 `pnpm test` | 475 文件通过、6 文件跳过；5316 项通过、17 项跳过；退出 0，290.23 秒。 |
| 合并后 `pnpm test` | 在 `32a7448f` 执行；475 文件通过、6 文件跳过；5316 项通过、17 项跳过；退出 0，263.63 秒。 |
| 前半程子代理定向验证 | file-locks、concurrency、resources 三文件 31 项通过；不与全量数量相加。 |
| 子代理 runtime E2E | 首次 7 通过、1 失败；核实并同步旧断言后 8/8 通过，合并后再次 8/8 通过。该文件被默认全量配置排除，故单独运行。 |
| build / typecheck / format | 合并前、合并后均全部通过，退出 0；最终构建恢复了进程测试期间重建的 Web 静态资源。 |
| lint | 退出 0；0 errors、93 条既有 warnings，提交钩子正常执行。 |
| 文件树与空白检查 | 合并后与实施分支树一致；`git diff --check 93d4482c` 的原有多余末尾空行已整理。 |

日志位于本机 `/tmp/reliability-main-*.log`。它们可能被系统清理，本表保留关键计数和退出结果；不将本机临时文件当作永久仓库证据。合并后的测试包括真实子进程、SQLite、HTTP、CLI 和 npm 打包安装，未重新调用真实 LLM 或执行人工浏览器视觉矩阵。

## 本轮修正

独立 runtime E2E 的取消分支仍期待 `status: cancelled`，实际收到 `status: interrupted` 和 `terminal_reason: cancelled`。对照 improve-4 状态契约及 run manager → runner → host → 工具回执映射，确认产品行为正确。测试现分别断言执行状态和取消原因，仍要求错误原因保留、子历史保留 partial、父消息不得把 partial 当作成功报告。子代理独立核实该调整，复跑完整文件通过。

格式检查另发现 Web bootstrap import 折行及若干文件末尾多余空行；仅整理格式，证据正文和业务行为不变。

## 保留的验证边界

- C 阶段沿用此前 macOS 验收范围；Windows/Linux 原生进程树停止等证据不足，不能据本次本机结果声称跨平台全部通过。
- improve-3.1 的真实同子代理重复委派 T11 未触达目标，加强后的正文增量断言也未取得成功实网结果。200% 缩放和系统 reduced-motion 未实机覆盖；improve-2.1 的 reduced-motion 实机限制同样保留。
- improve-3 的部分真实权限、模型决策与长等待组合，以及各阶段已明确记录的维护和兼容边界仍以原验收记录为准。
- 本轮按用户已自行审查后的明确授权进行本地集成及推送，不以这次简审改写上述历史限制，不宣称每个规划场景均已通过。

## 本地分支清理范围

以下 14 个分支的 tip 均已核实为合并后 `main` 的祖先，已在合并后检查通过后使用 `git branch -d` 安全删除，并复查全部从本地 refs 移除。没有强制丢弃提交；其他路线的历史分支、其他任务的 worktree 和远程分支保持原状。

```text
codex/execution-reliability
codex/execution-reliability-pre-a
codex/execution-reliability-pre-b
codex/improve-1-implementation
codex/improve-1.1
codex/improve-2-execution-progress
codex/improve-2.2
codex/improve-3
codex/improve-3.1
codex/improve-4
codex/improve-4.1
codex/pre-c1-file-lock-lifetime
codex/pre-c2-resource-admission
codex/pre-c3-bash-cleanup
```

远程操作仅为普通推送 `origin main`。最终推送结果及远端 SHA 在任务回复中核对，不把推送预检查当作正式推送成功。
