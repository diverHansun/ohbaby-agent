# Terminal 设计文档

web 界面右侧面板中的内置终端：用户可以在浏览器里打开当前 workspace 的真实 shell。

| 文档 | 内容 |
| --- | --- |
| [goals-duty.md](goals-duty.md) | 为什么做、做什么、刻意不做什么，以及模块归属 |
| [architecture.md](architecture.md) | 内部组成、文件布局、依赖、取舍、对现有代码的改动面 |
| [dfd-interface.md](dfd-interface.md) | 新建、接回、输入输出、关闭等数据流，REST 与 WebSocket 接口 |
| [non-functional.md](non-functional.md) | 安全、资源上限、故障行为、暂缓项 |
| [test.md](test.md) | 关键场景、集成点、自动化与人工验证 |
| [backend-handoff.md](backend-handoff.md) | 后端分支、前端接入、实测结果与已知边界 |
| [frontend-acceptance.md](frontend-acceptance.md) | 前端实现要点、自动化结果与浏览器端到端走查 |

本模块不单独写 `data-model.md` 和 `use-case.md`，原因见 architecture 开头。

参考项目：ZCode、deepseek-harness、opencode、pi-web、Codex、kimi-code（均在 `code-cli/` 下）。
