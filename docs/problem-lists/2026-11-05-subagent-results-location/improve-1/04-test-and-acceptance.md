# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 3。测试与源码放在同一目录，命名为 `*.unit.test.ts`、`*.integration.test.ts`，`tests/setup/vitest-env.ts` 只设一个共用的临时 `HOME`；需要隔离 `OHBABY_HOME` 的用例各自用 `vi.stubEnv("OHBABY_HOME", <临时目录>)`。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | 路径计算：`resolveSessionStorageRoot`、结果文件的键 |
| integration | 真实 SQLite 加真实文件系统：导出、重新导出、符号链接防护、删除；真实的工具调度器加 sandbox：读写权限 |
| 手工 | 真跑一次长报告的子代理，看父代理能否读到、子代理的长日志写在哪 |

不测：子代理结果的送达时机和批量逻辑，improve-3 的测试已经覆盖，本议题没有改动它们。

## 4.2 关键场景

### Stage 1：换导出位置

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 长报告导出 | integration | 正文超过 51,200 字节：文件出现在 `<OHBABY_HOME>/sessions/<rootSessionId>/subagents/<subagentId>/<executionId>.output`，内容和数据库里的正文一致；送达消息里的路径是这个新路径，`sizeBytes`、`estimatedTokens` 正确；在 POSIX 系统上新建的目录权限为 0700 |
| T2 | 短报告不变 | integration | 正文正好 51,200 字节和 51,201 字节各跑一次：前者全文放进消息、不产生文件；后者导出 |
| T3 | 父代理免确认读取 | integration | 在默认权限档位下，主会话用 `read` 读 T1 的文件不弹确认；`grep` 也不弹 |
| T4 | 同一根会话内都能读 | integration | 子代理 A 的报告：兄弟子代理 B 用 `read` 读不弹确认。side chat 议题已落地时，side chat 读主会话子代理的报告也不弹确认 |
| T5 | 写入要确认 | integration | 主会话或子代理用 `write`、`edit` 改 T1 的文件，弹外部写入确认；Bash `cat` 或 `echo x >` 这个文件，弹外部路径确认 |
| T6 | 旧记录自动重新导出 | integration | 正文超过 51,200 字节（否则会直接放进消息，走不到导出），把执行记录的 `artifact` 设为 `{ state: "ready", path: <旧位置> }`：下次 `prepare` 导出到新位置，记录里的路径更新为新路径 |
| T7 | 符号链接防护 | integration | 把 `sessions/<root>/subagents/` 换成指向别处的符号链接后导出：报告文件不会写进链接目标（`mkdir` 可能先在目标里建出 `<subagentId>/` 空目录，可接受），返回“文件不可用”的说明，记录状态为 `error` |
| T8 | 可信路径没登记上 | integration | 让存储区回调返回空列表（例如模拟建目录失败）：导出照常完成，读取时弹外部读取确认，不报错 |
| T9 | 永久删除 | integration | 走真实的 `deleteArchivedSession` 加 `cleanupDeletedSessionFiles`：`sessions/<root>/` 连同 `subagents/` 一起被删；`cleanupDeletedSessionFiles` 不再引用 `subagent-results` |
| T10 | 会话移除事件 | integration | 发布 `SessionEvent.Removed` 后，相关执行记录的导出状态为 `deleted`，文件不在了 |
| T11 | fork 读源会话报告 | integration | fork 议题已落地时：fork 出来的会话读源会话的报告，弹外部读取确认 |

### Stage 2：删除专用读取通道

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T12 | 代码里不再有专用通道 | 静态检查 | `grep -rn "authorizeInternalRead\|internalRead" packages` 没有结果 |
| T13 | 删除后 T3 至 T5 仍然通过 | integration | 重跑 T3、T4、T5 |
| T14 | 不在可信路径里的读取 | integration | 读一个任意的外部文件，仍然按外部读取流程弹确认，和改动前一致 |

### Stage 3：提示词和清理

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T15 | 子代理提示词 | unit 或快照 | 子代理的系统提示词里有“写进 session scratch directory、文件名对应任务”的说明；`explore` 的提示词仍然要求只读 |
| T16 | `forceFile` 已删除 | 静态检查 | `grep -rn "forceFile" packages` 没有结果；`pnpm typecheck` 通过 |
| T17 | 真实运行 | 手工 | 派一个 `generic` 子代理做一件会产生长日志的事：日志写进根会话的 `scratch/`，不在工作区；让它产出超过 50KiB 的报告，父代理拿到新路径并能读到全文 |

## 4.3 集成边界

| 集成点 | 怎么验证 |
|---|---|
| 会话存储区第一期 | T3 至 T5、T8 依赖它登记的两档可信路径；先确认存储区的 S3、S3b 通过 |
| 续接协调器 | 不改；T1、T2 通过真实的 `prepare` 调用验证送达内容 |
| daemon 的会话删除 | T9 |

## 4.4 回归清单

- `A/agents/subagents/result-artifacts.integration.test.ts` 里原有的导出、重试、墓碑、二进制正文用例，换成新路径后全部通过。
- `A/services/session/archive-files.integration.test.ts`、`S/runtime/daemon/archive-server.integration.test.ts` 通过。
- sandbox、scheduler 里与外部读取、外部写入相关的现有用例通过。

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 前置条件 | 会话存储区第一期的发布门已通过 | 查存储区 test.md §4 |
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm -C packages/ohbaby-agent prompt:check` |
| 自动化测试 | T1 至 T16 通过（T4 的 side chat 部分、T11 视相关议题是否落地） | `pnpm test:unit`、`pnpm test:integration` |
| 手工 | T17 通过 | 本机 daemon |
| 文档 | `docs/services/session-storage/` 与实现一致 | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 子代理被网页里的恶意指令诱导，去改写兄弟子代理的报告 | `subagents/` 只读，写入要用户确认；Bash 访问也要确认 | 用户对写入或外部读取选了“始终允许”后，会话级规则会放行；外部读取的批准还会把目录登记成可写（02 §2.6，既有行为） |
| 用户把 `~` 或 `~/.ohbaby` 选作工作区 | 无 | 运行目录内的写入本来就不确认，只读那一档失效（02 §2.6） |
| 以后新增一个写文件的工具，路径参数不叫 `file_path`、`filePath`、`path` | 无 | 调度器认不出它的写入路径（`scheduler.ts:271-279`），不会弹确认。新增写工具时要检查 |
| 子代理用 Bash 在 `scratch/` 里造一个指向 `subagents/` 的符号链接，再往链接里写 | 写工具按真实路径判断权限，真实路径在只读那一档里，仍要确认 | Bash 预检按命令里的字面路径判断，可能放过经 `scratch/` 里符号链接的写入。导出时的符号链接检查和写后核对只保护系统自己写的那一刻。评审时看存储区第一期对 Bash 的处理是否解析真实路径 |
| 有人把 `subagents/` 整个换成符号链接，诱导系统把报告写到别处 | 导出前核对父目录的真实路径，写后核对文件的真实路径（T7） | 无 |
| 删除专用通道后，有别的内部文件也依赖它 | T12 静态检查；勘测时只有子代理结果在用 | 无 |
| 导出根和可信路径算出来的位置不一致 | 两处都用 `resolveSessionStorageRoot()`，不再有可覆盖的选项（00 P4） | 无 |
