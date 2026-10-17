# ZCode 公开会话分享

来源：本地 `ZCode/`，HEAD `aac4755666d09fdcd70272fcf063c077a639015f`。只读调查；按该仓要求检查了仓库 freshness，main 与 origin/main 同步。

## 已证实事实

| 主题 | 事实 | 证据 |
|---|---|---|
| 菜单 | TaskActionMenuContent 有 Pin、Rename、Archive 等，没有 Export；真正分享入口在顶栏 ConversationShareMenu。 | `packages/ui/src/TaskActionMenuContent.tsx:88`；`ConversationShareMenu.tsx:10` |
| 产品能力 | publish 读取 rows、筛选、清理、物化附件、生成公开投影，然后上传/确认并返回分享 URL。不是本地 JSON 文件导出。 | `packages/services/src/conversation-share/conversationShareService.ts:1865,1971,2073` |
| 完整分页 | loadAllRows 翻到最旧页；各页必须保持 atLogEpoch/atRevision，游标必须推进，rowId 严格递增。 | 同文件 `:2427` |
| 变化处理 | 读取期间版本变化会失败，报 Conversation changed while preparing share。 | 同文件 loadAllRows |
| 选取范围 | 可选全部、产品轮次、行锚点；锚点扩展成完整轮次并验证唯一 header。 | 同文件 `:585` |
| 活跃状态 | running turn、streaming assistant/reasoning、活跃 tool/subagent、进行中的 compact/goal verification 都会拒绝。 | `conversationSharePublicProjection.ts:74` |
| 内容过滤 | 删除已结束的 compact/model/goal/retry/fork/rollback timeline marker、EnterPlanMode 内部工具、hookInvocation 和 subagent 详情。 | `conversationShareService.ts:326`；`conversationSharePublicProjection.ts:338,592` |
| 保留内容 | completed reasoning、普通工具 input/output 可保留；工具输出仅取 text，不带本地 truncated.ref；Agent 工具调用可以保留。 | `conversationSharePublicProjection.ts:338,592` |
| 身份 | 白名单重建各类 Row，重写内部 ID、引用关系，artifact ref 变成公开命名空间。 | 同文件 `:58,177,262` |
| 图片附件 | 先物化内嵌图片，再按服务端类型白名单处理；上传校验 size/hash/回执；部分不可处理引用会警告后继续。 | `conversationShareService.ts:1975,2045,2126` |
| 秘密检测 | 用户需勾选确认没有自动秘密检测，service 要求 disclosureAcceptedAt，confirm 记录 acknowledged_no_secret_detection。 | 同文件 `:1959`；`packages/ui/src/v4/ConversationShareConfirmationDock.tsx:377` |
| 导入 | importShare 写 shared-conversation.json 和附件，再作为 shared context/new session；不是无损恢复原日志。 | `conversationShareService.ts:1401,1623` |

表内未列完整目录的 projection/service 文件均位于 `packages/services/src/conversation-share/`。

## 原文档需要限定的表述

“不脱敏”如果指没有自动识别正文中的秘密，是准确的；如果指原始对象直接上传，则不准确。ZCode 对内部字段、引用和身份执行了明确的公开投影。

没有找到本地会话 /export 路径，也没有本地导出文件名或 Downloads 规则可以参考。这个结论来自菜单与 CLI/Web/Server 相关入口检索，不是对未来版本的断言。

## 测试证据

`packages/services/test/conversationSharePublicProjection.test.ts:135,186,326` 等覆盖内部身份重写、去 subagent 详情但保留 Agent call、活跃状态拒绝、本地附件引用过滤、公开引用保留、truncated.ref 过滤。另有 service/import/artifact/integrity/composition 测试；本次未执行。

## 待核实

没有调用线上分享服务，没有产生公开链接，也没有执行导入。源码的公开投影不能证明原始 compact 前事件都被保留。

## 推断

逐页校验同一 epoch/revision 是它避免混合会话版本的手段。ohbaby 当前 listBySession 的同步 SQLite 读取形态不同，不能直接复制一整套版本协议；需要先确认自己的实际快照边界。
