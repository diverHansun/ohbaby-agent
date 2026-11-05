# data-model

> 2026-11-04。本模块没有数据库表，下面的“数据”都是文件系统上的目录和文件。

## 1. Core Concepts

| 概念 | 含义 |
|---|---|
| 会话存储区（session storage） | 一个归属会话独有的目录，`<OHBABY_HOME>/sessions/<ownerId>/` |
| 归属会话（owner） | 存储区属于哪个会话：子代理会话归根会话，side chat 归主会话，其余会话归自己 |
| scratch | 存储区里给 agent 用的子目录，放临时文件、中间结果和产物 |
| tool-output | 存储区里给系统用的子目录，放超长工具输出的完整内容（第二期） |

不在本模块里的相近概念：

| 概念 | 区别 |
|---|---|
| workspace（工作区） | 用户选的文件夹，会话在里面运行 |
| working directory（运行目录） | 会话这一轮实际运行的目录 |
| default directory（默认目录） | 没选工作区的会话运行的共用目录 `<OHBABY_HOME>/workspace/default` |
| 数据目录 | 平台数据目录下的 `ohbaby.db`、`storage/`、`snapshot-git/` |

## 2. Key Data Fields

### 2.1 目录布局

```
<OHBABY_HOME>/sessions/
└── <ownerId>/                       0700（非 Windows）
    ├── scratch/                     agent 可写
    └── tool-output/                 第二期：第一次写入时创建；系统写，agent 可读
        ├── <callId>-<随机 6 位>.txt   非 Bash 工具的完整输出
        └── <jobId>.log               Bash 任务的完整 stdout 与 stderr
```

- `ownerId` 只允许 `[A-Za-z0-9_-]`，长度不超过 128。
- 文件名里的 `callId` 先把不允许的字符替换成 `_`，再加 6 位随机后缀。有的服务商会重复使用 `call_0` 这类 ID，不加后缀会互相覆盖。
- Bash 用任务 ID 命名，不用调用 ID：后台任务比发起它的那次调用活得久。
- 第二期每个输出文件上限 10 MB，超出部分不写，并在文件末尾注明已截断。

### 2.2 不保存的信息

本模块不记录目录是否存在、里面有什么、何时创建。需要时直接看文件系统。

## 3. Lifecycle & Ownership

| 时机 | 动作 | 谁负责 |
|---|---|---|
| 会话（或它的子代理、side chat）第一次运行，sandbox 上下文创建 | 建归属会话的 `sessions/<ownerId>/` 和 `scratch/`，登记为可信路径 | sandbox 调用注入的回调 |
| 运行中 | agent 读写 `scratch/`；第二期工具把超长输出写进 `tool-output/` | agent、工具 |
| 会话归档、移动工作区、撤销重发 | 不动 | — |
| 归属会话被永久删除 | 删除 `sessions/<id>/`（子代理会话的 ID 没有目录，删除时不报错） | `cleanupDeletedSessionFiles` |
| side chat 关闭、启动清理 side chat | 不删存储区，side chat 写的文件留在主会话的存储区里 | — |
| fork | 新会话第一次运行时建自己的目录；不复制源会话的文件 | — |

归属：目录属于归属会话。归属会话不存在了，目录就该被删掉；删除失败只记日志，不回滚数据库的删除，与现有的文件清理一致。
