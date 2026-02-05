# Hooks 概述

> 待撰写：Hooks 设计概述

## 概述

Hooks 封装交互逻辑，将状态逻辑与 UI 渲染分离。

## Hook 列表

- [use-input.md](./use-input.md) - 输入处理和命令分流
- [use-stream.md](./use-stream.md) - 流式响应订阅
- [use-auto-scroll.md](./use-auto-scroll.md) - 自动滚动控制
- [use-keyboard.md](./use-keyboard.md) - 键盘快捷键
- [use-history.md](./use-history.md) - 输入历史导航
- [use-permission.md](./use-permission.md) - 权限对话框状态

## 设计原则

- 逻辑复用：相同逻辑只实现一次
- 可测试：Hook 可独立测试
- 组件简洁：组件只负责渲染
