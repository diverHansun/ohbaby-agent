# 架构

## Architecture Overview

Bash 解析有效策略 → 既有 Registry 启动 foreground → 等待结果或等待阈值 → Registry 内部转换提交 → 同一个任务继续后台运行。硬超时由独立生命周期计时器负责。

## Design Pattern & Rationale

采用同一实体的模式转换，不创建 foreground/background 两个执行器。串行提交统一处理额度、持久事实和 abort 接线，避免状态改了但责任还挂在旧调用上。

## Module Structure & File Layout

tools/bash.ts 管参数和工具返回；shell-job-registry.ts 管转换；shell 配置复用 improve-1；scheduler/tool-admission 接可信运行时清理归属变化；存储和 SDK 投影扩展 mode/promoted_at。内部方法不注册为模型动作。

## Constraints & Trade-offs

前台不预占后台额，因此到点可能已满；按用户决定停止当前命令。转换后不改 jobId、owner、启动时间或硬截止。临界区和停止路径遵循 [02](../02-optimization-plan-and-change-scope.md)，不增加通用事务框架。可选用例/非功能文档合并在此与接口、测试中。
