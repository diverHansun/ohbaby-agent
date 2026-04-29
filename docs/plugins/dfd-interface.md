# plugins 模块 dfd-interface.md

本文档描述 `plugins` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 1.1 模块位置

```
   commands / TUI / SDK
        │  (inspect / install / enable / disable / uninstall / reload)
        ▼
┌───────────────────────────────────────────────────────────────────┐
│                        PluginManager                              │
│  SourceResolver → Installer → ManifestLoader → ContributionBuilder│
│  Registry ←→ config/plugins                                       │
│  Dispatcher ──────────────────────────────────────────────────┐  │
└───────────────────────────────────────────────────────────────┼──┘
                    │ (状态事件)                                 │ (直接函数调用)
                    ▼                                           ▼
                  Bus                    skill / agents / hooks / mcp / lsp / runtime
```

### 1.2 交互模块汇总

| 模块 | 交互方向 | 接口形式 | 说明 |
|------|----------|----------|------|
| **commands** | 调用 plugins | PluginManager public API | `/plugin install` 等命令的 backend 控制器 |
| **ohbaby-tui** | 间接触发 | SDK command invocation | 插件管理 UI 面板和交互 |
| **SDK** | 间接承载 | DTO / command invocation | 程序化插件管理的协议承载 |
| **config/plugins** | plugins 调用 | loadPluginSettings / savePluginSettings | 持久化 PluginInstallRecord |
| **skill** | plugins 调用（Dispatcher） | PluginSkillTarget 窄接口 | 注册 / 注销 plugin skills |
| **agents** | plugins 调用（Dispatcher） | PluginAgentTarget 窄接口 | 注册 / 注销 plugin agents |
| **runtime/hooks** | plugins 调用（Dispatcher） | PluginHookTarget 窄接口 | 注册 / 注销 plugin hooks |
| **mcp** | plugins 调用（Dispatcher） | PluginMcpTarget 窄接口 | 注册 / 注销 plugin MCP servers |
| **Bus** | plugins 调用 | publish() | 发布 plugin 状态变更观察事件 |

---

## 二、Data Flow Description（数据流描述）

### 2.1 inspect 流（只读预览）

`inspect()` 是无副作用的只读操作，供 TUI 等调用方在执行 install/enable 前展示风险和内容摘要。

```
TUI/CLI 调用 inspect(source, scope)
    │
    ▼
SourceResolver.resolve(source)
    → PluginSource（LocalPath 或 MarketplaceRef）
    │
    ▼
ManifestLoader.load(resolvedPath)
    → PluginManifest（已校验）
    │
    ▼
ContributionBuilder.build(pluginRoot, manifest, userConfigValues={})
    → PluginContribution（组件清单，路径变量已替换；pluginData 路径只计算不创建）
    │
    ▼
security.summarizeRisks(contribution)
    → PluginRiskSummary
    │
    ▼
返回 PluginInspection {
  manifest, contribution, risk, warnings[]
}
─── 无任何写操作 ──────────────────────────────
```

### 2.2 install 流

```
CLI/TUI 调用 install(source, scope)
    │
    ▼
SourceResolver.resolve(source)
    → LocalPath → 直接使用原始路径（不复制）
    → InstalledCache → 路径已存在（幂等）
    │
    ▼
Installer.install(resolvedSource, scope)
    LocalPath 场景：    验证目录存在，跳过复制
    MarketplaceRef：    复制到 ~/.ohbaby-agent/plugins/cache/<name>/<version>/
    → pluginRoot: AbsolutePath（cache 路径或原始路径）
    │
    ▼
ManifestLoader.load(pluginRoot)
    → PluginManifest
    │
    ▼
Registry.recordInstall(manifest, pluginRoot, scope)
    → config/plugins.savePluginSettings(scope, installRecord)
    → PluginInstallRecord 写入对应 scope 的 settings.json
    │
    ▼
返回 PluginInstallResult { pluginId, pluginRoot, manifest }
Bus.publish('plugin.installed', { pluginId, scope })
```

### 2.3 enable 流（关键路径，含回滚约束）

```
CLI/TUI 调用 enable(pluginId, scope, options?)
    │
    ▼
Registry.getInstallRecord(pluginId, scope)
    → PluginInstallRecord（不存在则抛 PluginNotInstalledError）
    │
    ▼
ManifestLoader.load(record.pluginRoot)
    → PluginManifest（每次 enable 重新读取，避免缓存旧 manifest）
    │
    ▼
ContributionBuilder.build(record.pluginRoot, manifest, userConfigValues)
    - 扫描各组件目录，验证路径存在
    - 替换 ${CLAUDE_PLUGIN_ROOT} → record.pluginRoot
    - 替换 ${CLAUDE_PLUGIN_DATA} → ~/.ohbaby-agent/plugins/data/<id>/
    - 替换 ${user_config.*} → userConfigValues 中的值
    → PluginContribution
    │
    ▼
security.summarizeRisks(contribution)
    → PluginRiskSummary（附在 contribution 上）
    │
    ▼
Dispatcher.dispatch(contribution, targets)
    │  按顺序执行，任一步失败立即停止：
    ├──▶ targets.skills?.registerPluginSkills(pluginId, contribution.skills)
    ├──▶ targets.agents?.registerPluginAgents(pluginId, contribution.agents)
    ├──▶ targets.hooks?.registerPluginHooks(pluginId, contribution.hooks)
    ├──▶ targets.mcp?.registerPluginServers(pluginId, contribution.mcpServers)
    └──▶ targets.monitors?.registerPluginMonitors(pluginId, contribution.monitors)
    │
    │  全部成功：
    ▼
Registry.markEnabled(pluginId, scope)
    → config/plugins.savePluginSettings(scope, { state: 'enabled' })
    │
    ▼
返回 PluginEnableResult { pluginId, contribution, risk }
Bus.publish('plugin.enabled', { pluginId, scope })

─── 失败分支 ─────────────────────────────────────────────────────
    Dispatcher 某步失败
        → 对已成功注册的 target 执行 best-effort rollback：
          target.deregisterPlugin(pluginId)
        → Registry 状态保持 'installed'（不写 'enabled'）
        → 返回 PluginEnableError（含失败 target 和原因）
        → Bus.publish('plugin.enable-failed', { pluginId, error })
```

**关键不变量**：只有 Dispatcher 全部目标成功后，Registry 才持久化 `enabled` 状态。系统中不存在"settings.json 显示已启用但子系统未加载"的半成功状态。

### 2.4 disable 流

```
CLI/TUI 调用 disable(pluginId, scope)
    │
    ▼
Registry.getInstallRecord(pluginId, scope)
    → 验证插件已安装，当前为 enabled
    │
    ▼
Dispatcher.deregister(pluginId, targets)
    ├──▶ targets.skills?.deregisterPlugin(pluginId)
    ├──▶ targets.agents?.deregisterPlugin(pluginId)
    ├──▶ targets.hooks?.deregisterPlugin(pluginId)
    ├──▶ targets.mcp?.deregisterPlugin(pluginId)
    └──▶ targets.monitors?.deregisterPlugin(pluginId)
    │
    ▼
Registry.markDisabled(pluginId, scope)
    → config/plugins.savePluginSettings(scope, { state: 'disabled' })
    │
    ▼
返回 PluginDisableResult { pluginId }
Bus.publish('plugin.disabled', { pluginId, scope })
```

### 2.5 reload 流

```
CLI/TUI 调用 reload()
    │
    ▼
Registry.listEnabled()
    → PluginInstallRecord[]（所有 scope 中 state = 'enabled' 的记录）
    │
    ▼
for each record:
    Dispatcher.deregister(record.pluginId, targets)  ← 先清除旧注册
        │
        ▼
    ManifestLoader.load(record.pluginRoot)
        → PluginManifest
        │
        ▼
    ContributionBuilder.build(record.pluginRoot, manifest, userConfigValues)
        → PluginContribution
        │
        ▼
    Dispatcher.dispatch(contribution, targets)
        成功 → 继续下一个
        失败 → 记录错误，标记该插件 reload 失败，继续处理其他插件
    │
    ▼
返回 PluginReloadResult {
  loaded: string[]   // 成功 reload 的 pluginId 列表
  failed: Array<{ pluginId: string; error: string }>
}
Bus.publish('plugin.reloaded', { loaded, failed })
```

### 2.6 uninstall 流

```
CLI/TUI 调用 uninstall(pluginId, scope)
    │
    ▼
如果当前状态为 enabled：先执行 disable 流（2.4）
    │
    ▼
Installer.removeCache(pluginId)
    - 标记 cache 版本目录为孤儿（7 天后物理删除）
    - 如果传入 keepData=false：立即删除 pluginData 目录
    │
    ▼
Registry.removeInstallRecord(pluginId, scope)
    → config/plugins.savePluginSettings(scope, 删除该条记录)
    │
    ▼
返回 PluginUninstallResult { pluginId }
Bus.publish('plugin.uninstalled', { pluginId, scope })
```

---

## 三、Interface Definition（接口定义）

### 3.1 PluginManager 对外公共 API

```typescript
interface PluginManager {
  /**
   * 只读预览：解析 source，返回 manifest、contribution 和风险摘要。
   * 无任何写操作，供 TUI/CLI 在 install/enable 前展示信息。
   */
  inspect(source: string, scope: PluginScope): Promise<PluginInspection>

  /**
   * 安装：将插件写入 cache（或验证本地路径），记录 PluginInstallRecord。
   * 安装后插件处于 installed 状态，需要显式调用 enable() 才会激活。
   */
  install(source: string, scope: PluginScope): Promise<PluginInstallResult>

  /**
   * 激活：构建 contribution，分发给各子系统，持久化 enabled 状态。
   * 全部子系统接受成功才写入 enabled；任一失败则 rollback + 返回错误。
   */
  enable(pluginId: PluginId, scope: PluginScope, options?: EnableOptions): Promise<PluginEnableResult>

  /**
   * 停用：通知各子系统注销，持久化 disabled 状态。
   * 插件文件仍保留在 cache，可重新 enable。
   */
  disable(pluginId: PluginId, scope: PluginScope): Promise<PluginDisableResult>

  /**
   * 卸载：先 disable，再标记 cache 为孤儿，删除 installRecord。
   * keepData=true 时保留 pluginData 目录。
   */
  uninstall(pluginId: PluginId, scope: PluginScope, options?: UninstallOptions): Promise<PluginUninstallResult>

  /**
   * 重新加载全部已启用插件：先 deregister 再 dispatch。
   * 部分失败不中止整体 reload，失败项记入返回结果。
   */
  reload(): Promise<PluginReloadResult>
}

interface EnableOptions {
  /** 调用方已通过 inspect 获取并向用户展示了风险，传入 risk fingerprint 跳过重复检查 */
  acceptedRisk?: string
}

interface UninstallOptions {
  keepData?: boolean  // 是否保留 pluginData 目录，默认 false
}
```

### 3.2 inspect / enable 返回类型

```typescript
/** inspect() 的返回结果（只读，无副作用） */
interface PluginInspection {
  manifest: PluginManifest
  contribution: PluginContribution
  risk: PluginRiskSummary
  warnings: PluginWarning[]
}

/** enable() 的返回结果 */
interface PluginEnableResult {
  pluginId: PluginId
  contribution: PluginContribution
  risk: PluginRiskSummary
}

interface PluginWarning {
  code: string
  message: string
}
```

### 3.3 PluginDispatchTargets（Dispatcher 的窄接口依赖）

Dispatcher 不直接 import skill / mcp / agents 等模块的内部实现类，而依赖注入的 `PluginDispatchTargets`，每个 target 只暴露两个方法：`register*` 和 `deregisterPlugin`。

```typescript
interface PluginDispatchTargets {
  skills?: PluginSkillTarget
  agents?: PluginAgentTarget
  hooks?: PluginHookTarget
  mcp?: PluginMcpTarget
  lsp?: PluginLspTarget
  monitors?: PluginMonitorTarget
  bin?: PluginBinTarget
}

interface PluginSkillTarget {
  registerPluginSkills(pluginId: PluginId, contributions: PluginSkillContribution[]): Promise<void>
  deregisterPlugin(pluginId: PluginId): Promise<void>
}

interface PluginAgentTarget {
  registerPluginAgents(pluginId: PluginId, contributions: PluginAgentContribution[]): Promise<void>
  deregisterPlugin(pluginId: PluginId): Promise<void>
}

interface PluginHookTarget {
  registerPluginHooks(pluginId: PluginId, contribution: PluginHookContribution): Promise<void>
  deregisterPlugin(pluginId: PluginId): Promise<void>
}

interface PluginMcpTarget {
  registerPluginServers(pluginId: PluginId, contribution: PluginMcpContribution): Promise<void>
  deregisterPlugin(pluginId: PluginId): Promise<void>
}

interface PluginMonitorTarget {
  registerPluginMonitors(pluginId: PluginId, contributions: PluginMonitorContribution[]): Promise<void>
  deregisterPlugin(pluginId: PluginId): Promise<void>
}

interface PluginLspTarget {
  registerPluginLsp(pluginId: PluginId, contribution: PluginLspContribution): Promise<void>
  deregisterPlugin(pluginId: PluginId): Promise<void>
}

interface PluginBinTarget {
  registerPluginBin(pluginId: PluginId, contribution: PluginBinContribution): Promise<void>
  deregisterPlugin(pluginId: PluginId): Promise<void>
}
```

### 3.4 config/plugins 适配接口（plugins 依赖）

```typescript
/** plugins/registry 依赖的 config/plugins 接口 */
interface PluginSettingsAdapter {
  loadPluginSettings(scope: PluginScope): Promise<PluginInstallRecord[]>
  savePluginSettings(scope: PluginScope, records: PluginInstallRecord[]): Promise<void>
}
```

### 3.5 Bus 事件（观察流，不承载控制流）

| 事件名 | 发布时机 | payload |
|--------|---------|---------|
| `plugin.installed` | install 成功 | `{ pluginId, scope }` |
| `plugin.enabled` | enable 成功（Registry 写入后） | `{ pluginId, scope }` |
| `plugin.enable-failed` | enable 中 Dispatcher 失败 | `{ pluginId, error }` |
| `plugin.disabled` | disable 成功 | `{ pluginId, scope }` |
| `plugin.uninstalled` | uninstall 完成 | `{ pluginId, scope }` |
| `plugin.reloaded` | reload 完成 | `{ loaded[], failed[] }` |

**设计原则**：Bus 事件仅用于外部模块的观察（日志、TUI 状态刷新、监控），不用于跨模块的同步控制流。用户的风险确认通过 inspect() 的返回值和调用方控制流处理，不经过 Bus。

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | 持久化责任 | 销毁责任 | 当前模块的角色 |
|------|--------|-----------|---------|--------------|
| `PluginInstallRecord` | Registry（install 时） | config/plugins 负责文件读写，Registry 负责语义 | Registry（uninstall 时）通过 config/plugins 删除 | 创建者兼持有者 |
| `PluginContribution` | ContributionBuilder（每次 enable/reload 时重新构建） | 不持久化，仅内存中存活至 dispatch 完成 | Dispatcher dispatch 完成后由各目标模块各自持有组件注册，PluginContribution 对象可释放 | 生产者；交付后不再持有 |
| `PluginRiskSummary` | security（enable/inspect 时构建） | 不持久化 | 随 PluginContribution 生命周期 | 生产者；返回给调用方后不再持有 |
| `PluginUserConfigValues` | Registry（enable 时从 settings 读取） | 非敏感值由 config/plugins 持久化到 settings.json | Registry（uninstall 时删除） | 从 config/plugins 读取，传递给 ContributionBuilder |
| 各子系统的注册状态（skill list, mcp connections...） | 各子系统自身 | 各子系统负责（内存或自身 config） | 各子系统在收到 deregisterPlugin 时删除 | **不持有**；分发后由目标模块负责 |

**关键边界**：PluginContribution 分发到各子系统后，该数据的生命周期就移交给了目标模块。plugins 模块不保存各组件的运行时状态——它只维护安装记录中的 `state` 字段（installed / enabled / disabled）。若需要知道"MCP server 是否连接成功"，应查询 mcp 模块，而非 plugins 模块。

---

## 五、文档自检

- [x] 每条数据流都有明确的"从哪里来 → 经过什么处理 → 到哪里去"
- [x] enable 的关键不变量（全部成功才写 enabled）已明确
- [x] 所有接口都能在数据流中找到对应位置
- [x] Bus 事件仅用于观察流，不承载控制流或风险确认
- [x] PluginDispatchTargets 窄接口设计符合 DIP，Dispatcher 不依赖子模块内部类型
- [x] 数据归属边界清晰：plugins 持有安装记录状态，不持有运行时组件状态
