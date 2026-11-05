# data-model

2026-11-05 实施状态：第一期、子代理结果搬迁与第二期 a 工具输出存盘已实现；当前归属按 `parentId ?? sessionId` 计算。本文涉及 side chat 共享、fork 独立目录及源文件读取的内容是后续议题的约束，尚未实现或验收；第二期 b 文件 API 与 Files 页尚未实现。

> 2026-11-04。本模块没有数据库表，下面的“数据”都是文件系统上的目录和文件。

## 1. Core Concepts

| 概念 | 含义 |
|---|---|
| 会话存储区（session storage） | 一个归属会话独有的目录，`<OHBABY_HOME>/sessions/<ownerId>/` |
| 归属会话（owner） | 存储区属于哪个会话：子代理会话归根会话，side chat 归主会话，其余会话归自己 |
| scratch | 存储区里给 agent 用的子目录，放临时文件、中间结果和产物；唯一默认免审批可写的部分 |
| subagents | 存储区里给系统用的子目录，放子代理超过 50KiB 的长报告（由子代理结果搬迁议题写入） |
| tool-results | 存储区里给系统用的子目录，放超长工具输出（第二期）；超过文件上限时保存部分内容并注明 |

不在本模块里的相近概念：

| 概念 | 区别 |
|---|---|
| workspace（工作区） | 用户选的文件夹，会话在里面运行 |
| working directory（运行目录） | 会话这一轮实际运行的目录 |
| default directory（默认目录） | 没选工作区的会话运行的共用目录 `<OHBABY_HOME>/workspace/default` |
| 数据目录 | 平台数据目录下的 `ohbaby.db`、`storage/`、`snapshot-git/` |

2026-11-05 复查确认：会话存储区不会替换 working directory。工具的相对路径仍按原运行目录解析；模型需要写临时文件、报告或中间产物时，应使用会话 `scratch/` 的路径。用户要求修改或创建的项目文件仍按任务约定的位置写入。

## 2. Key Data Fields

本文目录树中的“只读”指模型访问的默认权限：在 `default` 权限档位下，模型可以直接读取系统文件，改写需要审批。系统仍能保存报告和工具原文；0700 等文件系统权限用于限制其他本机用户，不负责区分 agent 与系统。

### 2.1 目录布局

```
<OHBABY_HOME>/sessions/
└── <ownerId>/                       0700（非 Windows）；整个目录只读（session-storage）
    ├── scratch/                     agent 可写（session-scratch）
    ├── subagents/                   子代理结果搬迁议题：第一次导出时创建；系统写，agent 可读
    │   └── <subagentId>/<executionId>.output
    └── tool-results/                第二期：第一次写入时创建；系统写，agent 可读
        ├── <safe-callId>-<UUID>.txt   非 Bash 工具输出（受文件上限限制）
        └── <jobId>.log               Bash 任务的 stdout 与 stderr（受文件上限限制）
```

- `ownerId` 只允许 `[A-Za-z0-9_-]`，长度不超过 128。
- `scratch/` 由同一根会话的主代理和子代理共享，不强制按子代理再建一层目录。系统保存的最终长报告仍按 `subagents/<subagentId>/<executionId>.output` 区分代理与执行；两者是不同用途，本次确认不改变报告目录结构。
- 文件名里的 `callId` 只保留 `[A-Za-z0-9_-]`，其他字符替换成 `_`，取前 128 个字符，空串用 `call`；再加随机 UUID 后缀。有的服务商会重复使用 `call_0` 这类 ID，不加后缀会互相覆盖。独占创建同时拒绝覆盖已有文件或链接。
- Bash 用任务 ID 命名，不用调用 ID：后台任务比发起它的那次调用活得久。
- 每个输出文件上限 10 MiB（10,485,760 字节，`TOOL_OUTPUT_MAX_BYTES`），文件末尾的截断说明也计入上限；不会截在 UTF-8 字符中间。POSIX 下目录 0700、文件 0600。
- 工具结果里的 `metadata.outputFile` 只在显示发生截断时出现。完整文件为 `full`，达到上限或捕获提前结束为 `partial`，仍在捕获为 `in-progress`，保存失败为 `unavailable`。失败结果不携带成功路径；具体结构见 [dfd-interface §3.2](dfd-interface.md#32-第二期)。

### 2.2 不保存的信息

本模块不记录目录是否存在、里面有什么、何时创建。需要时直接看文件系统。

## 3. Lifecycle & Ownership

| 时机 | 动作 | 谁负责 |
|---|---|---|
| 会话（或它的子代理、side chat）第一次运行，sandbox 上下文创建 | 建归属会话的 `sessions/<ownerId>/` 和 `scratch/`，登记两档可信路径：会话目录只读、`scratch/` 可写 | sandbox 调用注入的回调 |
| 运行中 | agent 读写 `scratch/`；子代理的长报告导出到 `subagents/`；第二期工具把超长输出写进 `tool-results/` | agent、子代理结果导出、工具 |
| 一轮任务结束、子代理结束或关闭 | 不自动删除会话目录及其中的文件，后续仍可读取 | — |
| 会话归档、恢复、移动工作区、撤销重发 | 不动，路径和文件保留 | — |
| 归属会话被永久删除 | 删除 `sessions/<id>/`（子代理会话的 ID 没有目录，删除时不报错） | `cleanupDeletedSessionFiles` |
| 长时间没有使用 | 不自动删除，暂不做定时清理 | — |
| side chat 关闭、启动清理 side chat | 不删存储区，side chat 写的文件留在主会话的存储区里 | — |
| fork | 新会话第一次运行时建自己的目录；不复制源会话的文件 | — |

归属：目录属于归属会话。归属会话不存在了，目录就该被删掉；删除失败只记日志，不回滚数据库的删除，与现有的文件清理一致。

2026-11-05 复查确认：以上保留规则适用于 `scratch/`、`subagents/` 和 `tool-results/`，不因目录名含有 scratch 或文件属于临时产物就提前清理。“保留”指运行时不自动清理，不改变已确认的模型读写与审批规则；用户项目中的文件不属于本模块的删除范围。
