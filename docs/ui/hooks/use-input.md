# useInput 输入处理 Hook

> 待撰写：useInput 详细设计

## 职责

处理用户输入，实现命令分流。

## 核心逻辑

```typescript
const handleSubmit = async (text: string) => {
  if (text.startsWith('/')) {
    // Slash 命令 → cli/commands
    return await executeSlashCommand(text);
  } else {
    // 普通对话 → lifecycle
    return await lifecycle.execute(text);
  }
};
```

## 返回值

待补充...

## Tab 自动补全

支持 Tab 键触发命令自动补全。

待补充...
