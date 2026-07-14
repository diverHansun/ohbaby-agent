# 2. 优化方案与改动面

> 实施契约：由后续开发会话按本文 + `04` 执行。本规划会话不写代码。

---

## 2.1 方案总览

引入**单一路径门面** + **启动时自动迁移**，使：

1. 所有用户可见配置读写落在 `.ohbaby/`
2. 所有平台数据读写落在 app id `ohbaby` 的数据根（Windows 用 LocalAppData）
3. 旧 `.ohbaby-agent` 与旧数据目录 `ohbaby-agent` 在兼容窗口内可读，写入只写新路径；启动时尽量把旧树迁到新树

```
                    ┌─────────────────────────────┐
  OHBABY_HOME ─────►│ resolveOhbabyHome()         │──► ~/.ohbaby | $OHBABY_HOME
                    │ resolveProjectOhbabyRoot()  │──► <project>/.ohbaby
                    │ resolveOhbabyDataRoot()     │──► XDG/AppSupport/LocalAppData/ohbaby
                    │ migrateOhbabyHomesIfNeeded()│──► 启动一次迁移
                    └─────────────────────────────┘
                              ▲
         config loaders / env / memory / custom-instructions / UI
         database / storage / snapshot
         daemon 已使用 ~/.ohbaby/server（保持）
```

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 用户可见根 | `.ohbaby/` | 与 daemon 已对齐；用户指定 | 继续 `.ohbaby-agent`；全面 `~/.config/ohbaby` | 需迁移既有用户配置 |
| 数据根 | 平台数据目录 + `ohbaby` | 配置轻、数据重分离；学 OpenCode 分离思想 | 数据进 `~/.ohbaby/data/` | 仍有「看不见」的第二根，需文档说明 |
| Win 配置 | `~\.ohbaby` | 与 Claude/Codex/Kimi 同构 | 配置进 AppData | — |
| Win 数据 | `%LOCALAPPDATA%\ohbaby` | 避免 Roaming 同步大库 | 继续 APPDATA | 多一次数据迁移 |
| 迁移 | 启动自动 copy/rename | 用户确认；对齐 Kimi detect→run | 仅 fallback；仅 CLI 命令 | 启动需幂等与冲突策略 |
| 项目 git | 整目录 ignore | 用户确认；仓库已有 `.ohbaby/` | 只 ignore skill-output | 团队共享 MCP/skills 需 force-add 或外置文档 |
| Home 覆盖 | `OHBABY_HOME`（完整配置根、绝对路径） | 五家共性；测试隔离；语义无歧义 | 把它解释为用户 home 父目录 | 非绝对路径需明确报错 |
| Memory 路径 | 与 custom instructions 统一到 `~/.ohbaby/OHBABY.md` | 消除双源 | 保留 XDG config 记忆 | 旧 XDG 记忆文件需纳入迁移 |
| 包名/MCP name | 不动 | 产品身份 ≠ 目录名 | 全盘改名 | — |

**不可逆点**：一旦用户机器上完成 rename 且删除旧目录，回退需备份；迁移必须幂等、可跳过、冲突时不静默覆盖。

---

## 2.3 分阶段实施

### Phase 1 — 路径门面（无行为切换）

- **目标**：新增统一模块，旧常量改为 re-export 或内部改用门面；测试用 `OHBABY_HOME` / 注入 home 可指向临时目录。
- **改动**：
  - 新增 `packages/ohbaby-agent/src/paths/ohbaby-home.ts`（名称可微调，保持单一入口）
    - `OHBABY_DIR_NAME = ".ohbaby"`
    - `OHBABY_DATA_APP_NAME = "ohbaby"`
    - `OHBABY_LEGACY_DIR_NAME = ".ohbaby-agent"`
    - `OHBABY_LEGACY_DATA_APP_NAME = "ohbaby-agent"`
    - `resolveOhbabyHome(home?)`、`resolveProjectOhbabyRoot(projectRoot)`
    - `resolveOhbabyDataRoot()`（含 win32 → LOCALAPPDATA）
    - 派生：`getGlobalEnvPath`、`getModelJsonPath`、mcp/skills/agents/tools、`getGlobalOhbabyMdPath`、`getDaemonServerDir`（或 daemon 继续自拼但读同一常量）
  - 各 loader / `project-env` / custom-instruction / memory 改为调用门面（**暂时仍解析到旧路径字符串** 或双读——推荐直接切到新路径 + Phase 2 迁移，若切新路径则 Phase 1+2 合并交付）
- **推荐交付策略**：**Phase 1 与 Phase 2 同一 PR 可运行切片**：门面默认新路径 + 读 fallback 旧路径 + 写新路径；迁移函数可先实现后在 Phase 2 挂启动钩。
- **DoD**：单测覆盖各 OS 分支路径拼接；无生产行为强制迁移（若未挂钩）。

### Phase 2 — 读新写新 + 自动迁移

- **目标**：启动时 `migrateOhbabyHomesIfNeeded()`：
  1. 若存在 `~/.ohbaby-agent` 且目标缺对应文件 → copy 树到 `~/.ohbaby`（或 rename 若目标不存在）
  2. 若存在平台数据 `.../ohbaby-agent` 且 `.../ohbaby` 不存在 → rename/copy；`ohbaby-agent.db` → `ohbaby.db`
  3. 若存在 XDG/`APPDATA` 下旧 `OHBABY.md` 且 `~/.ohbaby/OHBABY.md` 不存在 → 迁入
  4. 配置迁移按文件幂等执行；marker 仅记录迁移状态，不能作为跳过未迁文件的唯一依据
  5. 冲突：目标已存在且内容不同 → **不覆盖目标**；MCP / `.env` 做 schema-aware additive merge（新值优先），其余写 sibling 并报告
  6. 数据迁移先获取迁移锁并确认无 live daemon；SQLite 的 DB / WAL / SHM 必须作为同一组迁移
- **挂点**：CLI 在 `.env` 加载前迁移配置；server 在确认无可复用 daemon、创建数据库前迁移数据。两者均直接调用同一幂等入口。
- **DoD**：单元测试覆盖 empty→migrate、already-migrated、conflict、并发锁、崩溃重跑；集成测试用临时 home/data root。

### Phase 3 — 去掉旧路径写路径与噪音

- **目标**：删除对 `.ohbaby-agent` 的**写入**；读 fallback 可保留一个小版本窗口或本 Phase 末尾删除（建议：**读 fallback 保留至下一小版本，但本批文档声明 deprecation**）。
- 删除重复 `OHBABY_CONFIG_DIR_NAME` 定义；UI 标记改为 `.ohbaby/`；Memory 不再使用 XDG config 根。
- Skills：规范目录名为 `skills/`；读时短暂兼容 `skill/`。
- **DoD**：`rg '\.ohbaby-agent'` 在 `packages/` 生产代码中仅出现于 migration/legacy 常量与注释。

### Phase 4 — 文档与 gitignore 对齐

- 更新 README、architecture §8.1、config/mcp/skill 文档路径。
- 确认根 `.gitignore` 含 `.ohbaby/`（已有）；可选增加注释说明「团队若需共享 mcp/skills，使用文档化的 force-add 或仓库外约定」。
- 插件/exa 设计文档路径改为 `.ohbaby`。
- **DoD**：文档自检无残留「唯一真源是 `.ohbaby-agent`」的权威描述。

---

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `packages/ohbaby-agent/src/paths/` | `ohbaby-home.ts` + unit tests；`migrate.ts` | — | — | 门面 + 迁移 |
| `packages/ohbaby-agent/src/utils/project-env.ts` | — | 根常量与路径 | — | |
| `packages/ohbaby-agent/src/config/**` | — | 全部 loaders / writers | 重复常量 | |
| `packages/ohbaby-agent/src/core/system-prompt/services/custom-instruction-loader.ts` | — | 目录名 | — | |
| `packages/ohbaby-agent/src/core/memory/*` | — | 全局路径改 home `.ohbaby` | XDG config 逻辑 | |
| `packages/ohbaby-agent/src/services/database/path.ts` | — | app id + Win Local | — | |
| `packages/ohbaby-agent/src/services/storage/path-resolver.ts` | — | 同上 | — | |
| `packages/ohbaby-agent/src/snapshot/diff-engine.ts` | — | 同上 | — | |
| `packages/ohbaby-agent/src/skill/tool.ts` | — | 确认已用 `.ohbaby` | — | 通常无改 |
| `packages/ohbaby-server/.../daemon/scope.ts` | — | 可选改用共享常量 | — | 路径值不变 |
| `packages/ohbaby-cli` | — | connect-search 路径 UI；启动挂迁移 | — | |
| `packages/**/__tests__` / integration | — | 字符串 `.ohbaby-agent` → `.ohbaby` | — | 量大 |
| `docs/**`、`README*.md` | 本 problem-list | 路径说明 | — | Phase 4 |
| `.gitignore` | — | 核对 `.ohbaby/` | — | 已存在 |

---

## 2.5 API / 协议 / 迁移与兼容

### 环境变量

| 变量 | 语义 |
|------|------|
| `OHBABY_HOME` | 可选；值本身就是全局用户配置根，必须为绝对路径。默认 `join(homedir(), ".ohbaby")` |
| `OHBABY_DB_PATH` | 保持；显式 DB 文件 |
| `OHBABY_STORAGE_ROOT` | 保持；显式 storage 根 |

本批不新增 `OHBABY_DATA_HOME`；数据层继续使用平台默认，并保留现有 `OHBABY_DB_PATH` / `OHBABY_STORAGE_ROOT` 精确覆盖。

### 迁移契约

| 源 | 目标 |
|----|------|
| `~/.ohbaby-agent/**` | `~/.ohbaby/**`（相对结构保持：`mcp/settings.json` 等） |
| `<project>/.ohbaby-agent/**` | `<project>/.ohbaby/**`（按项目在用时或首次进入该项目时迁移） |
| 平台 `.../ohbaby-agent/**` | `.../ohbaby/**`；`ohbaby-agent.db` → `ohbaby.db` |
| XDG/`APPDATA` `.../ohbaby-agent/OHBABY.md` | `~/.ohbaby/OHBABY.md` |

项目级迁移触发：解析项目配置前检测 `.ohbaby-agent` 存在则 migrate（避免只迁 home）。

### 兼容窗口

- **写**：只写 `.ohbaby` / 新数据根
- **读**：新优先，旧 fallback 保留一个 minor 版本，随后删除
- **Daemon legacy** `<project>/.ohbaby/server`：保持既有 global-single-daemon 逻辑，与本议题正交

---

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 迁移覆盖用户新文件 | 冲突不覆盖 + sibling + 日志 | 从 sibling / 备份恢复 |
| 半迁移状态 | marker + 幂等：已存在目标则跳过该文件 | 删 marker 后修冲突再跑 |
| Windows 文件锁导致 rename 失败 | copy + 保留源；或提示关闭占用进程 | 保留源目录 |
| SQLite 在 WAL 写入期间迁移 | live daemon 检测 + 独占迁移锁；DB/WAL/SHM 整组处理 | 停止启动，不切新路径 |
| 两进程同时首启 | 原子迁移锁 + 目标文件原子 rename + 幂等重跑 | 等待下一次启动重试 |
| 漏改一处常量 | Phase 3 `rg` 门禁 + 单测矩阵 | — |
| DB 路径切换丢会话 | 必须迁文件或 `OHBABY_DB_PATH` 指旧文件 | 指回旧路径 env |

---

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 体现 |
|---------|---------|
| `.ohbaby` 唯一可见根 | §2.1–2.2 |
| 数据层平台目录 + 改名 `ohbaby` | §2.2、resolveOhbabyDataRoot |
| 自动迁移 | Phase 2 |
| 整目录 gitignore | Phase 4 |
| 清噪音 | Phase 1/3 |
| 不改包名 / 不改 env 优先级 | §2.8 |

---

## 2.8 不在本批

- npm / 目录包改名
- MCP client name 改名
- ProgramData /etc managed config
- 将 sessions SQLite 逻辑迁出当前 DB 设计
- 强制用户删除旧目录（可文档提示手动清理）
