# StatusBar 状态栏组件

> 待撰写：状态栏详细设计

## 职责

在底部固定显示系统状态信息。

## 显示内容

```
~/projects/myapp | model: gemini-pro | mode: Agent (auto-edit) | 1.2k tokens | sess: chat-2024
```

- 当前工作目录
- 当前模型名称
- 当前模式 + Agent 状态
- Token 使用量
- 当前会话名称

## 布局

待补充...

## 数据来源

- ConfigContext: model, mode, agentState, cwd
- SessionContext: sessionName, tokenUsage
