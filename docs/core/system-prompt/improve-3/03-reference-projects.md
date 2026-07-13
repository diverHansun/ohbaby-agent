# 3. 优秀项目借鉴

> 本地路径均在 `/Users/hansun025/Projects/code-cli/` 下。与 [00 §5](./00-discussion.md) 一致；细节服务 [02](./02-optimization-plan-and-change-scope.md)。

---

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|------|------|----------|
| kimi-code | `kimi-code/packages/agent-core` | `select-tools.ts`、`dynamic-tools.ts`、`tools-diff.ts`、subagent 披露 |
| claude-code | `claude-code` | system 策略 vs tool schema；deferred/search；skill listing attachment；瘦 subagent |
| codex | `codex/codex-rs` | base vs world_state；tool_search / deferred；skills fragment |
| opencode | `opencode/packages` | SystemContext / skill-guidance；瘦 explore；默认 MCP 全量（反例） |

---

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|------|------|----------|-------------|
| **kimi** | 公告 `<tools_added/removed>` + `select_tools` 精确点名；description byte-stable；subagent 同样有 select | 点菜 UX 最完整 | **Adopt 交互**；**Reject** `messages[].tools`；改用每步顶层 `tools[]` |
| **kimi** | 压缩后剥离动态协议、需重选 | compaction 语义 | **Adapt** 选一种可测策略写入 Phase B |
| **kimi** | select_tools 同批串行 | 防双注入 | **Adopt** |
| **claude** | system 讲跨工具策略；参数在 tool schema | 纠正 guidance 双份 | **Adopt** |
| **claude** | 动态列表勿塞进静态 tool description | skill/MCP 目录抖动 | Skills 本批不迁；MCP 用公告不写进 select 描述 |
| **claude** | 瘦 `DEFAULT_AGENT_PROMPT` + 环境增强 | subagent | **Adapt** 护栏短节，不继承 primary base |
| **codex** | 静态 instructions vs 动态 world_state diff | 归属清晰 | **Adapt 概念**；不做完整 world_state |
| **opencode** | skill 工具描述不含目录；guidance 独立 | Skills 模式 | **已接近**；本批保持 |
| **opencode** | plan/explore 短 prompt | subagent | **Adapt** |

---

## 3.3 明确不借鉴

| 项目 | 做法 | 原因 |
|------|------|------|
| kimi | `messages[].tools` | ohbaby message/SQLite/双 provider 无此契约；02 已拒 |
| claude | `defer_loading` + SearchExtraTools 作唯一路径 | Anthropic 色彩重；语义搜索非 MVP |
| codex | 子代理继承全量 `base_instructions` | 与「瘦 subagent」目标相反 |
| codex | 原生 `tool_search` API | 绑死 Responses |
| opencode | Context Epoch 全套 | 本批只要归属清晰 |
| opencode | 默认 MCP 全量进 `tools[]` | 正是本批要改掉的 |

---

## 3.4 对 02 方案的影响

| 02 决策 | 参考来源 |
|---------|----------|
| 公告 + select_tools + 每步 tools[] | kimi 交互 × ohbaby provider 现实 |
| 无双模式 | 用户 KISS + 避免 opencode/旧 ohbaby 全量默认 |
| 删 guidance 复读 | claude/kimi 策略-schema 分离 |
| Subagent 自有披露 + 护栏 | kimi + claude |
| UI 隐藏 select | 产品层（对齐本仓库 todo 隐藏；参考项目少直接对标） |
| 不上 Epoch / messages[].tools | 03 §3.3 |

---

## 3.5 关键文件锚点（参考仓）

- kimi: `packages/agent-core/src/tools/builtin/select-tools.ts`
- kimi: `packages/agent-core/src/agent/context/dynamic-tools.ts`
- kimi: `packages/agent-core/src/agent/injection/tools-diff.ts`
- claude-code: `src/constants/prompts.ts`（Using your tools）
- claude-code: `src/utils/searchExtraTools.ts`
- opencode: `packages/core/src/skill/guidance.ts`
- ohbaby anthropic 已有: `packages/ohbaby-agent/src/services/interface-providers/anthropic.ts` `convertTools`
