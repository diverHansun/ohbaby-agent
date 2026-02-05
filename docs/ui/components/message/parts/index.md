# Parts 消息内容组件概述

> 待撰写：Part 组件设计概述

## 概述

Part 组件负责渲染消息的具体内容片段。

## Part 类型

- [text-part.md](./text-part.md) - 文本内容（Markdown）
- [reasoning-part.md](./reasoning-part.md) - 推理内容（可折叠）
- [tool-part.md](./tool-part.md) - 工具调用（状态显示）
- [file-part.md](./file-part.md) - 文件附件

## 渲染流程

```
Message
├── part[0]: TextPart → <TextPart />
├── part[1]: ToolPart → <ToolPart />
├── part[2]: TextPart → <TextPart />
└── ...
```
