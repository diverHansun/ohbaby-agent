# todo-list 模块 non-functional.md

本文档定义 TodoList 的工程质量与运行约束。

**前置文档**：`goals-duty.md`、`architecture.md`、`dfd-interface.md`

## 一、质量优先级

1. **契约正确与 session 隔离**：失败写入、恢复和子 Agent 不能污染其他列表。
2. **UI 一致与可恢复**：Web/TUI 通过相同 snapshot/event 得到同一状态。
3. **界面克制**：Todo 不污染 transcript，不挤占主要工作区。
4. **实现简单**：短列表整体替换，不引入专用持久化或复杂状态机。

## 二、运行约束

### 规模

- 每个 session 最多 10 项，后端硬拒绝第 11 项。
- 每项 content 最多 100 个 Unicode 字符，trim 后必须非空。
- Web 渲染完整 10 项并限高滚动；TUI 紧凑 5 项、展开最多 10 项。

### 性能

- 正常 read/write 只操作内存，不访问网络、文件或数据库。
- 结构比较、克隆和 TUI 选择均为 O(n)，且 n ≤ 10。
- 历史扫描只在 session unloaded 时发生，从后向前命中即停。

### 内存

- 每个 session/context scope 只保存当前列表和 loaded 状态，不保存版本历史。
- session 从 runtime 释放时清除对应投影。
- 子 Agent context 关闭时释放对应 scope 缓存，不等待整个 child session 删除。

## 三、可靠性

### 原子性

完整验证后再写入。任何字段、长度或数量错误都不能部分更新 store、snapshot 或事件流。

### 幂等性

同一完整数组重复写入结果相同；调用可成功。只有列表与 `visible` 完整投影均未变化时才抑制 `todo.updated`，可见性变化仍必须同步。

### 恢复

- 只恢复最后一次成功完成的 write transaction。
- `[]` 是有效最终状态。
- 解析失败跳过候选并记录 warning；没有有效候选时为空。
- loaded + [] 不允许重新回扫。

### UI 一致性

- event 使用完整替换，避免客户端 patch 漂移。
- snapshot 是 resync 基线。
- `visible` 由后端投影，两个客户端不独立推断本轮触达状态。

## 四、可观测性与隐私

- 参数错误返回 Agent，使其可重试；普通 UI transcript 不显示 Todo 错误或 payload。
- 恢复损坏候选记录 warning；正常写读和相同列表重复写只需 debug 级日志。
- 日志不应重复输出完整 Todo 内容，避免将用户任务文本扩散到额外日志面。
- 当前阶段不增加 Todo 专用 metrics、trace 或 dashboard。

## 五、兼容性与可访问性

- `UiSnapshot.todos` 为可选字段，缺失按空处理。
- Web 状态不能只靠颜色，应有图标/文本样式；长内容应换行或安全截断且可读。
- TUI 使用终端可辨识符号，并保证无颜色环境仍能区分状态。
- `Ctrl+T` 只在 Todo 存在溢出时由面板消费，减少键位冲突。

## 六、暂缓项

- Todo 专用数据库或文件。
- priority、cancelled、id、依赖和 owner。
- UI 直接编辑、拖拽和跨 session 汇总。
- 复杂动态窗口算法或基于终端高度的优先级调度。
- 专用浏览器 E2E 框架；本阶段用真实浏览器控制完成验收，后续达到稳定回归需求时再评估框架化。

## 七、完成后的自检

- [x] 10/100 的硬边界与 UI 容量策略一致。
- [x] 原子性、幂等、恢复与 snapshot resync 均有约束。
- [x] transcript 静默没有牺牲 Agent 错误处理和诊断。
- [x] 暂缓项与最小模块定位一致。
