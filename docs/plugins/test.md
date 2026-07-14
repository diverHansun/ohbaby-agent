# plugins 模块 test.md

本文档说明如何验证 `plugins` 模块的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- ManifestLoader：plugin.json 的读取与字段校验（name kebab-case、必填字段、路径字段格式）
- ContributionBuilder：默认目录约定发现、路径变量替换（`${user_config.*}`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`）、路径越界检测（`../` 逃逸）
- enable() 原子不变量：Dispatcher 全部目标成功才持久化 `enabled`；任一目标失败不写 enabled
- Dispatcher 分发顺序（skills → agents → hooks → mcp → monitors）及 best-effort rollback 序列
- Registry 状态机：installed → enabled → disabled 的合法转换；非法转换的拒绝
- inspect() 只读语义：不修改 Registry、不触发 Dispatcher
- reload() 局部失败：单个插件 dispatch 失败不阻塞其余插件的重新注册
- SourceResolver：本地路径解析和 InstalledCacheSource 路径构造
- PluginRiskSummary：高危能力分类输出（hooks/bin/mcp-stdio=high）

**不覆盖**：
- skill 模块对 PluginSkillContribution 的业务解析（skill 模块职责）
- agent 运行时行为（agents 模块职责）
- hook 触发时序（runtime/hooks 模块职责）
- MCP 连接建立（mcp 模块职责）
- settings.json 文件 I/O（config/plugins 模块职责）
- 孤儿 cache 目录的物理删除（定时任务，集成测试外）
- CLI/TUI 的风险确认交互（backend commands 和 ohbaby-cli 职责）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：ManifestLoader 校验

| 场景 | 预期结果 |
|------|---------|
| plugin.json 缺失，manifest 目录存在 `.claude-plugin/` | 使用默认目录约定，返回推断 manifest，不报错 |
| plugin.json 存在，name 为 `MyPlugin`（非 kebab-case）| 抛出 `ManifestValidationError`，明确字段名和违反原因 |
| plugin.json 存在，name 为 `my-plugin`，version 缺失 | `version` 保持 undefined；若进入 cache 安装路径，由 Installer 使用 git SHA 或内容哈希生成版本目录标识 |
| plugin.json 中 skills 路径为 `"../../etc/passwd"` | 抛出 `PluginPathEscapeError`，不进入 ContributionBuilder |
| userConfig 声明 sensitive 字段 | 正常解析，`sensitive: true` 保留在 schema 中，不报错 |

### 场景组 2：ContributionBuilder — 路径越界检测

| 场景 | 预期结果 |
|------|---------|
| manifest.skills = `"skills/"`，在 pluginRoot 内 | 正常构建 PluginSkillContribution，解析后的 skillDir 绝对路径正确 |
| manifest.skills = `"../outside/skills/"`，逃逸 pluginRoot | 抛出 `PluginPathEscapeError`，终止构建，不分发任何 contribution |
| manifest 中某可选组件目录在 pluginRoot 内但实际不存在 | 跳过该组件，记录 warning，其余组件正常构建 |
| 所有可选组件目录均不存在 | 返回空 PluginContribution（无 skills/agents 等），记录 warning，不报错 |

### 场景组 3：ContributionBuilder — 路径变量替换

| 场景 | 预期结果 |
|------|---------|
| hooks.json 中包含 `${CLAUDE_PLUGIN_ROOT}/bin/hook.sh` | 替换为实际 pluginRoot 绝对路径 |
| hooks.json 中包含 `${user_config.api_key}` | 替换为 userConfig 对应值 |
| hooks.json 中包含未声明的 `${user_config.unknown}` | 替换为空字符串，记录 warning |
| 替换后路径包含 `../` 逃逸（注入攻击） | 抛出 `PluginPathEscapeError` |

### 场景组 4：enable() 原子不变量

| 场景 | 预期结果 |
|------|---------|
| Dispatcher 全部目标成功 | Registry 写入 `enabled`；listEnabled() 包含该插件 |
| Dispatcher 第一个目标（skills）失败 | 不写 `enabled`；listEnabled() 不含该插件；已成功目标无（无需 rollback）|
| Dispatcher 第三个目标（hooks）失败，前两个（skills、agents）已成功 | 不写 `enabled`；rollback 调用 skills.deregisterPlugin + agents.deregisterPlugin |
| rollback 期间 skills.deregisterPlugin 也失败 | 记录结构化错误日志，继续 rollback 其余目标，不抛第二层异常；Registry 最终状态 `installed` |
| enable() 正常完成后再次 enable() 同一插件 | 幂等，不重复分发，直接返回成功 |

### 场景组 5：Dispatcher 分发顺序

| 场景 | 预期结果 |
|------|---------|
| contribution 包含 skills + hooks + mcp | 分发顺序严格为 skills → agents → hooks → mcp → monitors |
| 第二个目标（agents）失败 | rollback 仅对已完成的第一个目标（skills）调用 deregisterPlugin，不对 hooks/mcp 调用 |
| contribution 中 agents 为空 | 跳过 agents target 调用，不记录错误 |

### 场景组 6：disable() 与 Registry 状态

| 场景 | 预期结果 |
|------|---------|
| disable() 已 enabled 的插件 | deregisterPlugin 调用各 target；Registry 写入 `disabled` |
| disable() 已 disabled 的插件 | 幂等，直接返回成功，不重复调用 deregisterPlugin |
| disable() 未 installed 的 pluginId | 返回 `NotFoundError` |

### 场景组 7：inspect() 只读语义

| 场景 | 预期结果 |
|------|---------|
| inspect() 合法本地路径插件 | 返回 PluginInspection（manifest + contribution preview + riskSummary），不修改 Registry |
| inspect() 执行前后 listInstalled() | 结果不变（inspect 不创建 InstallRecord）|
| inspect() 路径越界插件 | 抛出 `PluginPathEscapeError`；不返回 PluginInspection，不产生任何写操作 |

### 场景组 8：reload()

| 场景 | 预期结果 |
|------|---------|
| reload() 两个 enabled 插件，全部成功 | loaded=2，failed=0；各 target 被重新注册 |
| reload() 第二个插件 dispatch 失败 | loaded=1，failed=1；失败插件记录错误；第一个插件正常注册 |
| reload() 期间某插件 manifest 已被删除 | 该插件 loaded 失败，记录 ManifestNotFoundError；其余正常 |

---

## 三、Integration Points（集成点测试）

### 集成点 1：PluginManager + 临时文件系统（集成测试）

**验证重点**：LocalPath install() 直接记录原始 pluginRoot；cache source install() 将插件复制到 `~/.ohbaby/plugins/cache/<name>/<version>/`；enable() 后 ContributionBuilder 能从真实目录扫描到组件；uninstall() 后 cache 目录标记为孤儿

**方式**：使用 OS tmp 目录创建 fixture 插件目录（含 plugin.json + skills/ + hooks.json）；stub PluginDispatchTargets（记录调用）；分别断言 LocalPath 原始目录引用、cache 路径结构和 Registry 最终状态

**关注**：版本目录结构正确（`<name>/<version>/`），不原地覆盖

### 集成点 2：PluginManager + mock PluginDispatchTargets — enable() 原子性（集成测试）

**验证重点**：Dispatcher 全部成功 → Registry.enabled；第 N 个 target 失败 → Registry.installed + 前 N-1 个 target 收到 deregisterPlugin

**方式**：构造可配置失败的 fake PluginDispatchTargets，记录所有调用顺序和参数；assert Registry 状态；assert rollback 调用集合

**关注**：rollback 的调用集合必须精确（只对已成功的 target 调用，且顺序是注册顺序的逆序）

### 集成点 3：ContributionBuilder + 真实文件系统（单元/集成均可）

**验证重点**：路径越界检测在解析为绝对路径后才判断（防止 `skills/../outside` 绕过字符串检测）；变量替换在越界检测之前完成，防止替换后产生越界路径

**方式**：在 tmp 目录创建带 `../` 路径的 manifest fixture；assert 抛出 PluginPathEscapeError；不需要 mock（直接调用 ContributionBuilder）

### 集成点 4：Registry + config/plugins（单元测试）

**验证重点**：enable() 写 enabled 只在 Dispatcher 全部成功后触发；disable() 写 disabled 后 listEnabled() 不再包含该插件

**方式**：fake config/plugins 的 read/write（in-memory store）；断言写入时机（在 Dispatcher 最后一个 target 成功之后，不在之前）

---

## 四、Verification Strategy（验证策略）

### 主策略：单元测试 + 关键路径集成测试

**单元测试覆盖**（mock 所有直接依赖）：
- ManifestLoader 的字段校验和 kebab-case 验证
- ContributionBuilder 的路径变量替换逻辑（fake filesystem）
- Dispatcher 分发顺序和 rollback 序列（fake PluginDispatchTargets）
- Registry 状态机的合法/非法转换
- PluginRiskSummary 的能力分类

**Mock 范围**（unit 层）：

| 依赖 | Mock 方式 |
|------|---------|
| `config/plugins` read/write | fake in-memory store，记录调用顺序 |
| `PluginDispatchTargets` 各 target | fake，可配置成功/失败/延迟，记录所有调用 |
| 文件系统（ContributionBuilder） | 使用 tmp 目录 fixture，不 mock fs（路径检测必须走真实 path.resolve）|

**集成测试覆盖**（不 mock 文件系统）：
- install() → enable() 完整路径：fixture 插件目录 → cache 复制 → 组件发现 → Dispatcher 调用
- enable() 原子性：配置第 N 个 target 失败，验证 Registry 状态 + rollback 调用集
- reload() 局部失败：两个插件中一个 manifest 损坏，验证另一个正常注册

### 关注点：enable() 写入时机的精确验证

enable() 的原子性测试不能只验证最终状态，必须验证**写入时机**：在 Dispatcher 最后一个 target 的 `register*` 返回成功之后，config/plugins 的 write 才被调用。使用 fake PluginDispatchTargets + 调用顺序记录（序列号或 call log array）断言顺序。

### 关注点：路径越界的绝对路径解析

路径越界测试必须覆盖 `path.resolve()` 后再判断的场景，不能只用字符串匹配 `../`。用 `"skills/../../../etc"` 构造 fixture，确保字符串层面无 `../` 但解析后逃逸的情况被正确检测。

### 关注点：rollback 调用集的精确性

rollback 测试必须断言两点：（1）只对**已成功**的 target 调用 deregisterPlugin（失败和未执行的不调用）；（2）rollback 本身失败时不抛出，但记录的结构化日志包含 pluginId、target 名称、rollback 失败原因。
