# 执行可靠性改造路线

> 开启日期：2026-09-19。基线：`93d4482c` / v0.1.13。状态：improve-1 规划，尚未实施。用户已确认按四个职责独立推进；当前只展开第一轮，后续轮次在前轮验收后按实际证据编写，不预建空目录。

## 目标与固定边界

先解决“任务等待用户批准，用户却找不到入口”，再补齐执行过程、子代理可见性和停止恢复。默认 TUI 永久 in-process；serve 为 Web 提供共享运行后端；两者可共享 SQLite，但不共享实时协调、审批或 prompt queue。不得借此改成 TUI 自动 attach daemon。

参考既有取舍：[全局 serve 讨论](../2026-07-11-global-single-daemon/00-discussion.md)、[路线 C](../server/07-route-c-cli-inprocess-explicit-server.md)。本议题覆盖已有已确认取舍的部分修订，不将早期已废弃的默认 daemon 方案重新启用。

## 四轮 goals-duty 与路线

| 轮次 | Goal | Duties / 大致方案 | Non-Duties | 交付依赖与状态 |
|---|---|---|---|---|
| improve-1 | 待审批请求找得到、答得了，执行结束后不会留下可批准请求 | 独立 pending registry；真实 run/session/call 身份；根主会话汇总；Web 多页共享；断连恢复；回答/撤销一次生效；最小 Web/TUI 适配 | 完整工具阶段展示、子代理只读面板、全树停止重写、跨进程审批恢复 | 2026-09-19 开启，本文档集为规划契约 |
| improve-2 | 让工具等待与执行过程可解释 | 审批/排队/执行阶段贯通；逐项保存与展示结果；调查批次预检查阻塞；分别表达等待与执行超时 | 子代理生命周期重写；未经证明就改变读写互斥 | 第一轮验收后展开；消除整批结果延迟不等于改变模型协议 |
| improve-3 | 子代理可见，结果可靠交给主代理 | 树状会话浏览；子会话运行状态和输入输出只读；返回根主会话；禁止用户直接向子代理发 prompt；审批仍只在根主会话；后台完成交付、主代理忙时保留结果、有限等待接口 | 自动扩大权限、跨进程运行接管 | 复用第一轮身份与根会话归属、第二轮阶段数据；以实际事件链路确定实现 |
| improve-4 | 统一停止、中断和重启恢复 | 核验主会话 Stop 覆盖该树活动子代理、工具及后台 job；中断保留实例；终态一致；陈旧 running 收口；迟到结果不覆盖新 run | 默认 TUI daemon 化；盲目重放副作用；无证据的大规模重写 | 保留独立轮次；具体范围以停止/重启复现为依据 |

主会话 Stop 的目标是中断该任务树当前活动执行；主代理和子代理执行采用 interrupted，保留历史及实例。工具/job/request 可以有自己的 cancelled 等终态，不能机械统一枚举。已完成任务不改写。**这是目标，不是现有实现已覆盖整树的声明。**

## 文档地图与阅读顺序

1. [00 已确认决策](improve-1/00-discussion.md)
2. [01 现状与问题](improve-1/01-problem-analysis-and-current-state.md)
3. [02 实施契约](improve-1/02-optimization-plan-and-change-scope.md)
4. [03 六个项目借鉴](improve-1/03-reference-projects.md)
5. [04 测试与验收](improve-1/04-test-and-acceptance.md)

`05-implementation-acceptance.md` 预留给实施后的独立验收，本轮规划不创建，也不把文档审查写成实施通过。

## 模块文档入口与权威关系

模块侧路线说明分别位于：[permission](../../permission/improve-2/README.md)、[scheduler](../../core/tool-scheduler/improve-2/README.md)、[lifecycle](../../core/lifecycle/improve-3/README.md)、[agents](../../agents/improve-3/README.md)、[session](../../services/session/improve-1/README.md)、[SDK](../../ohbaby-sdk/improve-1/README.md)、[server](../../ohbaby-server/improve-1/README.md)、[Web](../../ohbaby-web/improve-1/README.md)。

职责和模块衔接在模块路线中解释；**本轮跨模块协议、阶段和验收以 02/04 为唯一实施契约**，模块页不复制第二套字段和测试矩阵。原模块 architecture/goals-duty/test 完全不修改；改造路线写在各模块新建 improve-x/README.md，与此处双向链接。模块编号独立递增：permission/scheduler 为 improve-2，lifecycle/agents 为 improve-3，其余为 improve-1；它们都服务于本议题 improve-1，不代表四轮进度。后续修改原权威文档需另行确定，本批不进行。

## 证据与范围切割

[前次真实诊断](evidence/2026-09-19-serve-stalled-tools.md)包括真实 serve、两种模型和浏览器复现。两个权限恢复缺陷最迟 v0.1.12 已存在；工具状态弱化的明确提交为 `53fae946`。本轮不把所有历史长等待都归因于权限。

后续轮次是用户主动按职责切开的议题，不是把一个实现分多次会话就创建多轮。每轮独立规划、实施、验收；下一轮研究仍逐一查看六个参考项目当时的相关实现。

## 本地分支与合并路线

用户确认采用“整项开发分支 + 每轮实施分支”，所有分支先保持本地：

```text
main
 └─ codex/execution-reliability            整项开发分支，规划与各轮验收汇总
     ├─ codex/execution-reliability-improve-1  第一轮实施、测试、验收后合回
     ├─ codex/execution-reliability-improve-2  从已验收第一轮的开发分支创建
     ├─ codex/execution-reliability-improve-3  从最新开发分支创建
     └─ codex/execution-reliability-improve-4  从最新开发分支创建
```

当前已建立 `codex/execution-reliability`，本批仅提交规划文档和诊断证据，未创建未来实施分支、未合并。实施开始前先将已确认规划形成可追踪提交，再从开发分支创建对应临时分支；不带着未提交规划切换多个阶段分支。

每轮按自己的 02/04 实施，独立审查后产出 05，解决阻断项并完成检查再合回开发分支。合回后验证跨轮组合，下一轮以实际代码和 05 为基线修订规划。四轮全部验收后，在开发分支完成综合回归与最终审查，再整体合入 main；阶段完成不直接合 main。分支合并本身不等于测试通过，也不自动发布或推送远端。

诊断报告集中在本议题 evidence 下，后续复现材料注明版本与证据类型，不能把最初诊断结论当作当前实现验收。
