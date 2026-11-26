# 会话搜索现状与问题

| 用户操作 | 当前行为与改动原因 |
|---|---|
| 输入一个词或用空格分开的多个词 | [全局会话查询](../../../../packages/ohbaby-agent/src/services/session/global-query.ts)已在全部活跃主会话中查标题和正文。同一标题或同一条消息须含所有关键词，每个词按连续原文匹配。这次沿用该算法。 |
| 搜聊天里见过的一句话 | 界面用[展示文字](../../../../packages/ohbaby-agent/src/core/message/origin.ts)，现有搜索和摘要读原始文本。部分 Goal 消息会搜漏界面文字、搜出内部提示。重试后被替换的消息在[聊天视图](../../../../apps/ohbaby-web/src/ui/conversation/ConversationStream.tsx)另有过滤，搜索也应遵循同一可见性。 |
| 搜相距很远的两个词 | 查询能命中，但摘要只截首词附近。[侧栏搜索](../../../../apps/ohbaby-web/src/ui/search/SidebarSearch.tsx)又按整串输入高亮，用户可能看不出为什么命中。讨论记录里有相隔 500 字符的实测例子。 |
| 点 Search 后选择结果 | 目前展开侧栏小输入框。选择处理只向上交会话，[搜索结果](../../../../packages/ohbaby-sdk/src/contract/global-sessions.ts)已有的消息 ID 在这里丢失。 |
| 打开很早的正文结果 | [主会话历史](../../../../packages/ohbaby-agent/src/adapters/ui-state/source-session-projection.ts)按游标向前取一页，再投影为聊天界面使用的消息、运行记录和用户输入。底层[消息分页](../../../../packages/ohbaby-agent/src/core/message/pagination.ts)已有前后两种方向，但主会话读取接口还不能以一条消息为中心取上下文。 |

全局查询负责告诉前端“哪个会话、哪条消息命中”；会话自己的历史读取负责回答“这条消息旁边说了什么”。这两处都已有调用链，本次分别补齐即可。
