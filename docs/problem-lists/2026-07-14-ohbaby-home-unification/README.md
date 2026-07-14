# 2026-07-14 · ohbaby home 路径统一

> 将用户可见配置根从分散的 `.ohbaby-agent/` / `.ohbaby/` / XDG `ohbaby-agent` 统一为：
> **`.ohbaby/` = 唯一用户可见根**；运行时重数据走平台数据目录下的 **`ohbaby/`**。

## 范围

### In scope

- 全局 / 项目配置根：`.ohbaby-agent` → `.ohbaby`
- 数据 app id：`ohbaby-agent` → `ohbaby`（DB / storage / snapshot）
- 统一 path 模块；消除重复常量与双路径噪音（含 Memory vs custom-instructions）
- 启动时检测旧目录并自动 copy/rename 迁移
- Windows：配置用 `~\.ohbaby`；数据用 `%LOCALAPPDATA%\ohbaby`
- 文档、测试、UI 路径提示与实现对齐
- 项目 `.ohbaby/` 整目录建议 gitignore（仓库已有 `.ohbaby/` 条目则核对即可）

### Out of scope

- 重命名 npm 包 / 仓库目录 `packages/ohbaby-agent`
- 重命名 MCP client `name: "ohbaby-agent"`（产品身份，非文件系统根）
- 实现尚未落地的 plugins / exa / tavily loader（仅保证未来路径写 `.ohbaby`）
- 企业级 managed config（`ProgramData` / `/etc`）— 记录为后续可选
- 改变 `.env` 加载优先级语义（shell > project `.env` > global `.env`）

## 文档地图

| 文件 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状与问题（代码锚点） |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约：阶段、改动面、迁移 |
| [03-reference-projects.md](./03-reference-projects.md) | Claude / Codex / Gemini / Kimi / OpenCode 借鉴 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收门 |

## 实施契约

- **本规划会话不写代码。** 实施在独立会话按 `02` + `04` 执行。
- 批次：单批（无 `improve-N` 子目录）。
- 权威冲突：`docs/project/architecture.md` §8.1 的 XDG 配置描述将被本议题方案 supersede（实施时同步改文档）。

## 目标布局（摘要）

```
~/.ohbaby/                          # 用户可见全局根
  .env, model.json, OHBABY.md
  mcp/, skills/, agents/, tools/
  server/                           # daemon（已在此）

<project>/.ohbaby/                  # 项目可见根（建议整目录 gitignore）
  mcp/, skills/, agents/
  skill-output/

# 平台数据根（用户通常不手改）
Linux:   $XDG_DATA_HOME/ohbaby 或 ~/.local/share/ohbaby
macOS:   ~/Library/Application Support/ohbaby
Windows: %LOCALAPPDATA%\ohbaby
  ohbaby.db, storage/, snapshot-git/
```
