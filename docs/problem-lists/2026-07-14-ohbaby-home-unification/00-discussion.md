# 讨论记录与已确认要点

> 2026-07-14 与用户讨论定稿。正式方案见 01–04。

---

## 1. 背景与动机

用户文件根目录命名分散（`.ohbaby-agent` vs `.ohbaby` vs XDG `ohbaby-agent`），导致 system-prompt 相关内容（尤其 MCP 配置、自定义指令）物理位置不统一，认知与维护成本高。目标是以 `.ohbaby/` 为唯一用户可见根，废弃 `.ohbaby-agent/`。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 用户可见根 | 仅 `.ohbaby/`：`~/.ohbaby/` 与 `<project>/.ohbaby/` |
| 废弃路径 | `.ohbaby-agent/`（全局与项目）不再作为配置根 |
| 数据层位置 | 仍走平台约定数据目录；**不**塞进 `~/.ohbaby/data/` |
| 数据 app id | `ohbaby-agent` → **`ohbaby`** |
| Windows 配置 | `%USERPROFILE%\.ohbaby\`（与 Unix 同构，不放 AppData） |
| Windows 数据 | `%LOCALAPPDATA%\ohbaby\`（从当前 `APPDATA`/Roaming 纠正为 Local） |
| 迁移强度 | 启动检测到旧目录 → **自动 copy/rename** 到新位置 |
| `OHBABY_HOME` | 表示**完整的用户配置根**，不是用户 home 的父目录；必须为绝对路径 |
| SQLite 迁移安全 | 仅在确认无 live daemon / 活跃写入后迁移 DB、WAL、SHM 整组；无法确认时停止并提示 |
| 兼容窗口 | 新路径写入；旧路径只读 fallback 保留一个 minor 版本后移除 |
| 项目 git | **整目录** `.ohbaby/` 建议 gitignore（仓库根已有 `.ohbaby/`） |
| 噪音清理 | 重复常量、Memory/XDG 与 custom-instructions 双路径、文档/UI 旧字符串一并消除 |
| 文档落点 | `docs/problem-lists/2026-07-14-ohbaby-home-unification/` |
| 参考项目 | 写文档前借鉴 claude-code / codex / gemini-cli / kimi-code / opencode |

---

## 3. 已确认：边界（不做的事）

| 项 | 本批不做 / 后续做 |
|----|-------------------|
| 包名 `ohbaby-agent` / npm 包改名 | 不做 |
| MCP client 显示名 `ohbaby-agent` | 不做（产品身份） |
| 企业 managed config（ProgramData /etc） | 后续可选 |
| 改变 `.env` 优先级语义 | 不做 |
| 把 DB 迁入 `~/.ohbaby/` | 不做（已否决方案 B） |
| 全面 XDG 配置根（`~/.config/ohbaby`） | 不做（已否决方案 C 作为用户可见根） |

---

## 4. 已确认：与关联议题的关系

| 关联 | 关系 |
|------|------|
| `2026-07-11-global-single-daemon` | daemon 已落在 `~/.ohbaby/server/`；本议题保留该路径，把配置迁入同根 |
| `2026-06-17-api-key-env-centralization` | `.env` 路径从 `~/.ohbaby-agent/.env` 改为 `~/.ohbaby/.env`，优先级语义不变 |
| `docs/project/architecture.md` §8.1 | 文档写 XDG 配置根，与实现不符；本议题 supersede 该描述 |
| plugins / exa / tavily 设计文档 | 路径尚未实现；规划时统一写 `.ohbaby`，避免再引入第三套名 |

---

## 5. 参考项目（摘要）

五家共性：单一 `*_HOME` / `*_CONFIG_DIR` 覆盖用户树；项目级 dot-dir；Windows 用户配置多用 home 点目录。  
分化：OpenCode 严格 XDG 四分离；Kimi 有最完整的 brand 改名迁移包。  

ohbaby 取舍：**用户可见对齐 Claude/Codex/Kimi 的 `~/.ohbaby`；重数据对齐 OpenCode 式平台数据目录但 app id 为 `ohbaby`；迁移力学对齐 Kimi。** 详见 [03-reference-projects.md](./03-reference-projects.md)。

---

## 6. 用户确认记录

- 数据层：留平台目录 + 重命名为 `ohbaby`；不迁入 `.ohbaby/data/`
- 迁移：启动自动 copy/rename
- 项目配置：`<project>/.ohbaby-agent/` 一并迁移到 `<project>/.ohbaby/`
- `OHBABY_HOME`：定义为完整配置根，且必须是绝对路径
- SQLite：安全优先，无法证明静止时不得复制或切换数据库
- 旧路径：只读兼容一个 minor 版本
- git：整目录 ignore
- 写文档前先调研五参考仓库
- 文档完成后做对齐与审查
