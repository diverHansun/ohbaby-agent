# 测试与验收契约

状态：后端已完成实施与验证。本文是验收要求；实际运行结果、偏差和未验证限制见 [05](05-implementation-acceptance.md)。

| 编号 | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| T01 | 新会话及恢复旧会话的工具声明 | bash、task、agent 各司其职；没有同时暴露 task_output/task_kill/task_list。 |
| T02 | 三动作合法/错误输入、无关字段、无效数值、未知 action | schema 与执行校验一致；拒绝输入无进程副作用。 |
| T03 | 主代理和内置子代理分别启动后台 Bash 后 list/output/stop | 各自拥有完整管理工具；子代理仍不能启动孙代理。 |
| T04 | 跨 session/scope ID，伪造 owner；第三方同名 task | 不泄露别人的输出、不停止别人的任务、不获得可信 control 通道。 |
| T05 | 普通工具容量满时调用 output/stop | 管理调用仍可执行；输出等待不占普通执行槽。 |
| T06 | output 非阻塞、阻塞到期、用户输入、调用取消 | 到期与取消不杀任务，不重置硬超时；返回或取消协议清楚。 |
| T07 | 任务 failed/timed_out/cancelled/lost、零 stdout、输出截断、读取故障 | 区分状态、原因、未知退出事实、cleanup 和输出完整性；故障不伪装零输出。 |
| T08 | 重复 stop、stop 与退出竞争、清理未确认 | 幂等，停止原因遵循先到规则；受理不等于清理完成，不误报 already_finished。 |
| T09 | list 上限、超过100项分页、空列表、include_finished=false | 正常前台历史不挤入列表，前台清理异常仍可见；列表有界、排序稳定、截断可见且后续页可读；cursor 不能跨 owner 或切换筛选；清理未确认及 cleanup=confirmed 但 settled_at 为空的收尾项仍显示，不夹带完整日志。 |
| T10 | 各权限等级默认调用；initialSnapshot 注入旧 task_kill/task_output deny | 默认不新增审批；显式 deny 在 full-access 下仍生效且仅影响对应动作；无新动作 pattern DSL，无旧可执行别名。 |
| T11 | 自定义旧 include/exclude | 不静默扩大权限；拒绝激活未迁移角色并提供可操作诊断，不能只隐藏 task 而保留后台启动；不改用户配置文件；未使用旧角色不阻断服务初始化，实际选用时拒绝并诊断。 |
| T12 | 新旧 tool part 的存储、导出、上下文压缩 | 旧记录可读；新 taskAction/jobId/事实摘要保留，不把列表伪装成单任务结果。 |
| T13 | 回滚遇到权威记录、旧回执、新 output/stop 回执、list 汇总 | 优先权威记录；fallback 只采信相同 job/owner 的真实 cleanup，list 不算清理证明。 |
| T14 | output/stop 与结束通知交错 | 不因查询就标记模型已消费；不绕开 improve-1 已确认的通知策略，不重复自动唤醒。 |
| T15 | improve-2 转后台后使用 task；转换容量失败 | 前者沿用同一 ID 和 deadline；后者报告容量事实，不出现被 task 重新启动的命令。该项依赖 improve-2，未完成时明确标为阻塞集成项。 |
| T16 | 单停 Bash、停止子代理、服务退出 | 单停不误停子代理；子代理结束回收所属任务；遵守 improve-1 生命周期约束，无新增遗留进程。 |
| T17 | 六状态查询与返回、状态/原因映射 | list(status=cancelled/timed_out 等)精确筛选；六态全覆盖，非法 stopped/timeout 拒绝；status 与显式 include_finished 组合拒绝。output/stop 不接受 status 输入；旧 timed_out/cancelled 原值保留，缺原因保持未知。 |
| T18 | 恢复旧会话后模型调用 task_output/task_kill/task_list | scheduler 返回可操作的迁移诊断；不执行旧别名、不自动转调 stop、不产生信号；未知其他工具仍按原错误处理。 |

## 验收门槛

T01–T14、T16–T18 在 improve-1 基础能力完成后验证；T15 在 improve-2 就绪后验证。本轮工具表面批次同时完成 improve-1 的 T24、T25 最终接线和 T38 旧工厂删除；前序阶段已经验证其生命周期和输入接线部分，最终集成要求 T38 全部通过。不得把待依赖项记为通过。实现顺序可调整，但对外宣布三个轮次全部完成前，所有集成项都必须有证据。

不做前端视觉验收，不把通用工具正文可读等同于后台任务面板交付。测试必须保留真实 legacy 历史夹具；仅全文替换旧名字会丢失迁移覆盖。按 plan-code-improvement 验收模式在 [05](05-implementation-acceptance.md) 记录偏差和实际测试。
