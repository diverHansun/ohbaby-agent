# Contexts 状态管理概述

> 待撰写：Context 设计概述

## 概述

使用 React Context 进行全局状态管理，分为多个独立 Context 以优化渲染性能。

## Context 列表

- [AppContext](./app-context.md) - 应用状态（视图、对话框、加载）
- [ConfigContext](./config-context.md) - 配置状态（模型、模式、Agent）
- [SessionContext](./session-context.md) - 会话状态（消息、会话信息）
- [KeypressContext](./keypress-context.md) - 键盘输入状态

## 设计原则

### 为什么使用多个 Context？

- Config 变化频率低，Session 变化频率高
- 分离后可避免不必要的重渲染
- 每个 Context 职责清晰

### Provider 嵌套顺序

```tsx
<AppProvider>
  <ConfigProvider>
    <SessionProvider>
      <KeypressProvider>
        {children}
      </KeypressProvider>
    </SessionProvider>
  </ConfigProvider>
</AppProvider>
```
