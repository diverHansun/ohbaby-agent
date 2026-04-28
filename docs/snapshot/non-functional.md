# snapshot 模块 non-functional.md

本文档定义 `snapshot` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，约束冲突时以此为准：

1. **Turn 审计链的完整性**（首要）：每个 Turn 必须有对应的 checkpoint 记录。track() 在 Turn 开始前写入 DB，capture() 在 Turn 结束后写入 patch 和 message cursor。崩溃后能识别哪些 Turn 存在未完成的 patch（checkpoint 存在但无对应 patch）。

2. **restore / revert 的安全性**：restore 不在有并发写入时执行。revert 按正确顺序反向应用 patch。两者都不静默跳过不可用的 artifact。

3. **message cursor 的可用性**：snapshot 保存 cursor 作为消息回滚的定位信息，但不直接改写 message。cursor 丢失会让消息回滚降级为不可用，不能静默假装已回滚。

4. **artifact 与元数据的可恢复一致性**：承认 SQLite 事务无法覆盖文件系统写入，通过 staging/finalize + orphan cleanup 管理不一致窗口，而不是假装两者天然原子。

---

## 二、Operational Constraints（运行约束）

### track() 的写入时机

track() 必须在 Turn 开始前完成（先于任何文件变更和后续消息追加）。这是崩溃安全的基础：如果 track() 未完成就开始执行工具，崩溃后无法识别该 Turn 的文件变更，也无法知道消息应回滚到哪个 cursor。

track() 的 DB 写入延迟应在 SQLite 典型写入范围内，不应成为 Turn 启动的瓶颈。

### capture() 的 diff 计算开销

capture() 包含文件差异计算，开销取决于工作区大小和变更文件数量。对于典型的单次 Turn（修改几个文件），diff 计算应在毫秒级完成。

对于大型工作区（数千文件），DiffEngine 应优先使用 git status 等机制缩小扫描范围。MVP 可以接受完整 diff 的性能退化，但不应把全量工作区镜像写入 artifact。

### artifact 文件大小

单个 patch artifact 是一次 Turn 的文件 diff，不是整个工作区镜像。典型大小在 KB 到 MB 级别。如果单次 Turn 产生异常大的 diff（如批量生成文件），artifact 仍应完整写入，不做截断。

### 崩溃恢复

进程崩溃后：
- 已写入 DB 的 checkpoint 保留（审计链完整）
- staging 中未 finalize 的 artifact 由 orphan cleanup 清理
- 无对应 patch 的 checkpoint 标记为"Turn 未完成"

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

- **Turn 在没有 checkpoint 的情况下执行**：track() 失败后 Turn 继续执行，导致崩溃后审计链和 message rollback 定位断裂，不可接受
- **restore 在有并发写入时强行执行**：可能导致文件损坏，不可接受
- **artifact 不可用时 restore 静默跳过**：用户以为恢复成功但实际未完全恢复，不可接受
- **message cursor 不可用却声称消息已回滚**：不可接受；应明确返回消息回滚不可用或交给上层降级处理

### 可接受的失败

- **artifact 写入失败**：patch 元数据仍记录（fileCount > 0，artifactPath = null），审计链保留，恢复能力降级但不丢失历史
- **orphan artifact 未及时清理**：浪费磁盘但不影响功能，后台 cleanup 最终处理
- **diff 计算在极大工作区下较慢**：可接受的性能降级，不影响正确性

### 可观测性

- track() / capture() 应记录结构化日志（checkpointId、sessionId、fileCount、耗时）
- restore() / revert() 应记录日志（checkpointId、回滚 patch 数量、是否成功、是否返回 message cursor）
- ArtifactNotAvailableError 应记录 warn 级日志（patchId、checkpointId）
- orphan cleanup 执行时应记录清理的文件数量
- 崩溃恢复时发现的"未完成 Turn"（有 checkpoint 无 patch）应记录 warn 级日志

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 当前不追求：增量 diff 优化

DiffEngine 当前对每次 capture() 做完整 diff 计算。未来可引入 file watcher 或 inotify 做增量变更追踪，减少 diff 计算开销。当前阶段工作区规模可控，完整 diff 的开销可接受。

### 当前不追求：artifact 压缩

patch artifact 以原始 unified diff 文本存储，不做压缩。未来如果 artifact 累积导致磁盘压力，可引入 gzip 压缩。当前阶段 artifact 大小可控。

### 当前不追求：跨 session 的 checkpoint 共享

每个 session 的 checkpoint 独立，不支持跨 session 的 diff 或 restore。跨 session 场景（如 fork session）是未来需求。

### 当前不追求：restore 的显式写锁

restore 前的并发检查依赖上层通过 run-manager / tasks 确认无 active Run / workspace-rw Task。当前阶段不引入 SandboxLease exclusive 模式，因为 sandbox 在 personal agent 或 host-local 场景中可能没有启动，不能成为 restore/revert 的硬依赖。

### 当前不追求：实时 diff 推送

diff 结果通过主动查询获取（pull），不通过 stream-bridge 实时推送。未来 UI 如需实时展示 Turn 变更，可在 capture() 完成后发布 Bus 事件，由 stream-bridge 转发。
