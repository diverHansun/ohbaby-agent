# 3. 优秀项目借鉴

## 3.1 借鉴来源

| 项目 | 本地路径 | 调研范围 |
|------|----------|----------|
| Claude Code | `/Users/hansun025/Projects/code-cli/claude-code` | `getClaudeConfigHomeDir`、`CLAUDE_CONFIG_DIR`、项目 `.claude/`、legacy 文件迁移 |
| Codex | `/Users/hansun025/Projects/code-cli/codex` | `CODEX_HOME`、`find_codex_home`、分层 config、`CODEX_SQLITE_HOME`、ProgramData |
| Gemini CLI | `/Users/hansun025/Projects/code-cli/gemini-cli` | `GEMINI_CLI_HOME`、`Storage.getGlobalGeminiDir`、`tmp/<projectId>`、目录迁移 |
| Kimi Code | `/Users/hansun025/Projects/code-cli/kimi-code` | `KIMI_CODE_HOME`、`migration-legacy`（detect/plan/run/marker/skip/conflict） |
| OpenCode | `/Users/hansun025/Projects/code-cli/opencode` | XDG 四分离、`OPENCODE_CONFIG_DIR`、项目 `.opencode/` |

调研日期：2026-07-14。

---

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|------|------|----------|-------------|
| Claude / Codex / Gemini / Kimi | 用户根为 `~/.brand`；Windows 同构 home 点目录 | 用户可见单一根 | **Adopt**：`~/.ohbaby`，Win 不用 AppData 放配置 |
| Claude / Gemini / Kimi | `*_HOME` / `*_CONFIG_DIR` 整树覆盖 | 测试与多实例 | **Adopt**：`OHBABY_HOME` |
| Codex | `CODEX_SQLITE_HOME` 可单独指数据 | 配置与重数据可拆 | **Adapt**：默认平台数据根；保留 `OHBABY_DB_PATH` / `OHBABY_STORAGE_ROOT` |
| OpenCode | config/data/cache/state 严格 XDG | 消除「家目录膨胀」 | **Adapt**：仅**数据**走平台目录；**不**把用户配置改到 `~/.config/ohbaby`（与 00 冲突） |
| Kimi | `.kimi` → `.kimi-code` 完整 migration 包：marker、skip、conflict sibling | 品牌改名几乎同构于 `.ohbaby-agent` → `.ohbaby` | **Adopt** 力学；**Adapt** 规模（不必独立 package，模块即可） |
| Gemini | hash→slug 目录自动迁移 | 改名不丢数据 | **Adopt** 精神：幂等、可重复 |
| OpenCode / Kimi | 只读兼容 `.claude/skills`、`.agents/skills` | 跨工具 | **Keep** 现有 ohbaby 只读发现（已有）；本批不扩展 |
| Claude | 全局 `~/.claude.json` 与 `~/.claude/` 双根 | — | **Reject**：避免再造双根 |
| Codex / Gemini / OpenCode | 企业 `ProgramData` / `/etc` | 企业管控 | **Defer**：00 明确后续可选 |

---

## 3.3 明确不借鉴

1. **OpenCode 式「用户配置也进 XDG」** — 与「`.ohbaby/` 唯一用户可见根」冲突。
2. **Claude 式独立全局 JSON 文件** — 增加第二入口，放大偶然复杂度。
3. **把 sessions/DB 全部塞进 `~/.ohbaby/`** — 五家有同根混放先例，但 ohbaby 已有 SQLite + snapshot 体积；00 已选平台数据目录。
4. **Codex 级 Windows sandbox ACL** — 与路径统一无关，YAGNI。

---

## 3.4 对 02 方案的影响

| 02 决策 | 直接来源 |
|---------|----------|
| `OHBABY_HOME` | Claude / Codex / Gemini / Kimi 共性 |
| 自动迁移 + marker + skip + conflict sibling | Kimi `migration-legacy` |
| 配置 home 点目录 + 数据平台目录 | OpenCode 分离思想 × 用户可见根约束 |
| Win 配置不进 AppData；数据用 LocalAppData | Claude/Kimi 配置惯例 + 纠正当前 Roaming 误用 |
| 不引入 `~/.ohbaby.json` | 反面教材：Claude 双根 |

关键锚点（参考仓）：

- Claude: `src/utils/envUtils.ts` → `getClaudeConfigHomeDir`
- Codex: `codex-rs/utils/home-dir/src/lib.rs` → `find_codex_home`
- Gemini: `packages/core/src/config/storage.ts` → `getGlobalGeminiDir`
- Kimi: `packages/migration-legacy/src/run-migration.ts` → `runMigration`
- OpenCode: `packages/core/src/global.ts` → `Global.Path` / XDG
