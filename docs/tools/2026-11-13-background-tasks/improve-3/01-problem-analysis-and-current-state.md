# 现状与问题分析

2026-11-13，本机源码基线 `f42608d4`。以下区分当前实现、前轮目标和本轮方案；不把截图中其他模型的结论当作实现证据。

## 当前调用链

`tools/builtin.ts` 注册 `bash`、`task_output`、`task_kill`；后两者在 `tools/shell-job-registry.ts` 创建，直接调用 Registry。当前没有 `task_list`。`task_output` 已支持 `block/wait_ms`，取消等待不等于杀进程。Registry 按 session 和 contextScope 校验归属。

现有 `agent` 在 `tools/subagent.ts` 使用 action、逐动作参数白名单和动态 admission category；它说明本项目已有可复用的工具组织方式，但不意味着两个运行时需要统一。

## 缺口与证据

| 编号 | 当前事实 | 本轮影响 |
| --- | --- | --- |
| G1 | 当前只有 output/kill；improve-1 计划再加 list | 按原计划会有三个管理名字；用户已选择一个 task 入口。 |
| G2 | 旧 output 有 readOnlyHint 注解，但实际显式 category 为 subagent-control；内置分类不靠该注解 | task 按动作分类：list/output 为 readonly，stop 保持控制分类；注解准确但不把它说成当前权限漏洞。 |
| G3 | builtin 子代理角色按工具名允许 output/kill；agent 禁止下放 | 注册新工具还不够，必须同步角色配置，否则子代理有启动能力却没有管理入口。 |
| G4 | `permission/evaluator.ts` 先匹配 deny，`matcher.ts` 按 toolName；普通 pattern 原本按路径解释 | 默认任务管理会放行，正常 UI 不生成旧规则；但 initialSnapshot 可注入 deny。只保留对应动作的旧 deny 检查，不新增动作 pattern 语法。 |
| G5 | 上下文投影显式识别 task_output/task_kill；rewind-shell SQL 识别同名清理回执 | 单改工具注册会丢失摘要或使回滚判断遗漏新回执；list 汇总不能冒充某个 job 的清理证据。 |
| G6 | ShellJob 当前是内存注册表和旧状态集 | 本轮是接口改造，准确持久状态仍依赖 improve-1，不能靠重命名解决。 |

## 设计判断

参考项目大多使用分开的工具，并不存在“优秀项目都采用 task(action)”的共识。本项目统一命名的理由是用户选择及与 `agent(action)` 一致；收益是入口清晰，代价是逐动作校验和兼容。没有实测证据证明它必然节省 token 或降低错误率。

职责上保留工具适配层、Registry、存储/日志、调度/权限的现有方向。数据层不新建第二套 Task；性能上输出和列表保持有界；安全性关注 owner 和动作；可靠性关注等待取消、停止回执和通知消费；测试沿用仓库的 unit/integration 分类，不为这次改名建立新测试框架。

## 代码锚点

- [注册入口](../../../../packages/ohbaby-agent/src/tools/builtin.ts)
- [ShellJob 与旧工具](../../../../packages/ohbaby-agent/src/tools/shell-job-registry.ts)
- [agent 动作分派](../../../../packages/ohbaby-agent/src/tools/subagent.ts)
- [动作 admission](../../../../packages/ohbaby-agent/src/core/tool-scheduler/tool-admission.ts)
- [权限规则匹配](../../../../packages/ohbaby-agent/src/permission/matcher.ts)
- [上下文投影](../../../../packages/ohbaby-agent/src/core/context/tool-metadata-projection.ts)
- [回滚清理证据](../../../../packages/ohbaby-agent/src/services/session/rewind-shell.ts)

以上链接相对 improve-3 目录定位；行号随实施变化，验收以符号与调用链为准。
