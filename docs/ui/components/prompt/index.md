# Prompt 输入框组件概述

> 待撰写：输入框组件设计概述

## 概述

输入框组件负责用户文本输入，依赖 Ink 的 TextInput。

## 功能

- 多行文本输入
- 历史记录导航（↑/↓）
- Tab 命令自动补全
- 输入提交（Enter）

## 子模块

- [input-history.md](./input-history.md) - 输入历史管理

## 依赖

- Ink TextInput 组件（不自行实现 TextBuffer）
