# Message 消息组件概述

> 待撰写：消息组件设计概述

## 概述

消息组件采用**类型路由模式**，由 MessageList 作为入口，根据消息类型分发到具体组件。

## 架构

```
MessageList (列表容器，支持虚拟化)
├── UserMessage (用户消息)
├── AssistantMessage (AI 响应)
├── SystemMessage (系统消息)
└── ... (其他消息类型)

每种消息内部渲染 Parts:
├── TextPart
├── ReasoningPart
├── ToolPart
└── FilePart
```

## 组件列表

- [message-list.md](./message-list.md) - 消息列表（虚拟化）
- [parts/](./parts/index.md) - Part 子组件

## 为什么选择类型路由模式？

参考 gemini-cli 的设计，类型路由模式的优点：

1. 每种消息类型逻辑独立，便于维护
2. 代码更加模块化，易于测试
3. 新增消息类型时只需添加新组件
