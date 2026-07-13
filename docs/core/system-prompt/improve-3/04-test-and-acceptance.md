# 4. 测试与验收标准

> 实施会话按本文自测；验收会话对照本文 + [02](./02-optimization-plan-and-change-scope.md)。
> 原则：对准真实风险，不为覆盖率数字而测。

---

## 4.1 测试范围

| 类型 | 覆盖 |
|------|------|
| 单元 | assemble 层（无 guidance 复读、无 ask）；select_tools 逻辑；公告折叠；safe 扫描/cap；subagent base 护栏资产；FALLBACK 删除后 manager API |
| 集成/契约 | composition → prepareTurn → 假 LLM 收到的 tools 集合；MCP fake server 点菜后可调用；OpenAI-compatible 与 Anthropic 请求里 tools 形状 |
| UI | `HIDDEN_TRANSCRIPT_TOOLS` 含 `select_tools`；web adapter + tui 过滤单测 |
| 手工 | 真实/本地 MCP 各连 1 个；主 Agent + subagent 各走一遍点菜；确认 UI 不刷 select |

建议命令（以仓库实际脚本为准，实施时核对 package.json）：

```bash
# 示例：针对相关包跑单测
pnpm --filter ohbaby-agent test -- select-tools
pnpm --filter ohbaby-agent test -- system-prompt
pnpm --filter ohbaby-agent test -- composition
# Anthropic / OpenAI provider 转换测
pnpm --filter ohbaby-agent test -- anthropic
```

---

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 02 Phase |
|----|------|------|--------|----------|
| T1 | Primary assemble 无 tool description 复读 | 单测 | 输出无「Available tool notes:」抄写各 description；base 仍含跨工具策略 | A |
| T2 | 无 ask kind / 资产 | 单测 | 类型与 prompt-assets 无 ask；resolver 仅 plan/agent | A |
| T3 | 无 FALLBACK；getRuntimeAgent 不提供假 system | 单测 | manager API 契约；调用方编译通过 | A |
| T4 | 无 MCP 时 LLM tools = 内置 + skill 元工具 + `select_tools`（始终注册；loadable 为空） | 集成 | 不报错；无 MCP schema；不退回全量灌 | B |
| T5 | 有 3 个 fake MCP：初始 tools[] 无其 schema；有公告名 | 集成 | 点菜前无法被模型侧「合法看到」schema | B |
| T6 | select_tools(["mcp_…"]) 后下一步 tools[] 含该 schema 且可执行 | 集成 | loaded + execute | B |
| T7 | 一次 select 多个 names | 单测/集成 | 单轮加载多个 | B |
| T8 | 未知名 / 已 loaded 混批 | 单测 | 部分成功语义（对齐 kimi：非全有或全无） | B |
| T9 | 同批并发 select | 单测 | 同步 run-to-completion 更新；每个 session/context scope 的上限不被突破 | B |
| T10 | 恶意 MCP description | 单测 | 扫描 omit 或拒绝进可见 tools；至少不进未扫描通道 | B |
| T11 | 超长 MCP description | 单测 | 超过上限即拒绝，不进入公告或 schema | B |
| T12 | Anthropic convertTools 接受每步变化后的 tools | 单测/契约 | 与 OpenAI 路径对等 | B |
| T13 | select_tools 不出现在 transcript UI 投影 | 单测 | HIDDEN 集合 | B |
| T14 | compaction 后 loaded 策略符合实现文档 | 集成 | composition 内存集保留，下一轮仍下发已选 schema | B |
| T15 | subagent base 含安全护栏关键词/结构 | 单测资产 | 无 primary Identity 全文 | C |
| T16 | subagent 可见 skill + select_tools；可点 MCP | 集成 | 配置/白名单 | C |
| T17 | explore 只读仅为 task 文案；permission 不靠死 mcp:deny | 单测/审阅 | 配置清理 | C |
| T18 | 权威文档与代码一致 | 文档审阅 | Phase D | D |

---

## 4.3 集成边界

| 边界 | 注意 |
|------|------|
| ToolScheduler 执行集 vs LLM 可见集 | 未 select 的 MCP 应可 register 但不可出现在 LLM tools[] |
| Run 创建快照 | 不得把「全量 MCP schema」冻死整 run |
| Message 存储 | 公告与 select 结果对模型保留、对用户隐藏 |
| MCP list_changed | 刷新准入集；保留仍存在的 loaded 名，移除已消失名；下一轮 `<mcp_tools>` 重新渲染剩余未加载名 |
| 双 provider | 同一 resolveLlmTools 结果喂两边 |

---

## 4.4 回归清单

- [ ] Primary plan/agent 任务切换仍正确
- [ ] Skill 调用与 listing 预算行为不被破坏
- [ ] Todo 隐藏仍有效
- [ ] Subagent 仍不能 `subagent_run` 嵌套
- [ ] Custom instructions / memory 仅 primary
- [ ] Untrusted MCP 执行审批（既有 ask 流）仍工作
- [ ] `prompt:check` / 模板生成（若有）在删 ask、改 base 后通过

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| G1 | 00 内 in-scope 均落地 | 对照 02 Phase A–D DoD 勾选 |
| G2 | T1–T17 关键用例通过（T18 文档） | CI / 本地测试日志 |
| G3 | 无双模式全量灌 MCP | 代码审阅：无「flag 关 → getAllTools 进 LLM」主路径 |
| G4 | 单一 system 真源 | 无 FALLBACK；无 RuntimeAgent 假 system 消费 |
| G5 | UI 不暴露 select_tools | web/tui 手工 + T13 |
| G6 | 双 provider 点菜可用 | T12 + 手工各一模型族（若环境允许） |

---

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| 恶意 MCP description / schema 文案 | 进可见 tools 前扫描 + cap | 正则扫描非完美；依赖 cap |
| 模型跳过 select 直接「幻觉」调 MCP | 执行层：未 loaded 应拒绝并提示先 select | 多一轮摩擦 |
| 公告与真实 loadable 漂移 | list_changed → 刷新准入集与下一轮 `<mcp_tools>`；测试 T5/T14 | 快速抖动时下一轮才可见变更 |
| UI 隐藏但用户从原始日志看到 | 可接受；隐藏的是 transcript UX | 调试需看底层事件 |
| 误把内置也改成 select | 02/00 禁止；回归 T4 | 审查配置 |

---

## 4.7 与 01 高风险映射

| 01 问题 | 04 覆盖 |
|---------|---------|
| description 双份 | T1 |
| MCP 全量顶层 | T5–T7 |
| FALLBACK 双真相 | T3 |
| ask 死路径 | T2 |
| Subagent 护栏/工具 | T15–T17 |
| 原生 tools[] 无扫描 | T10–T11 |
| UI | T13 |
