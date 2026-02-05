# Dialogs 对话框组件概述

> 待撰写：对话框组件设计概述

## 概述

对话框组件提供模态交互界面。

## 设计决策：队列管理模式

对话框采用**队列管理**而非栈叠加：

- 多个对话框请求进入队列
- 当前只显示一个对话框
- 用户响应后，对话框消失，显示下一个
- 避免叠加导致的 UI 错位问题

## 组件列表

- [dialog-manager.md](./dialog-manager.md) - 对话框队列管理器
- [permission-dialog.md](./permission-dialog.md) - 权限确认对话框
- [model-dialog.md](./model-dialog.md) - 模型选择对话框
- [session-dialog.md](./session-dialog.md) - 会话选择对话框

## 通用 Dialog 基础组件

所有对话框共享基础结构：

```
┌─ Dialog Title ──────────────────┐
│                                 │
│         Dialog Content          │
│                                 │
├─────────────────────────────────┤
│    [Button1]  [Button2]  ...    │
└─────────────────────────────────┘
```
