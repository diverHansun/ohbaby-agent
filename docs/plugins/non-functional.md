# plugins 模块 non-functional.md

本文档定义 `plugins` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，约束冲突时以此为准：

1. **enable 的状态一致性（首要）**：settings.json 中显示 `enabled` 的插件，其 contribution 必须已全部注册到各子系统。系统中不允许存在半成功状态——Dispatcher 全部目标成功才能持久化 `enabled`，否则回滚。这是 plugins 模块最核心的不变量，实现中不允许存在 "mark-then-dispatch" 的顺序错误。

2. **路径安全边界完整性（次要）**：插件声明的所有组件路径必须在 plugin root 内部，不允许路径逃逸。此检查必须在 enable/inspect 的早期阶段完成，不能在 Dispatcher 分发到子系统后才发现越界。

3. **Dispatcher 失败语义明确（次要）**：enable 失败时，调用方必须能区分哪个目标（skill / mcp / hooks …）失败、失败原因是什么，而不是得到一个不透明的错误。rollback 失败时必须有结构化日志，不能静默丢失。

4. **实现简单性优先于吞吐**：plugins 不在高频请求路径上（用户手动 install/enable，非每次 LLM 调用都触发），优先选择实现清晰的方案，不追求极致延迟。

---

## 二、Operational Constraints（运行约束）

### enable() 关键路径时延

enable() 的主路径是：读 InstallRecord → 重新读取 manifest → 扫描组件目录 → 替换路径变量 → 调用各 target 注册接口。其中文件系统扫描（ContributionBuilder）是唯一的 I/O 密集操作。

- 组件目录扫描应逐插件串行完成，不并行（保持顺序确定性）
- 各 target 的 `register*` 调用按固定顺序串行执行（skills → agents → hooks → mcp → monitors），便于失败定位和回滚
- enable() 不应因单个大型插件的 manifest 解析而阻塞其他插件的 disable/reload

### rollback 语义

enable() 中途失败时的 rollback 是 **best-effort**：

- 对已成功注册的 target 调用 `deregisterPlugin(pluginId)`
- 若 rollback 本身也失败，记录结构化错误日志后继续处理其他 target，不抛出第二层异常
- rollback 完成后，Registry 状态保持 `installed`（不写 `enabled`），不允许写入部分状态
- best-effort 意味着极端情况下子系统状态可能不干净，但 settings.json 一定不会显示 enabled

### cache 版本隔离

- 每次 marketplace install 创建新版本子目录，不原地覆盖旧版本
- 旧版本目录在新版本就绪后标记为孤儿，**7 天后物理删除**（宽限期允许持有旧路径的 session 正常退出）
- 孤儿清理是 best-effort 后台操作，清理失败不影响新版本插件的 enable

### 路径越界检测

- ContributionBuilder 在构建 PluginContribution 前，必须验证 manifest 中所有路径在解析为绝对路径后仍在 `pluginRoot` 内。不能只做字符串层面的 `../` 检查，也不能允许 manifest 路径声明为任意绝对路径
- 检测失败立即抛出 `PluginPathEscapeError`，终止 enable/inspect 流程，不分发任何 contribution

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

| 场景 | 原因 |
|------|------|
| settings.json 显示 `enabled` 但某子系统未注册该插件 | 违反状态一致性不变量，调用方无法信任 listEnabled() 结果 |
| 路径越界检测被跳过，插件访问 plugin root 外部文件 | 安全边界突破，不可接受 |
| Dispatcher 分发顺序不确定，导致 rollback 无法复现 | 使调试和测试不可靠 |

### 可接受的失败

| 场景 | 处理方式 |
|------|---------|
| manifest 中声明的某个可选组件目录不存在 | 跳过该组件，记录 warning，不中止 enable |
| `deregisterPlugin` rollback 失败 | best-effort，记录结构化错误，继续其他 rollback target |
| 孤儿 cache 目录清理失败 | 记录日志，下次触发时重试，不影响当前操作 |
| inspect() 中某个组件目录不存在 | 记录在 `warnings[]` 中，返回带警告的 PluginInspection |

### 可观测性

- **enable()**：记录 pluginId、scope、每个 target 的注册结果（成功/失败/跳过）、总耗时
- **enable 失败**：记录失败的 target 名称、错误类型、已完成 rollback 的 target 列表
- **rollback 失败**：独立日志条目，包含 pluginId、target 名称、rollback 失败原因
- **inspect()**：不记录日志（只读操作，频率可能较高）
- **reload()**：记录 loaded 数量、failed 数量及每条失败原因
- 所有日志使用结构化格式（JSON），包含 `pluginId` 字段，便于按插件过滤

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 暂缓：keychain 存储 sensitive userConfig

userConfig 中 `sensitive: true` 的字段在 MVP 阶段不写入系统 keychain，只在内存中保留占位声明。代价是敏感配置无安全存储，Phase 2 再补。这样 MVP 不需要处理 macOS Keychain / Windows Credential Manager / Linux Secret Service 的跨平台差异。

### 暂缓：remote marketplace source 的网络容错

Phase 2 引入 MarketplaceRef 时，需要处理网络超时、git clone 失败、校验和不匹配等情况。MVP 只支持本地路径，不涉及网络操作，相关错误处理暂不设计。

### 暂缓：插件签名验证

MVP 不验证插件包的签名或内容哈希。trust-on-install + capability declaration 是当前阶段的安全模型。签名验证作为 Phase 2 安全加固项，不是暂时遗忘，是刻意延后。

### 暂缓：全局插件数量和 bin/ PATH 长度限制

不对同时启用的插件数量设上限，不对 bin/ 扩展后的 PATH 长度做约束。当前阶段插件数量有限，不需要额外保护。

### 暂缓：reload() 的原子性

当前 reload() 是逐插件处理，先 deregister 后 dispatch，中间存在短暂的"组件未注册"窗口。MVP 接受这个窗口，不实现原子切换（snapshot + swap），因为 reload 是用户主动触发的操作，短暂窗口可接受。
