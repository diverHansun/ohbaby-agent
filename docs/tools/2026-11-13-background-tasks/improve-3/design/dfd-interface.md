# 数据流与接口

## Context and Scope

输入为模型工具调用与可信执行上下文。输出为模型正文和持久化的结构化工具结果；进程启动、用户侧会话树接口与结束通知均在本模块之外。

## Data Flow

1. schema 检查对象类型，运行时按 action 检查必需字段、范围和多余字段；无效输入在任何副作用之前拒绝。
2. 从可信上下文取得 owner，按动作生成 admission 与权限判断；执行 handler 前再次保证已验证参数不被替换。
3. list 查询自身任务摘要；output 读取当前快照或注册有界等待；stop 调用 Registry 的统一停止路径，原因固定为 model。
4. 返回真实快照。等待器到期或取消不改变进程寿命；停止反馈不等待无限清理；通知仍由生命周期链路生成。

## Interface Definitions

```ts
// 伪类型；provider 使用与 agent 相同的兼容 object schema，运行时严格分支验证。
type TaskStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled" | "lost";

type TaskInput =
  | { action: "list"; include_finished?: boolean; status?: TaskStatus; limit?: number; cursor?: string }
  | { action: "output"; job_id: string; block?: boolean; wait_ms?: number }
  | { action: "stop"; job_id: string };
```

| 动作 | 契约 |
| --- | --- |
| list | include_finished 默认 true；limit 整数 1–100，默认 20。沿用 improve-1：列自身后台 ShellJob，并纳入仍有清理责任的前台异常项；正常前台历史不列，避免普通短命令挤掉后台任务。保留 mode，不混入 agent 执行。需持续处理的任务优先，然后按结束时间从近到远补足；排序增加 ID 稳定决胜。返回 hasMore/nextCursor/匹配总数，明确截断；不声称是完整清单。status 可按六状态之一精确筛选，枚举与返回值共用。 |
| output | job_id 必填；block 默认 false。block=true 时 wait_ms 默认 30000，整数 1–600000。wait_ms 显式提供但 block 不为 true 时拒绝，避免看似等待实际不等。等待到任务结果就绪、等待期限或调用取消之一发生。 |
| stop | job_id 必填；不接受 reason、signal、owner 等字段。用户已放弃追踪时返回 tracking_released，不重新取信号权；活 foreign owner 返回明确错误。已结束且无剩余清理责任时幂等返回事实；仍有清理责任时走既有幂等清理路径，不能误报 already_finished。 |

列表范围限定为后台任务与前台异常项；前台异常指 cleanup=unconfirmed，或已进入终态但收尾未完成，正常运行中的前台命令不混入。启动占位只计 pendingStartCount，不伪造 running 行。list 的“需持续处理”排除用户已放弃追踪项，包含已启动 running，以及 cleanup 未确认或 settled_at 为空的逻辑终态；未传 status 时 include_finished=false 也不能隐藏后者。status 与显式 include_finished 互斥，避免“只看未结束但筛选 cancelled”的歧义；传 status 时按该状态精确筛选，包括该状态清理已确认或未确认的记录，并保留 cleanup 字段。精确筛选按用户指定条件隐藏其他状态，不代表那些任务已被清理。列表复用 Store 的不透明 cursor 分页，绑定可信 owner 和规范化筛选；下一页须带相同筛选（limit 可调整），不接受跨 owner/不同筛选 cursor。每页最多100，稳定排序及并发刷新边界沿用 improve-1；确保配置额度超过100或历史持续增长后，模型仍能取得后续任务 ID。用户面板使用独立 tree-wide 授权，不把模型查询扩成全树。

读取其他活跃后端任务时只用持久快照；block 等待复用 improve-1 的调用期间有界数据库读取，不新增永久观察器。等待期间本 run 新增 user-steer 或调用取消，若工具框架仍允许返回，则注明提前结束原因并返回快照；若调用被框架取消，则按既有取消协议结束，任务仍继续。等待超时不是任务超时，结果不得因此变为 timed_out 或 cancelled。已终止但输出仍收尾时，使用 improve-1 的有界结果就绪流程，不能因状态不再 running 就伪造完整输出。

未知 ID 与不属于调用者的 ID 均返回不可用错误，不泄露其他 owner 的命令、日志或存在性。输入额外 command、timeout、agent_id、stop_all、未知 action 一律拒绝。空列表是成功，不是故障；数据库或日志读取失败是明确错误/完整性警告，不伪造成空列表或零输出。

### 权限与兼容

- 按已验证 action 分类：list/output 为 readonly，stop 沿用现有 subagent-control 及其权限映射。默认策略不因改名新增审批；可信 control admission 和 owner 校验继续生效。
- 不新增 task(list)/task(output)/task(stop) 权限 pattern 语法，不扩展通用 matcher。现有无 pattern 的 task 规则作用于整个工具。
- 正常 UI 不会为旧任务管理工具生成规则，但公开 initialSnapshot 可注入显式 deny。仅对可信内置 task 做小型 deny 兼容：按当前 action，以对应旧工具名运行现有 deny 匹配，匹配则拒绝；不迁移旧 allow，不给外部同名工具特权。旧 task_list 若曾单独发布也按相同规则处理。此处只维护已有调用契约，不注册可执行别名、不新增权限配置文件或通用迁移框架。
- 内置角色更新为 task。自定义 include/exclude 若引用旧管理工具名，在实际激活该角色时给出迁移错误，不能默默扩大权限，也不能只隐藏 task 却保留后台启动。未使用旧角色不阻断服务初始化；不自动改用户配置。
- readOnlyHint 是注解，不决定内置工具权限；混合工具仍不应宣称整体只读。实际安全边界是 action 验证、分类和可信 owner。

### 返回示例

```js
bash({ command: "pnpm test", run_in_background: true })
task({ action: "list" })
task({ action: "list", status: "cancelled" })
task({ action: "list", status: "timed_out" })
task({ action: "output", job_id: "完整 ID" })
task({ action: "output", job_id: "完整 ID", block: true, wait_ms: 30000 })
task({ action: "stop", job_id: "完整 ID" })
```

正文首行包含任务说明、状态和已知结果，后接有界尾部。stop 返回 `stopResult: requested / already_finished / tracking_released / cleanup_pending` 并报告 cleanup，不能只输出“停止成功”。阻塞 output 返回 `waitReason: ready / timeout / steer`；取消按既有调用取消协议处理，不停止任务。所有动作带 `taskAction`；output/stop 带单任务 `jobId`，list 带分页摘要而不伪造顶层 jobId。以上接口已接入工作区，实际验证范围见 [05](../05-implementation-acceptance.md)。

## Data Ownership

Registry 持有进程及输出等待责任；Store 持有持久事实；可靠输入系统持有通知消费；task handler 不拥有这些资源。主代理不能通过传子代理 ID 来读停其 Bash；用户停整个子代理时，由已有 owner 生命周期回收其全部任务。单停 Bash 不终止子代理。
