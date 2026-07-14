# plugins 模块 architecture.md

本文档描述 `plugins` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

plugins 模块是插件包的**生命周期流水线**，处于外部调用方（CLI/TUI/SDK）和内部能力子系统（skill / agents / hooks / mcp）之间。它不执行任何能力，只负责"拆包 + 发现 + 分发"。

### 核心架构

```
外部调用方（CLI / TUI / SDK）
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                       PluginManager                          │
│               （对外统一 API，薄协调层）                       │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │SourceResolver│→ │  Installer   │→ │  ManifestLoader   │  │
│  │              │  │  + Cache     │  │                   │  │
│  │解析 source   │  │安装/版本目录 │  │读取/校验          │  │
│  │类型与路径    │  │管理/孤儿清理 │  │plugin.json       │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│                                              │               │
│                          ┌───────────────────▼─────────┐    │
│                          │   ContributionBuilder        │    │
│                          │  扫描组件目录，生成           │    │
│                          │  PluginContribution 中间表示 │    │
│                          └───────────────────┬──────────┘    │
│                                              │               │
│  ┌──────────────────────┐  ┌─────────────────▼────────────┐  │
│  │       Registry       │  │         Dispatcher           │  │
│  │                      │  │                              │  │
│  │installed/enabled/    │  │将 contribution 注册到各子系统│  │
│  │disabled 状态管理     │  │                              │  │
│  │（via config/plugins）│  └──────────────────────────────┘  │
│  └──────────────────────┘            │                       │
└─────────────────────────────────────────────────────────────┘
          │                            │
          ▼                            ▼
  config/plugins           skill / agents / hooks / mcp
  credentials store
```

### 生命周期流水线

plugins 模块的内部处理严格按照以下阶段串行执行，每个阶段由独立子组件负责：

```
source（字符串）
    │
    ▼ SourceResolver
[PluginSource：LocalPath | InstalledCache | MarketplaceRef(Phase2)]
    │
    ▼ Installer + Cache
[plugin root 目录 in cache, 版本隔离]
    │
    ▼ ManifestLoader
[PluginManifest（校验后）]
    │
    ▼ ContributionBuilder
[PluginContribution（skills / agents / hooks / mcp / bin / ... 清单）]
    │
    ├─▶ Registry（状态持久化）
    │
    └─▶ Dispatcher → skill / agents / runtime/hooks / mcp / lsp / ...
```

---

## 二、核心子组件职责

### 2.1 PluginManager（Facade）

对外暴露统一 API：`inspect / install / enable / disable / uninstall / reload`。其中 `inspect` 是只读预览，用于让 CLI/TUI 展示 manifest、组件清单和风险摘要；其余 API 是写操作。PluginManager 内部协调其他子组件，不直接实现组件业务逻辑。调用方（CLI/TUI/SDK）只依赖这一个入口，不直接访问内部子组件，保证生命周期流水线的完整性。

### 2.2 SourceResolver

将调用方传入的 `source` 字符串解析为结构化的 `PluginSource`：

- **LocalPath**：本地目录或 `--plugin-dir` 路径（MVP 支持）
- **InstalledCache**：已安装的 cache 目录（reload 场景）
- **MarketplaceRef**：GitHub / Git URL / remote URL（Phase 2，结构已预留，不实现）

MVP 只实现 LocalPath 和 InstalledCache 两种类型。MarketplaceRef 的接口形状在 types.ts 中定义，但 resolve 逻辑不在 MVP 中实现。

### 2.3 Installer + Cache

- 将插件目录复制到 `~/.ohbaby/plugins/cache/<name>/<version>/`（版本目录隔离）
- 每次更新创建新版本子目录，不原地修改
- 孤儿版本（被新版本替代且无 session 持有引用的旧目录）标记后 7 天清理
- `--plugin-dir` 模式下直接引用原始路径，不做 cache 复制

### 2.4 ManifestLoader

- 读取 `.claude-plugin/plugin.json`，按 Anthropic 规范校验字段
- 保留 manifest 中的组件路径为插件根目录内的相对路径；绝对路径解析和越界检查由 ContributionBuilder 在绑定 `pluginRoot` 后完成
- manifest 缺失时，按默认路径约定（`skills/`、`agents/`、`hooks/hooks.json`、`.mcp.json` 等）自动发现组件
- 输出 `PluginManifest`（标准化的校验后数据结构），错误时输出结构化的 `PluginManifestError`

### 2.5 ContributionBuilder

- 依据 `PluginManifest` 指定的路径（或默认路径），扫描各类组件目录
- 将 `${CLAUDE_PLUGIN_ROOT}` 替换为安装目录绝对路径，`${CLAUDE_PLUGIN_DATA}` 替换为持久化目录绝对路径
- 收集 `userConfig` 已存储的值，注入 `${user_config.*}` 变量替换
- 输出 `PluginContribution`（单一插件的所有组件贡献的聚合中间表示）
- 调用 security.summarizeRisks() 生成风险摘要，附在 contribution 中，供上层决策

### 2.6 Registry

- 维护 installed / enabled / disabled 三态
- 状态持久化委托给 `config/plugins` 适配层（读写 settings.json，区分 scope）
- 暴露 `listEnabled()` / `listInstalled()` 供 PluginManager 协调使用
- 本身不理解 contribution 或组件语义，只管状态迁移

### 2.7 Dispatcher

- 接收 `PluginContribution`，按组件类型路由到对应子系统
- 每类组件对应一条注册调用：

| 组件类型 | 注册目标 |
|---------|---------|
| skills / commands | skill 模块 |
| agents | agents 模块 |
| hooks configuration | runtime/hooks 模块 |
| mcpServers | mcp 模块 |
| lspServers | lsp 模块（如有） |
| monitors | runtime 监控层 |
| bin | shell/runtime PATH 扩展声明 |

- Dispatcher 只传递配置，不建立连接，不触发执行
- reload 时先通知各子系统清除当前插件注册，再重新注册新 contribution

### 2.8 security（轻量辅助）

- `summarizeRisks(contribution)`：检测高危能力（hooks / bin / mcp stdio / monitors），生成 `PluginRiskSummary`
- 路径越界检查：确保 contribution 中所有路径不超出 plugin root
- 不做权限审批，只输出风险声明供上层使用

---

## 三、Design Patterns（设计模式与理由）

### 3.1 Facade 模式（PluginManager）

**应用场景**：统一入口，防止调用方绕过生命周期直接访问子组件。

**理由**：CLI / TUI / SDK / daemon 都需要执行 install/enable/reload。若各自直接调用 Installer 或 Registry，生命周期顺序（source → install → manifest → enable → dispatch）就会因调用方疏漏而被跳步，导致状态不一致。Facade 保证流水线不被绕过。

与 docs/mcp 的 `McpManager` 一致：外部看到单一入口，内部细分职责。

### 3.2 Pipeline（生命周期流水线）

**应用场景**：install / enable 的阶段式处理。

**理由**：插件生命周期天然是串行阶段：无法在 manifest 未验证前构建 contribution，无法在 contribution 未生成前 dispatch。明确的管道结构让每个阶段可以独立测试、独立失败，也让 Phase 2（添加 marketplace source）时只需在流水线头部插入新的 SourceResolver 分支，不影响下游。

### 3.3 Adapter 模式（ContributionBuilder + Dispatcher）

**应用场景**：将外部插件包的多样结构转换为统一的内部接口。

**理由**：插件包结构由外部厂商控制（Anthropic 规范或自定义路径），而 skill/agents/mcp 模块期望看到结构化的注册数据。ContributionBuilder 扮演结构适配器，Dispatcher 扮演分发适配器。与 docs/mcp 的 `adaptMcpTool()` 思路一致：屏蔽外部格式差异，对内提供统一接口。

### 3.4 混合持久化策略（Registry + config/plugins）

**应用场景**：installed / enabled 状态的读写。

**理由**：避免 plugins 模块直接硬编码 settings.json 路径和 JSON 解析（会和 config/agents、config/mcp 的风格不一致）。同时，config 模块不应理解 install/enable/disable 的业务语义。因此采用分工：

- `config/plugins`（新增 config 子模块）：路径解析、settings.json 读写、schema 验证、scope 合并（与 config/agents 相同角色）
- `plugins/registry`：业务语义——什么叫安装、什么叫启用、什么状态可迁移

---

## 四、Module Structure & File Layout（模块结构与文件组织）

### 4.1 目录结构

```
src/plugins/
├── index.ts              # 公共 API（仅导出 PluginManager 和核心类型）
├── manager.ts            # PluginManager facade
├── source-resolver.ts    # SourceResolver
├── installer.ts          # Installer + cache 管理
├── manifest.ts           # ManifestLoader
├── contribution.ts       # ContributionBuilder
├── registry.ts           # Registry（状态管理，依赖 config/plugins）
├── dispatcher.ts         # Dispatcher
├── security.ts           # 风险摘要、路径越界检查
├── types.ts              # 全部类型定义（PluginContribution、PluginManifest 等）
└── errors.ts             # 结构化错误类型
```

平铺文件，无嵌套子目录，与 docs/skill 的 `src/skill/` 结构一致。

### 4.2 文件职责与对外稳定性

| 文件 | 职责 | 对外稳定性 |
|------|------|------------|
| `index.ts` | 公共 API 导出 | **稳定** |
| `types.ts` | 核心类型（PluginContribution / PluginManifest 等） | **稳定** |
| `errors.ts` | 错误类型 | **稳定** |
| `manager.ts` | Facade，协调各子组件 | 内部实现 |
| `source-resolver.ts` | source 类型解析 | 内部实现 |
| `installer.ts` | 安装/cache 操作 | 内部实现 |
| `manifest.ts` | manifest 读取与校验 | 内部实现 |
| `contribution.ts` | 组件发现与 contribution 构建 | 内部实现 |
| `registry.ts` | 状态持久化（依赖 config/plugins） | 内部实现 |
| `dispatcher.ts` | contribution 分发 | 内部实现 |
| `security.ts` | 风险摘要与路径检查 | 内部实现 |

### 4.3 config/plugins 子模块（config 模块新增）

与 config/agents、config/mcp 对齐，新增：

```
src/config/plugins/
├── index.ts
├── loader.ts   # 按 scope 读取 settings.json 中的插件配置
├── writer.ts   # 按 scope 写入插件状态
└── types.ts    # PluginSettings schema
```

plugins 模块通过 config/plugins 的 API 读写持久化状态，不直接操作 settings 文件。

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 5.1 Facade 单入口 vs 平面组件直接调用

**当前选择**：Facade（PluginManager 是唯一外部入口）

**放弃的方案**：各调用方直接调用 Installer / Registry 等子组件

**代价**：所有调用方必须通过 PluginManager，不能"快捷"绕过部分阶段

**理由**：CLI/TUI/daemon/SDK 调用插件 API 时，任何一个调用方跳过某个阶段（例如 enable 前未 install）都会导致状态不一致。Facade 把顺序约束内化到一个地方，避免各调用方各自维护顺序。

### 5.2 本地安装 cache vs 直接使用原始路径

**当前选择**：`--plugin-dir` 场景直接引用原始路径；marketplace 安装场景复制到 cache

**放弃的方案**：所有场景都复制到 cache

**代价**：两种路径模式（直接引用 vs cache 复制）需在 SourceResolver 和 Installer 中区分处理

**理由**：开发者本地调试插件时不应每次复制，保留直接引用模式提升开发体验；而 marketplace 安装插件必须 cache 化以支持版本隔离和孤儿清理。

### 5.3 PluginContribution 作为中间表示 vs 直接流式分发

**当前选择**：先构建完整 PluginContribution，再统一 dispatch

**放弃的方案**：在 ContributionBuilder 扫描过程中即时向各子系统推送

**代价**：需要在内存中保存完整的 PluginContribution 结构

**理由**：先构建中间表示允许 security.summarizeRisks() 在 dispatch 前做整体风险分析，允许 reload 时原子性地替换（先清除旧 contribution 再推送新 contribution），也让 PluginContribution 成为 data-model.md 中可独立测试的稳定协议。

### 5.4 trust-on-install vs sandbox 隔离

**当前选择**：trust-on-install + capability declaration + 路径越界检查

**放弃的方案**：复用 sandbox 模块约束插件本体执行

**代价**：插件安装后以用户权限运行，安全边界依赖调用方的信任决策

**理由**：sandbox 是 session/workdir 的执行环境隔离，插件带来的 hooks/bin/mcp/monitors 在 session 生命周期之外也在运行，不属于 sandbox 管辖范围。强行通过 sandbox 管控会导致两层隔离语义混乱。trust-on-install 对齐 Anthropic 规范，能力声明 + 风险摘要给上层留出确认空间。

### 5.5 userConfig / keychain 降级为 MVP 简化版

**当前选择**：MVP 只做 manifest 中 userConfig 的声明读取和变量占位（`${user_config.*}`），不接入 keychain 存储

**放弃的方案**：第一版就实现 sensitive 字段写入系统 keychain

**代价**：sensitive 字段在 MVP 阶段无安全存储，只能标记为 pending

**理由**：keychain 集成涉及跨平台兼容性（macOS Keychain / Windows Credential Manager / Linux Secret Service），复杂度超出 MVP 范围。先实现 manifest 声明和变量替换，keychain 作为 Phase 2 加固。

---

## 六、与关键模块的集成说明

### 6.1 与 config/plugins（新增）

Registry 通过 config/plugins 的 API 读写状态，不直接操作 settings.json。config/plugins 负责路径和 schema，registry 负责状态语义。

### 6.2 与 skill 模块

Dispatcher 调用 skill 模块的批量注册接口，传入 `PluginSkillContribution[]`（PluginContribution 的 skills 字段）。这是 plugins 自己定义的 Handoff DTO，只描述 skill 目录位置和命名空间；skill 模块自行处理 SKILL.md 解析，不在 plugins 中发生。reload 时先调用 skill 模块的 deregisterPlugin(pluginId) 再重新注册。

### 6.3 与 mcp 模块

Dispatcher 调用 mcp 模块的 `registerPluginServers(pluginId, contribution)`，传入 `PluginMcpContribution`。其中 server 配置是路径变量已替换的 JSON DTO；最终 MCP server 配置 schema 校验、连接管理和工具适配仍由 config/mcp 与 mcp 模块负责，plugins 不参与。

### 6.4 与 runtime/hooks

Dispatcher 调用 runtime/hooks 的 `registerPluginHooks(pluginId, hookConfig)`，传入校验后的 hook 配置。hook 的触发和执行完全在 runtime/hooks 内部，plugins 无感知。

---

## 七、文档自检

- [x] 每个子组件存在的理由均可追溯到 goals-duty.md
- [x] 未引入 goals-duty.md 之外的新职责
- [x] 设计模式的使用有明确理由（Facade/Pipeline/Adapter）
- [x] 关键权衡已明确记录（trust-on-install、中间表示、单入口）
- [x] 与 skill / mcp / config 的集成方式清晰
- [x] 文件布局对齐 docs/skill 的平铺风格
