# AppContext 已拆分

本 Context 已按 State/Action 分离原则拆分为两个独立 Context：

- [AppStateContext](./app-state-context.md) -- 应用只读状态（视图、弹窗队列、加载阶段）
- [AppActionsContext](./app-actions-context.md) -- 应用状态变更动作（导航、弹窗操作、加载控制）

拆分理由见 [contexts/index.md](./index.md) 第二章"设计原则"。
