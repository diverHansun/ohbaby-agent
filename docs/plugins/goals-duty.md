# plugins 模块 goals-duty.md

本文档定义 `plugins` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：plugins 模块是 ohbaby-agent 的插件包生命周期管理器——读取 manifest、解析插件来源、安装到本地 cache、管理启用状态、发现并分发插件组件到对应子系统，为 CLI/TUI/SDK 提供统一的插件管理 API。

**如果没有这个模块**：
- CLI、TUI、daemon、SDK 各自实现 install/enable/cache/manifest 逻辑，产生大量重复代码
- skill/agents/hooks/mcp 子模块无法统一加载来自外部插件包的扩展配置
- 插件包结构无处规范，与 Anthropic plugin 生态不兼容
- 用户安装插件后无法获得风险提示，信任边界不清晰

---

## 二、Design Goals（设计目标）

### G1: 兼容 Anthropic plugin 包结构

沿用 `.claude-plugin/plugin.json` 规范和插件目录布局，使 ohbaby-agent 能够直接消费 Claude Code 生态的插件包。manifest 字段（name、version、skills、agents、hooks、mcpServers、lspServers、monitors、bin、userConfig 等）对齐 Anthropic 规范，保留向前兼容空间。

### G2: 插件包管理与能力执行解耦

plugins 模块只负责"拆包 + 发现 + 分发"，不解释任何能力的业务语义。skill 的内容由 skill 模块解释，agent 的运行由 agents 模块负责，hook 的触发由 runtime/hooks 负责，MCP 连接由 mcp 模块管理。plugins 是配送层，不是执行层。

### G3: 为调用方提供统一生命周期 API

CLI/TUI/daemon/SDK 调用同一套 API 完成插件的 install / enable / disable / reload / uninstall，不各自重复实现。API 是同步的状态管理接口，不含 TUI 交互或 CLI 命令解析。

### G4: 本地优先，保留 marketplace 扩展空间

MVP 只支持本地 plugin 目录（`--plugin-dir` 等价）和安装 cache，不做远程 marketplace 拉取和自动更新。goals-duty 明确 marketplace 概念边界，数据模型为 Phase 2 预留扩展点，但 MVP 实现不承担网络、缓存同步、版本解析等复杂度。

### G5: trust-on-install + 能力声明管理插件风险

插件以用户权限执行，不通过 sandbox 隔离其本体。plugins 模块在 enable 前输出风险摘要（声明高危能力：hooks/bin/mcp/monitors），由上层（CLI/TUI）决定是否提示用户确认。具体权限审批仍由 policy/permission 模块负责。

---

## 三、Duties（职责）

### D1: 解析并校验 plugin manifest

读取 `.claude-plugin/plugin.json`，校验 name（kebab-case 必填）、version、组件路径配置及 userConfig schema。manifest 缺失时依据默认目录约定自动发现组件。

### D2: 解析插件来源和安装 scope

支持本地路径（`--plugin-dir` 等价）作为 plugin source；识别安装 scope（user / project / local），对应写入不同的 settings 文件。

### D3: 安装插件到 cache，管理版本目录

对 marketplace / 远程来源（Phase 2）将插件复制到 `~/.ohbaby-agent/plugins/cache/<name>/<version>/` 并维护版本目录；对 `--plugin-dir` 本地开发模式直接引用原始目录，不复制到 cache。孤儿版本在下一次 reload 时标记、7 天后清理。

### D4: 管理 installed / enabled / disabled 状态

维护插件状态持久化（settings.json），提供 `enable(id, scope)` / `disable(id)` / `uninstall(id)` 接口。状态迁移由 PluginManager 在对应生命周期流程内完成；`reload()` 只用于重新扫描已启用插件并刷新各子系统注册，不要求调用方在每次状态变更后手动补一次 reload。

### D5: 发现插件组件，生成 PluginContribution

扫描已启用插件的目录，按默认路径约定（`skills/`、`agents/`、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`monitors/`、`bin/`、`themes/`、`output-styles/`）发现各类组件，生成 `PluginContribution` 数据结构。

### D6: 将 contribution 注册到对应子系统

把各类组件 contribution 推送给目标模块：
- skills / commands → skill 模块
- agents → agents 模块
- hooks configuration → runtime/hooks 模块
- mcp server configuration → mcp 模块
- lsp server configuration → lsp 模块（如有）
- monitors → runtime 监控层
- bin → shell/runtime 的 PATH 扩展声明

plugins 只传递配置，不启动连接或执行。

### D7: 管理 userConfig 和路径变量

在 enable 时读取 `userConfig` 声明的配置项。MVP 阶段只支持非敏感字段写入 `settings.json`，`sensitive: true` 字段保留声明并标记为 pending，keychain / credentials store 属于 Phase 2。ContributionBuilder 向下游 contribution 提供 `${user_config.*}` 变量替换，并注入 `CLAUDE_PLUGIN_ROOT`（安装目录）和 `CLAUDE_PLUGIN_DATA`（持久化目录）两个路径变量。

### D8: 输出风险摘要和加载错误

在 enable 前输出插件声明的高危能力（hooks / bin / mcp stdio / remote mcp / monitors）列表，供上层决策是否提示用户。加载失败时输出结构化错误，区分 manifest 解析错误、组件路径不存在、scope 权限不足等类型。

### D9: 支持 reload

提供 `reload()` 接口，重新扫描已启用插件、刷新 PluginContribution 并重新注册到各子系统，对应 `/reload-plugins` 场景。

---

## 四、Non-Duties（非职责）

### N1: 不执行插件声明的能力

skill / agent / hook / MCP 的实际执行由各自模块负责。plugins 只分发配置，不驱动任何能力的运行。

### N2: 不替代子系统模块

不解析 SKILL.md 的业务语义（skill 模块职责），不定义 agent 的运行参数（agents 模块职责），不建立 MCP 连接（mcp 模块职责），不触发 hook 回调（runtime/hooks 职责）。

### N3: 不做权限审批

是否允许某个工具调用、是否需要用户确认，由 policy / permission 模块负责。plugins 只声明能力列表和风险等级。

### N4: 不用 sandbox 约束插件本体

插件采用 trust-on-install 模型，安装后以用户权限运行，不通过 sandbox 隔离插件目录。sandbox 是 session/workspace 隔离层，不是插件信任边界。

### N5: MVP 不做远程 marketplace 同步

GitHub 拉取、marketplace.json 同步、自动更新、插件版本订阅属于 Phase 2。MVP 的 plugin source 只支持本地路径。

### N6: MVP 不做跨插件依赖求解

插件依赖（`dependencies` 字段）的解析、自动安装、版本约束属于 Phase 2。

### N7: MVP 不做插件签名验证

内容校验和签名验证属于 Phase 2 的安全加固。

### N8: 不负责 TUI 交互和 Slash 命令解析

`/plugin install xxx` 的 slash 词法解析由 `ohbaby-sdk` 负责，命令目录和执行入口由 backend `commands` 模块负责，TUI 确认弹窗和进度显示由 `ohbaby-cli` 负责。plugins 模块只提供 `install(source, scope)` 等无 UI 的 API。

---

## 五、设计约束与假设

### 约束

1. **manifest 规范**：遵循 `.claude-plugin/plugin.json` Anthropic 规范，name 为 kebab-case
2. **路径隔离**：组件路径不得越出 plugin root（禁止 `../` 路径逃逸）
3. **cache 版本化**：每个已安装版本为独立目录，不在原地修改
4. **bin/ PATH 注入**：bin 目录的 PATH 扩展由 shell/runtime 模块执行，plugins 只声明

### 假设

1. skill 模块提供批量注册来自插件的 skill 入口
2. agents 模块提供注册外部 agent 定义的接口
3. runtime/hooks 模块接受来自插件的 hook 配置注册
4. mcp 模块接受插件级别的 mcpServer 配置注入

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| skill | 依赖（注册方向） | 将 skill/command 组件 contribution 推送至 skill 模块 |
| agents | 依赖（注册方向） | 将 agent 组件 contribution 推送至 agents 模块 |
| runtime/hooks | 依赖（注册方向） | 将 hook 配置推送至 runtime/hooks 模块注册 |
| mcp | 依赖（注册方向） | 将 mcpServer 配置推送至 mcp 模块 |
| commands | 被依赖 | backend 命令调用 plugins 的 install/enable/disable/reload API |
| ohbaby-cli | 间接 | TUI 通过 SDK/commands 触发插件命令，UI 层自行处理交互 |
| policy / permission | 无直接依赖 | plugins 只声明能力风险，审批由 policy/permission 完成 |
| config | 依赖 | 读取 user/project settings 文件路径和 scope 配置 |
| bus | 依赖（可选） | enable/disable/reload 时发布状态变更事件 |

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] design goals 服务于解耦、一致性、本地优先三个核心原则
