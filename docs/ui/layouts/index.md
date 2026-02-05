# Layouts 布局层概述

> 待撰写：布局层设计概述

## 概述

布局层定义应用的整体屏幕结构，与具体视图内容分离。

## 布局列表

- [DefaultLayout](./default-layout.md) - 默认布局

## 设计原则

- 布局组件决定屏幕区域划分
- 视图组件填充具体内容
- 分离关注点，便于未来扩展（如 ScreenReaderLayout）
