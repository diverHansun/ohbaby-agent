# Responses 开发分支合入 main 的验收记录

日期：2026-09-17。用户明确授权先合入 Responses 开发分支，再完成 main 合并前后检查。本轮接入开发阶段已在本地完成；尚未推送远端。仓库中的实际分支名为 `openai-responses-migration`。

## 合并结果

- improve-8 最终提交：`4fb72271666c2aa9287d85861acd97ba24461bdf`。
- 开发分支由 `135a6cda` 快进到 `4fb72271`，纳入 improve-8 的 9 个提交。
- 本地 main 由 `dfb6d932` 快进到 `4fb72271`，纳入整个迁移的 59 个提交。两次合并均无冲突，无合并修补代码。
- fetch 后确认 `origin/main` 与合并前本地 main 一致。合并后的代码树与已验证候选提交一致；本次其后仅补充完成记录。
- 用户的 `tests/models-4-tests.md` 保持未跟踪，文件哈希核对不变；未加入提交。

## 合入 main 前

候选 `4fb72271` 上重新执行 `pnpm run preflight`，退出码 0：格式、ESLint、TypeScript、362 个测试文件 / 3722 项测试、全工作区构建通过；6 文件 / 17 项按现有条件跳过。CLI 打包安装测试也通过。此处为最终稳定提交的完整测试计数，替代上次收尾时的 3721 项数字。

真实凭据从本地 `.env` 加载，通过现有生产 backend 和会话路径执行三组验收。每组测试文件 8 项通过，其中包含一次完整实网场景；不能把测试项数当成 HTTP 次数。

| 协议 | 模型 | 观测请求数（含元数据、标题） | 主生成请求 | 工具配对 / 原生续接 / SQLite 恢复 |
| --- | --- | --- | --- | --- |
| Chat Completions | ZenMux `openai/gpt-5.6-luna` | 7 | 4，全部 HTTP 200 | 通过 |
| Responses | ZenMux `openai/gpt-5.6-luna` | 7 | 4，全部 HTTP 200 | 通过 |
| Anthropic Messages | ZenMux `anthropic/claude-sonnet-5` | 7 | 4，全部 HTTP 200 | 通过 |

Chat 和 Responses 的所有观测请求均为 HTTP 200。Anthropic 两条辅助标题请求记录为 `transport`，没有 HTTP 状态，不能据现有观测区分标题超时与上游故障；它们没有阻止主任务、工具往返和会话恢复，不记为辅助请求全绿。该现象与 improve-8 的既有记录一致。

```sh
pnpm run preflight
node scripts/run-real-session-reasoning.mjs --run --profile=zenmux-gpt56-luna-responses
node scripts/run-real-session-reasoning.mjs --run --profile=zenmux-gpt56-luna-chat
node scripts/run-real-session-reasoning.mjs --run --profile=zenmux-claude-sonnet5-anthropic
git switch openai-responses-migration
git merge --ff-only codex/improve-8-reasoning-probe
git switch main
git merge --ff-only openai-responses-migration
```

## 合入 main 后

在 main 上重新执行 `pnpm run test`，退出码 0：362 文件 / 3722 项通过，6 文件 / 17 项按原条件跳过，CLI 打包安装和真实本地进程回归通过。编译后的 CLI `--help`、`--version` 正常退出。代码与合并前构建通过的提交完全一致。

真实 TUI E2E 通过 TerminalApp stdin 从空配置进入 `/connect`，选择 Responses，然后通过 `/effort` 选择 `high`。主请求实际使用 `high`，完成文件读取工具往返，答案与会话偏好均正确保存；保留 input/output usage、缓存读明细与原生状态。本项证明 Ink 输入到真实模型的完整链路，不新增物理终端视觉结论。

真实 Context E2E 在 main 上执行文件读取、续聊、强制压缩、压缩后继续请求和 SQLite 重开，全部通过；观察到摘要生成与历史退休。这次仍走 force 压缩，不能当作自然达到 95% 的验收。具体审计文件为 `.ohbaby/test-evidence/improve-6/live-context/zenmux-gpt56-luna-responses-context-compaction-1789632370877.json`。

```sh
pnpm run test
node scripts/run-real-connect-tui.mjs --run --profile=zenmux-gpt56-luna-responses --effort=high
node scripts/run-real-context-e2e.mjs --run --profile=zenmux-gpt56-luna-responses-context --mode=compaction
node packages/ohbaby-cli/dist/bin.js --version
node packages/ohbaby-cli/dist/bin.js --help
```

本次完整日志、固定副本的脱敏实网审计和合并前引用保存在 `.ohbaby/test-evidence/responses-main-merge/`。其中 `preflight-before-merge.log` 是合并前完整检查，`tests-after-main.log` 是 main 上的全仓测试；三个 `*-before-main.log` 和 `tui-responses-after-main.log`、`context-after-main.log` 是实网命令记录。

## 完成范围与保留边界

完成范围涵盖 SDK/provider、独立 Responses 接口、自有消息结构、推理原生状态续接、用量与缓存统计、Context 计量与既有压缩链路、Agent loop、消息存储，以及 Web/TUI 连接和会话推理入口。迁移开发分支已合入本地 main 并通过上述合并前后检查。

真实百万窗口自然达到 95%、真实上游 context overflow 仍未实测；确定性测试和 force 压缩不替代这两项。供应商兼容性只承诺已验证组合，前序百炼 Responses、旧 Anthropic/Qwen smoke 等失败样本保留在阶段验收记录中。未来压缩/prune 算法优化和服务端状态链仍是独立工作，不属于本次完成范围。
