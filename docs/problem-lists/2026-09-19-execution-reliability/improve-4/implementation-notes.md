# improve-4 实施记录

2026-09-28 从当前 `codex/improve-3.1` 的 `603b1f57db6c256f022746257148d4b59cbd720d` 建立本地 `codex/improve-4`，沿用当前 checkout。用户授权分批实施、提交、单元/集成/端到端测试、子代理审查和 Pi `opencode/opus-5.5` 审核；完成后不 merge、不 push。

正式契约为本目录 00/02/04。已通过浏览器阅读用户提供的[先前约定](https://chatgpt.com/s/cx_6aba32248d4c8191a70fda82a53566e4)：逐批校准实际接口，同毫秒准入需要持久顺序，普通编辑不改变顺序。本文保留实施过程事实，最终结果以05验收为准。

## 验收点

- [x] S0：实际依赖/归属门、迁移和重试预算校准。
- [x] S1：根任务封口、整树中断、关键保存失败阻断与显式恢复、A→B 交接。
- [x] S2：后台 job 精确取消、资源生命周期、统一有界关闭、真实进程退出确认。
- [x] S3：owner 隔离、离线迁移与备份、冷恢复封口、retained 单条重新准入。
- [x] S4：SDK/远程/Web/TUI 一致，队列编辑/删除/发送、Steer 提示及组合测试。
- [x] 全量验证、独立子代理审核、Pi 两轮审核和修复复验、05 对账。

## S0 当前证据与原则

现有 run manager、prompt scheduler/store、composition 基线四文件 103 测试通过；命令记录 `/tmp/ohbaby-improve4-baseline.log`。子代理独立跑 execution/host/Bash 清理/registry 六文件 102 测试通过，另一个 composition 持久身份回退测试通过。

子委托在创建 child 前已接受 execution/root 身份，queued 时 childRunId 可空；同实例新委托身份不复用。工具 owner 尚缺 rootRunId/executionId，后台 Bash job 只有 scope/session 级清理，需先在所属模块补精确归属与取消，再通过 T01/D14 门槛。不得按 parentSessionId 替代当前任务树。

SWE 实施护栏：复用 execution store、工具 scheduler/registry、既有 SQLite 事务和源投影；运行时只协调各模块拥有的事实。关键停止保存决定交接资格，物理清理继续由原 owner 持有。普通查询保持只读；恢复不重放模型或工具。新状态/字段只用于本轮已确认行为，不引入第二套任务平台。

## 2026-09-28 联调与范围补充

用户追加约束：本轮不得修改既有 system-prompt 拼接模块/规则，避免影响 cache hit。已只读核对 `9d016770`（2026-09-15 正式持久 agent 请求路径测试）及对应 improve-5.5 验收；本轮 retained 只作用于调度准入与展示。后续 diff 验收单独确认生产 prompt/context/cache 构造模块未改。

S0/S1/S3 初步联调：ownership 145 测试、Run durability 90 测试、存储/离线迁移 77 测试、CurrentRunInput 27 测试通过。新增真实 backend Stop 关键保存失败→B阻断→显式重试只运行B一次回归已通过。独立子代理审查抓到恢复分页不足、调度microtask空转、重试结束时间、跨owner实例覆盖；均补正式回归并修正，恢复相关43项通过。审查和全量测试仍在进行，数字不代表最终全矩阵验收。

新子实例恢复方法在store内重读/CAS，精准移除旧root/execution队列项，新owner已认领的current与新pending保留。未知owner默认阻断；离线022升级独立处理旧active，保存recovery时间来源。普通snapshot/history/control不触发恢复。

## 最终验收收口

实现与分层验证记录已汇总到 [05-implementation-acceptance.md](05-implementation-acceptance.md)。最终全量5208通过、17跳过，类型检查与lint通过（0 errors、93 warnings）；真实模型修复后root/双child各一次复验5/8请求通过，真实compiled Web、remote/default inprocess PTY、服务端成功后响应截断重试及最终页脚复验均完成。Pi两轮和最后增量子代理复审没有遗留阻塞项。源码与测试本地提交 `b436843315accee92e943462d9b8f95944dae2ae`，文档证据独立提交。保留 `codex/improve-4`，未merge或push。
