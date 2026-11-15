# 01 · 问题分析与现状

日期：2026-11-15。代码基线同 [本轮索引](README.md)。本节描述现状，目标建议见 [02](02-optimization-plan-and-change-scope.md)。

## 故障链路

Windows 普通命令自然退出 → `probeProcessTree()` 返回 unknown → 当轮结束调用 `stopForeground()` → 清理记为 unconfirmed → 根会话资源保护拦截后续文件工具。

已用真实 Node 子进程复现。原会话五条命令中，两条成功退出、三条失败退出，却都留下 unconfirmed。grep/glob 起初可用，不能将后续连带阻塞解释为所有文件工具各自不兼容 Windows。原日志没有 edit 失败调用，其受相同保护影响是代码推断。

## 调研结构与结论

下表 agent 内路径相对于 `packages/ohbaby-agent/src/`，其余标明仓库根路径。

| 维度 | 当前结构与问题 | 主要代码 |
| --- | --- | --- |
| 职责 | Shell 提供解释器与进程能力，Registry 管任务；Windows 清理证据缺失 | `shell/process.ts`：`probeProcessTree`、`killTreeWithPlatform` |
| 架构 | 本地 TUI 与 Web daemon 分别拥有 runtime，共用 agent 执行层；只修 daemon 不够 | `host/core-api-factory.ts`；仓库根 `packages/ohbaby-server/src/runtime/daemon/main.ts` |
| 数据 | 命令结果与清理状态分开；内存 snapshot 缺 endedAt，终态耗时继续增长 | `shell-jobs/registry.ts`：`snapshot`；`tools/task.ts` |
| 数据流 | 轮次关闭触发清理，保护影响同一根会话的工具准入 | `adapters/ui-runtime/composition.ts`；`core/tool-scheduler/source-cleanup.ts` |
| 用例 | 已有前台、显式后台、自动转后台；阻塞的前台任务被后台列表过滤 | `shell-jobs/registry.ts`；仓库根 `apps/ohbaby-web/src/ui/side-panel/background-tasks/BackgroundTasksPage.tsx` |
| 可靠性 | 旧记录跨重启保留；身份不明时无法安全确认或回收 | `shell/process-identity.ts`；`shell-jobs/recovery.ts` |
| 测试 | CI 有多平台矩阵，但真实进程组测试跳过 Windows；模拟通过未覆盖本次故障 | `shell/process.integration.test.ts`；仓库根 `.github/workflows/ci.yml` |

## 问题分组

| 编号 | 证据与问题 | 对应方案 |
| --- | --- | --- |
| W01 | 已复现退出清理误判 | 第一批：Koffi Job（D11） |
| W02 | 旧记录持续阻塞；Windows 新任务的重启恢复缺接线 | 旧记录第一批由用户解除；新任务恢复第二批 |
| W03 | 异常原因和用户恢复入口不足 | 第一批 |
| W04–W05 | 已观察实际 PowerShell 与模型命令不匹配；终态耗时不冻结 | 第一批 |
| W06 | 已确认真实 Windows 生命周期测试缺口 | 第一批起逐批补齐 |
| W07 | Web PTY 的 Windows 后代查询为空，是能力检查项，尚无泄漏实证 | 另开议题 |
| W08 | 原生依赖随安装包交付 | 第一批做 Windows x64 最小验证，更大矩阵第二批 |
| W09 | 本地退出、远程断开、runtime 退出的区别需要验证 | 第二批 |
| X01 | 页面另有模型 contextWindowTokens 配置报错，根因未定位 | 独立议题，不并入本次修复 |

## 与既有约定的关系

| 约定来源 | 当前实现与缺口 |
| --- | --- |
| [Shell 职责](../../goals-duty.md) | 已要求真实解释器、不自动换 shell、复用 Registry；本次缺口在平台能力与提示，不需要扩大职责 |
| [后台任务约定](../../../tools/2026-11-13-background-tasks/README.md) | 已区分结果、清理、放弃跟踪；Windows 不能完成正常清理确认，用户恢复能力尚未接到相关界面 |
| [00 · D03–D07](00-discussion.md) | 保留 runtime 归属、自动转后台和清理保护；不能暗改成父进程退出即证明整树清空 |
| [00 · D10–D13](00-discussion.md) | Windows 用 Koffi 进程内 Job；confirmed 只表示 Job 已空，脱离 Job 的进程不在保证范围 |

本轮优先补现有边界缺口，避免新增重复任务状态或复制 Win/mac 业务逻辑。完整会话证据、入口清单及实验限制见 [调查附件](evidence-notes.md)。
