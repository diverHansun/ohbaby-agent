# 3. 参考项目借鉴

> 调研范围：上级目录 `code-cli/` 下的参考项目。原改名议题引用过的 gemini-cli 已经不在该目录下，这次没有纳入。

## 3.1 各项目怎么处理旧目录和旧数据

| 项目 | 做法 | 代码锚点 |
| --- | --- | --- |
| **OpenCode** | **过渡期结束后整块删除**。2026-02-13 加入 JSON→SQLite 存储迁移（`6d95f0d14c`，之后 `fdad823edc` 加了 `db migrate` 命令）。2026-06-02 的提交 `ca2acc4f8d`“refactor(opencode): remove JSON storage migration (#30461)”删掉了约 1590 行：`src/storage/json-migration.ts`、856 行的测试、桌面端加载页和启动时的一次性迁移代码。没有留回退读取，也没有提示。 | `opencode/specs/storage/remove-opencode-db.md` |
| **Kimi Code** | 长期保留迁移，单独做成一个包。用源目录里的标记文件、跳过标记和冲突时另存的 `*.migrated-from-kimi-cli.toml`，并提供交互式迁移界面和无头迁移。 | `kimi-code/packages/migration-legacy/src/{paths,marker}.ts`、`apps/kimi-code/src/migration/*` |
| **Codex** | 旧数据留在原地，让它自然过期。旧日志库用 `create_if_missing(false)` 打开，只做常规的过期清理。 | `codex-rs/state/src/sqlite.rs`（`legacy_logs_db_path`、`open_legacy_logs_for_cleanup`）、`state/src/runtime/logs_maintenance.rs` |
| **Claude Code** | 永久保留回退读取（旧的 `~/.claude/.config.json` 存在时优先用），设置迁移按版本号累加，从不删除。 | `claude-code/src/utils/env.ts`（`getGlobalClaudeFile`）、`src/main.tsx`（`CURRENT_MIGRATION_VERSION`） |

## 3.2 借鉴与取舍

- **采用 OpenCode 的做法**：过渡期结束后整块删除，不留回退读取，不加提示。它的情况和本项目最像：迁移是一次性的，过渡期几个月，删除时连同测试一起清掉。
- **ohbaby 当初的迁移设计本来就接近 Kimi Code**：标记文件、跳过标记、冲突另存。Kimi Code 选择长期维护，是因为它的旧产品（kimi-cli）用户量大、而且仍在使用。ohbaby 已经过了自己约定的兼容窗口，用户也明确不再兼容，没有理由长期背着这套代码。
- **不采用 Claude Code 的永久回退**：那样每个配置域都要永远知道两套路径，正是本议题要消除的复杂度。
- **Codex 的“旧数据自然过期”不适用**：它面对的是日志这类本来就会过期的数据；ohbaby 的旧目录里是配置和会话，不会自然过期。按用户的决定，程序直接不管旧目录。
