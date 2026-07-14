# 1. 问题基线与当前实施状态

> 时间口径：2026-07-14，仓库 `ohbaby-agent` 主工作区只读勘测（规划时尚未改代码）。

---

## 1.1 问题陈述

1. **用户可见根分裂**：配置在 `.ohbaby-agent/`，daemon / skill-output 在 `.ohbaby/`，用户与文档无法用一个心智模型描述「东西在哪」。
2. **实现与文档不一致**：`docs/project/architecture.md` §8.1 写 XDG `~/.config/ohbaby-agent/`，运行时配置却是 `~/.ohbaby-agent/`。
3. **同一概念双路径**：system-prompt custom instructions 读 `~/.ohbaby-agent/OHBABY.md`；memory 模块读 XDG/`APPDATA` 下 `ohbaby-agent/OHBABY.md`。
4. **路径常量偶然复杂度**：`OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent"` 在多个 loader 中重复定义；数据根 `APP_DIR_NAME = "ohbaby-agent"` 又在 database / storage / snapshot 各写一遍。
5. **Windows 数据目录不当**：DB/storage 落在 `APPDATA`（Roaming），大体积运行态更适合 `LOCALAPPDATA`。

---

## 1.2 已确认的产品/技术分界

（引用 00）

```
用户可见：仅 .ohbaby/
用户不可见：平台数据根 ohbaby/
废弃：.ohbaby-agent/（配置）与数据目录名 ohbaby-agent
```

---

## 1.3 配置加载子系统（config + env + custom instructions）

### 1.3.1 goals-duty

负责从「全局 home + 项目根」加载 model / mcp / skills / agents / search / `.env` / 自定义指令。职责正确，但**根目录名未单一化**。

### 1.3.2 architecture

| 资源 | 当前路径 | 锚点 |
|------|----------|------|
| 常量 | `OHBABY_CONFIG_DIR_NAME = ".ohbaby-agent"` | `packages/ohbaby-agent/src/utils/project-env.ts` |
| 同常量重复 | mcp / skill / agents / search loaders 各自 export | `config/mcp/loaders.ts` 等 |
| model | `~/.ohbaby-agent/model.json` | `config/llm/loaders.ts`（私有 `CONFIG_DIR_NAME`） |
| `.env` | `~/.ohbaby-agent/.env`；项目 `<root>/.env` | `project-env.ts` |
| MCP | `~/.ohbaby-agent/mcp/settings.json` + 项目同构 | `config/mcp/loaders.ts` |
| Skills | `skill/` + `skills/` + `skills/settings.json` | `config/skill/loaders.ts` |
| Agents | `agents/settings.json` | `config/agents/loaders.ts` |
| Search meta | `tools/search.json` | `config/tools/search/loaders.ts` |
| Custom instructions | `~/.ohbaby-agent/OHBABY.md`（及 AGENTS/CLAUDE fallback） | `core/system-prompt/services/custom-instruction-loader.ts` |

无统一 `getOhbabyConfigRoot()`；`utils/paths.ts` 只做规范化，不定义根。

### 1.3.3 data-model

配置文件仍是既有 JSON schema；本议题不改 schema，只改**落盘根路径**。

### 1.3.4 dfd-interface

MCP → system-prompt：`loadMcpConfig` → `McpManager` → `generateMcpToolMenuPrompt`。配置根错误会直接导致 MCP 菜单空/旧。

### 1.3.5 use-case

`/connect`、`/connect-search`、首次写 model/api-key 均写入全局 `.ohbaby-agent` 路径；UI 截断标记硬编码 `.ohbaby-agent/`（`packages/ohbaby-cli/src/tui/components/dialog/connect-search-panel.tsx`）。

### 1.3.6 non-functional

测试通过注入 `homeDirectory` / 临时目录隔离；大量单测硬编码 `.ohbaby-agent` 字符串。

### 1.3.7 test

覆盖路径拼接与 loader 行为；**无**跨根迁移测试；**无** Memory 与 custom-instructions 同文件一致性测试。

---

## 1.4 Daemon 与工作区运行态

### 1.4.1 architecture

| 资源 | 当前路径 | 锚点 |
|------|----------|------|
| 全局 daemon | `~/.ohbaby/server/{daemon.pid,daemon-state.json}` | `packages/ohbaby-server/src/runtime/daemon/scope.ts` |
| Legacy 每项目 | `<scopeRoot>/.ohbaby/server/...` | 同上；`main.ts` 启动拒绝 live legacy |
| Skill output | `<workspace>/.ohbaby/skill-output/<skill>/` | `packages/ohbaby-agent/src/skill/tool.ts` |
| 编辑临时文件 | 目标旁 `.ohbaby-tmp-*` | `tools/utils/text-files.ts`（前缀名，非目录根） |

Daemon **已经**使用目标品牌根 `.ohbaby`；问题是配置未跟进。

### 1.4.2 test

`scope.unit.test.ts`、`main.unit.test.ts` 覆盖 global vs legacy；迁移配置根时需避免破坏 daemon 路径契约。

---

## 1.5 运行时数据层（DB / storage / snapshot / memory）

### 1.5.1 architecture

| 模块 | `APP_DIR_NAME` / 等价 | 默认根逻辑 | 锚点 |
|------|----------------------|------------|------|
| Database | `ohbaby-agent`；文件 `ohbaby-agent.db` | XDG_DATA / macOS Application Support / Win **APPDATA** | `services/database/path.ts` |
| Storage | `ohbaby-agent` + `storage/` | 同上；`OHBABY_STORAGE_ROOT` | `services/storage/path-resolver.ts` |
| Snapshot | `ohbaby-agent` + `snapshot-git/` | 同上；可借 `OHBABY_STORAGE_ROOT` parent | `snapshot/diff-engine.ts` |
| Memory 全局文件 | `CONFIG_DIR_NAME = "ohbaby-agent"` | Win: `APPDATA`；否则 `XDG_CONFIG_HOME` 或 `~/.config` | `core/memory/constants.ts` + `memory-discovery.ts` |

三套 `default*Dir` 逻辑复制粘贴；Windows 用 Roaming。

### 1.5.2 文档 vs 实现

| 文档说 | 代码做 | Gap |
|--------|--------|-----|
| architecture §8.1：配置在 `~/.config/ohbaby-agent/` | 配置在 `~/.ohbaby-agent/` | 文档过时 |
| architecture：数据在 `~/.local/share/ohbaby-agent/` | 基本一致（Linux）；macOS/Win 用平台目录 | 名将改为 `ohbaby` |
| README：`~/.ohbaby-agent/.env` | 一致 | 需随迁移更新 |

---

## 1.6 跨模块一致性

| 问题 | 模块 A | 模块 B | 影响 |
|------|--------|--------|------|
| OHBABY.md 双源 | custom-instruction-loader | memory-discovery | 用户改一处另一处看不见 |
| 配置根 vs daemon 根 | config loaders | daemon scope | 用户以为「都在 .ohbaby」实际配置在别处 |
| 数据 app id 重复 | database / storage / snapshot | — | 改名易漏改 |

---

## 1.7 改动影响面（现状视角）

必改生产代码簇：

- `packages/ohbaby-agent/src/utils/project-env.ts`
- `packages/ohbaby-agent/src/config/**/loaders.ts`（llm/mcp/skill/agents/search）
- `packages/ohbaby-agent/src/core/system-prompt/services/custom-instruction-loader.ts`
- `packages/ohbaby-agent/src/core/memory/{constants,memory-discovery}.ts`
- `packages/ohbaby-agent/src/services/database/path.ts`
- `packages/ohbaby-agent/src/services/storage/path-resolver.ts`
- `packages/ohbaby-agent/src/snapshot/diff-engine.ts`
- `packages/ohbaby-cli` UI 路径展示
- 新增：统一 path + migration 模块
- 大量 `*.unit.test.ts` / contract / integration 中的路径字符串
- README、`docs/config/**`、`docs/project/architecture.md` 等文档

Daemon `scope.ts`：**保留** `~/.ohbaby/server`，一般无需改路径字符串；仅确认与新 config 根同品牌。

---

## 1.8 SWE 原则审视摘要

- **偶然复杂度**（philosophy）：三套根 + 重复常量，非问题域固有。
- **一致性即可读性**：同产品多根名违反「代码为人而写」。
- **信息隐藏**：调用方不应各自知道目录字符串；应经单一 path 门面。
- **YAGNI**：不做完整 XDG 四分离或企业 ProgramData（00 已否决/延后）；迁移学 Kimi 的 detect→migrate→marker，但保持模块小。

---

## 1.9 与既有文档关系

| 文档 | 关系 |
|------|------|
| `docs/project/architecture.md` §8.1 | 将被本议题目标布局 supersede |
| `docs/ohbaby-server/hono-app/04-multi-project-runtime.md` | daemon 路径已正确，保持 |
| `docs/config/**`、`docs/mcp/**`、`docs/skill/**` | 路径字符串批量更新 |
| 插件设计稿中的 `~/.ohbaby-agent/plugins/...` | 改为 `~/.ohbaby/plugins/...`（实现时） |
