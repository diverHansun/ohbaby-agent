# 前端架构

继续采用现有 React、store、SDK 读取器和共享 workspace 传输。工程落点在 [总体方案关键范围](../02-optimization-plan-and-change-scope.md#5-关键代码范围)，不建立第二套聊天框架。

## 组合关系

```text
SessionScreen
  RootConversation（保持挂载）
    ConversationStream
      DelegationRow / 原有工具与消息
  ChildConversationViewport（最多一个）
    Header / Breadcrumb
    共用 ConversationStream
    读取状态与只读说明
  RootComposer（草稿状态保留）
```

DelegationRow 是 `subagent_run` 的入口表现；ChildConversationViewport 是现有 SubagentView 的改造职责名，并不要求按这里命名新文件。主阅读区和 child 放在稳定父容器下，浮层/放大只改布局 class，避免条件分支重挂载或切换 portal 宿主。

## 状态归属

SDK reader 负责权威数据、请求取消、版本恢复、窗口边界；Web store/会话控制层负责选中身份、展开模式、阅读锚点和工具展开 map；消息组件只渲染并回报用户动作。是否处于 child 阅读模式作为统一派生条件控制输入框和操作入口，避免只禁按钮却漏掉 Enter/快捷键。

根读取器始终持续接收消息与审批；子详细订阅仅保留当前一个。展开状态可通过可选受控属性供 child 使用，根的既有行为不强制改变。不得为保存状态而挂载所有历史子代理的消息树。

## 与既有设计的关系

原 Web 文档的组件复用、UI→SDK、单 workspace SSE 仍有效；“子执行详情替换主视图”和轮询只能代表 improve-3 现状。本轮实施时同步更新相关模块文档，当前规划不把这些目标冒充已完成能力。
