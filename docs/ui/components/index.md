# Components 组件层概述

> 待撰写：组件层设计概述

## 概述

组件层提供可复用的 UI 组件，使用 React + Ink 构建。

## 组件分类

### 消息相关
- [message/](./message/index.md) - 消息组件（类型路由模式）

### 输入相关
- [prompt/](./prompt/index.md) - 输入框组件
- [status-bar.md](./status-bar.md) - 状态栏组件

### 对话框
- [dialogs/](./dialogs/index.md) - 对话框组件（队列管理）

### 通用组件
- [shared/](./shared/index.md) - 通用基础组件

## 设计原则

- 消息组件采用**类型路由模式**（每种消息类型独立组件）
- 对话框组件采用**队列管理**（不叠加，依次显示）
- 通用组件追求高复用性
