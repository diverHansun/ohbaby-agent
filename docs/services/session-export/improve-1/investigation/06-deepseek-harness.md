# DeepSeek Harness 会话日志导出

来源：本地 `deepseek-harness/`，HEAD `d743267388641bc76f17c45ce8b4c231aed1d32c`。下文主路径为 `packages/session-query/session-log-export/`。

## 已证实事实

| 主题 | 事实 | 证据 |
|---|---|---|
| 入口 | Web /export 和 Header 菜单共用下载 controller；带路径参数报错；仅发起命令的浏览器接收下载动作。 | `src/index.ts:78`；`src/client/index.ts:36` |
| 读取顺序 | 活跃 Session flush，再 persistence.open(read)，读完整 durable events，finally 关闭句柄。 | `src/archive.ts:80,110,148` |
| 格式 | 一行会话头、每行一个事件、末尾换行，随后打包 ZIP；格式独立于实际持久层介质。 | 同文件 serializeSessionLog |
| 内容 | 不按用户/助手筛选事件；compact 前事件、工具、reasoning、命令生命周期等，只要已持久化都保留。 | 同文件 `:134` |
| 子会话 | 浏览器 includeDescendants=true；根日志为 session[.vN].jsonl，后代放 subagents/{id}/；seen-set 去重。 | 同文件 `:347`；`src/client/controller.ts:109` |
| 后代含义 | traceSession 按 parentSession 建树，未限制 origin 必须是 subagent，所以目录名不等于严格只有委派子代理。 | `packages/session-query/session-query/src/tracing.ts:119` |
| 附件 | 从白名单事件 content 找图片与文件引用，去重后放 media/、files/；未知字段不会触发任意附件读取。 | `src/archive.ts:186,231,391` |
| 文件名 | dsh-session-{safe-id}.zip；ID、附件路径有字符清洗。 | 同文件 `:191,318` |
| 保存 | 服务端提供响应，不写用户下载目录；客户端 HEAD 预检后把 GET 交浏览器下载管理器。 | `src/client/controller.ts:43,109` |
| 成功含义 | controller 的 success 表示已交浏览器开始下载，不能证明文件落盘成功。 | 同文件 `:109`；`README.md:64` |
| 失败 | 参数 400、根不存在 404、准备失败通用 500；子会话/附件读取失败使 ZIP 流失败，不悄悄交付不完整归档。 | `src/index.ts:108`；`src/archive.ts:594` |
| 性能 | ZIP 有 64 KiB 高水位、pull 背压与取消传播；字符串分块保留 Unicode surrogate pair。但完整根日志仍先进入内存。 | `src/archive.ts:406,504,545` |
| 信任边界 | 下载路由复用 Connection 的 Host/Origin/browser session 检查；日志正文没有通用秘密检测。 | `packages/client/connection/src/api-request-trust.ts:121`；archive 序列化流程 |

## 与旧笔记的差异

`.agents/notes/archived/feature/2026-08-10-web-session-log-export.md` 写固定 session.jsonl 和 stat 预检；当前实现使用版本化文件名和 open 的 NotFound 判定。

该笔记没有“主机路径对远程浏览器没有意义”这句，也没有把后端写文件列成已否决替代方案。浏览器负责保存可由当前源码确认，不能引用成笔记原话。

## 测试证据

- `tests/archive.host.spec.ts:391,489,521` 等：flush-before-read、冷会话、根/后代/附件失败、取消、背压、Unicode、引用白名单与去重。
- client tests：并发下载手势合并、关闭对话框、错误与卸载。
- `tests/loader-composition.host.spec.ts:25`：真实装配下 /export 可发现和执行。

## 待核实

未运行该仓测试或真实浏览器下载。多个会话各自 flush/read，并不是整棵会话树的原子快照；未持久化流式尾部也不在 durable events 内。

## 推断

“完整日志 ZIP”与“完整可读讨论”不能直接互换。依据是 ZIP 包含内部事件、附件与后代，而 ohbaby 文档规定过滤模型内部状态并排除子代理中间过程。
