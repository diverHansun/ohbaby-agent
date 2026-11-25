# 3. 优秀项目借鉴

本文记录调研上级目录 `code-cli/` 下主流 Coding Agent 项目的源码与设计文档，并明确每项做法在 `ohbaby-agent` 中的取舍（adopt / adapt / reject）。

---

## 3.1 借鉴来源

| 项目 | 本地路径 / 核查文件 | 调研范围 |
| --- | --- | --- |
| `deepseek-harness` (`dsh`) | `/Users/hansun025/Projects/code-cli/deepseek-harness/packages/context/agent-instructions/README.zh.md` 及 `src/*` | 候选文件与去重、`<system-reminder>` 注入、Append-only KV Cache 策略、标签逃逸防护、预算与刷新模型 |
| `ZCode` | `/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`、`agents-user-instructions-merge.md`、`packages/adapters/src/context/index.ts` | 全局 + 工作区合并顺序、历史为唯一真源、读错 vs 删除区分、Cache 字节稳定性 |
| `kimi-code` | `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/profile/context.ts`、`agentsMdReminder/agentsMdReminderService.ts`、`changeNotifier/changeNotifierService.ts`、`workspace/workspaceInstructions/workspaceInstructionsService.ts` | 大小警告、符号链接兼容、变更提醒机制、fs watcher 复杂度权衡 |
| `codex` (OpenAI) | `/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/agents_md.rs`、`context/user_instructions.rs` | `AGENTS.md` 行业标准语义、作为 `user` 侧上下文消息注入而非静态 system prompt |
| `claude-code` (Anthropic) | `/Users/hansun025/Projects/code-cli/claude-code/src/context.ts`、`src/utils/claudemd.ts` + 2026 官方 `AGENTS.md` 原生回退资料 | `getUserContext()` → `prependUserContext()` 注入位置、低优先级与安全边界声明 |

---

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | `ohbaby-agent` 取舍 |
| --- | --- | --- | --- |
| `dsh` / `ZCode` / `Codex` / `Claude Code` | **指令不进入静态 system prompt**，而是作为 `user` 侧 `<system-reminder>` / 上下文消息进入历史，并严格 Append-only | 直接解决 `ohbaby-agent` 改一次 `CLAUDE.md` 就击穿整条会话 KV Cache 的核心痛点，同时天然降级为低优先级上下文 | **Adopt（直接采用）**：完全移出 `SystemPrompt.assemble()`，接入 `services/reminder` |
| `dsh` | 同时支持 `['AGENTS.md', 'CLAUDE.md']`，并在 `trim()` 后按内容摘要去重，避免软链/副本重复消耗 token | 2026 年多 Agent 仓库普遍同时存在两份文件（或 `ln -s AGENTS.md CLAUDE.md`） | **Adopt（直接采用）**：在全局和项目根同时探测两文件，按 `trim()` 后的 SHA-256 去重；项目内同目录软链别名由 `lstat` 直接跳过（见 00 §6 R2） |
| `dsh` | 显式声明优先级边界（不覆盖 system / developer / 用户直发指令），且**只转义 `</system-reminder>` 框架标签**而非全量转义正文 | 兼顾防注入逃逸与 Markdown 代码块、泛型、shell 命令可读性 | **Adopt（直接采用）**：写入 `services/instructions/renderer.ts` |
| `ZCode` / `dsh` | **以对话历史为唯一已公告真源**（不另建数据库状态表），并严格区分 `ENOENT` 文件缺失与 `EACCES`/`EBUSY` 瞬时读错（读错不误报删除） | 零额外持久化复杂度，天然兼容冷恢复与 compaction | **Adapt（改造采用）**：复用 `ReminderContext.history` 做历史态判定，区分 `ENOENT` 与读错（读错会告警）；读错时借鉴 dsh“回退到上次读成功的内容”，但只按文件回退（进程内 `lastGoodReads`），不整体冻结（见 00 §6 R2、R22） |
| `ZCode` | 全局指令（`~/.zcode/AGENTS.md`）在前、项目指令在后，后者覆盖前者 | 与用户确认的 `~/.ohbaby/` 全局 + 项目根双作用域模型完全一致 | **Adopt（直接采用）**：`global` → `project` 固定渲染顺序 |
| `dsh` / `ZCode` | 文件变更或移除时在历史末尾追加更新/移除消息 | 防止旧历史中的过时规范持续误导模型 | **Adapt（简化适配）**：本仓库最多 4 个文件，改用更简单的全量快照追加 + `cleared` 移除通知，避免维护单文件 delta 状态机 |

---

## 3.3 明确不借鉴

| 项目 | 做法 | 不借鉴的原因（结合 `ohbaby-agent` 约束） |
| --- | --- | --- |
| `kimi-code` | 首轮将 `AGENTS.md` 渲染进 `systemPrompt`，再另配 `WorkspaceInstructionsService`（`fs.watch` + 200ms 防抖）+ `ChangeNotifierService` + `AgentsMdReminderService` 三套服务协同 | 复杂度明显偏高；且首轮放进 system prompt 不如 `dsh`/`ZCode` 彻底解耦 Cache。本轮最多探测 4 个固定文件，按步读取远比跨平台 watcher 简单稳定 |
| `dsh` / `kimi-code` | 监听 `read`/`write`/`edit`/`bash` 工具调用路径，在模型触达深层子目录时动态加载嵌套 `AGENTS.md` | 本轮已明确采用「项目根单层扫描（选项 A）」，避免将指令模块耦合进 tool-scheduler / bash-parser |
| `dsh` / `Claude Code` | 支持 `AGENTS.local.md`、`CLAUDE.local.md`、`@path` 递归导入、`.claude/rules/*.md` | 当前无真实需求支撑（YAGNI），先守住 `AGENTS.md` + `CLAUDE.md` 核心标准 |
| `ZCode` | 按子代理角色差异化注入（`Explore` 跳过、`general-purpose` 注入） | 本轮已确认主/子代理统一注入（`audience: "both"`），保持简单一致 |
| `dsh` | 允许 symlink 跨工作区根读取（在文档中明确标为已知信任边界风险，要求外部沙箱兜底） | `ohbaby-agent` 在默认本地运行下不依赖强制 OS 沙箱，若放任项目内软链指向工作区外宿主文件会直接造成数据外泄；因此本方案在项目作用域**不读任何软链**（同目录 `CLAUDE.md` / `AGENTS.md` 别名静默跳过）；根内软链也可能指向未提交的 `.env`，按 `realpath` 限定在根内拦不住。全局作用域由用户自己设置，跟随软链（见 00 §6 R2） |
| `dsh` | 为全局链和项目链分别实现多档渐进省略/截断预算引擎 | 本轮最多 4 文件，采用简单的单文件 `32 * 1024` + 合并总预算 `64 * 1024`（按项目优先于全局顺序截断/省略）即可，不引入多档文案降级引擎 |
| `Codex` / `kimi-code` | 不注入正文，只告诉模型文件路径，让模型自己用 Read 读（两家只对子目录文件这样做：Codex `default.md:27` 让模型自己去找，kimi `agentsMdReminderService.ts:365-371` 只提醒路径） | 调研的 10 个项目里，凡是加载指令文件的（9 个），对项目根和全局文件全都注入正文，没有一家只给路径。原因：① 没有项目强制或检查模型是否真的读了，漏读时规则等于不存在；Claude Code `api.ts:455-457` 还特意把指令放进单独的高权重消息。② 读回来的内容一样进历史、占上下文，省不了 token，还多一轮工具调用。③ 文件变了仍要检测并提醒重读（kimi 为此另有 `changeNotifier`），省不了刷新机制。④ 本仓库 Read 工具没有项目软链拒读、FIFO 防护、32/64 KiB 预算和多编码识别（`edit.ts` 只支持 UTF-8）。**留作将来参考**：如果以后要支持子目录 `AGENTS.md`，kimi 的“触达目录时只提醒路径、让模型自己读”是改动最小的做法 |

---

## 3.4 对 `02` 方案的影响

1. **核心架构路线**（`02 §2.1`）：直接源于 `dsh` + `ZCode` + `Codex` + `Claude Code` 的统一共识——将易变指令彻底移出静态 `systemPrompt`，改走持久化、Append-only 的 `user` 侧 `<system-reminder>`。
2. **文件去重与标签转义细节**（`02 §2.2`）：直接采纳 `dsh` 的 `AGENTS.md` + `CLAUDE.md` 内容哈希去重与定向 `</system-reminder>` 转义，避开了“二选一丢互补规则”和“全量转义破坏 Markdown 代码”两个隐蔽陷阱。
3. **历史即真源与零额外持久化**（`02 §2.2`、`§2.6`）：采纳 `ZCode` 的“历史即真源”，不引入第二套状态存储。读错处理在评审中先改为“读错只让那份文件本步不生效”，不再整体保留旧快照（见 00 §6 R2）；后来发现固定头注会让这种做法向模型误报“规则作废”，再改为按文件用上次成功读到的内容顶替（见 00 §6 R22）。
