# 4. 测试与验收

本轮主要改文案。唯一改变代码行为的是 Stage 0：原生工具的路径参数展开 `~`（02 D13）。测试重点有三件事：`~` 展开后权限判断、资源锁和实际读写落在同一个路径上；生成链路和现有断言没被破坏；模型的工具选择确实变了，而且没有矫枉过正。

## 4.1 自动化检查

在仓库根目录运行：

```bash
pnpm --filter ohbaby-agent prompt:generate
```

```bash
pnpm --filter ohbaby-agent prompt:check
```

```bash
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt packages/ohbaby-agent/src/tools
```

Stage 0 另外要跑：

```bash
pnpm vitest run packages/ohbaby-agent/src/sandbox packages/ohbaby-agent/src/core/tool-scheduler packages/ohbaby-agent/src/adapters/ui-runtime
```

```bash
pnpm typecheck
```

要特别看的测试：

| 测试 | 关注点 |
| --- | --- |
| `src/core/system-prompt/__tests__/prompt-assets.unit.test.ts` | 生成文件和 md 模板一致 |
| `src/core/system-prompt/__tests__/assembler.test.ts`、`provider.test.ts`、`public-api.unit.test.ts` | 主代理和子代理的提示词能正常拼装；如有断言原文的用例，按新文案更新 |
| `src/tools/files.scheduler.integration.test.ts`（约 L520–580 是外部路径用例） | Stage 0 在这里补用例：read、list 传 `~/…` 先弹外部目录审批，批准后读到 HOME 下的文件；write 传 `~/…` 写到 HOME 下，而不是 `<工作区>/~/…` |
| `src/adapters/ui-runtime/host-local-environment.unit.test.ts` | Stage 0 补 `resolveHostPath` 展开 `~` 的用例 |
| `src/tools/bash-cleanup.scheduler.integration.test.ts:163,204` | bash 描述仍含"only run foreground commands" |
| `src/tools/{read,list,glob,grep,bash}.unit.test.ts` | 如有断言描述原文的用例，按新文案更新 |

实施前先用 `grep` 在测试里搜旧描述的关键句（例如"Read UTF-8"、"List immediate"、"Locate matching"、"Path inside the tool"），找出所有需要跟着改的断言。

## 4.2 文案自查

终稿落进代码前，逐条对照：

- [ ] 没有"禁止用 bash 查看文件"之类的绝对说法，bash 的合理用途和例外写清楚了（D3）。
- [ ] 理由里没有"bash 一定要审批"，improve-3 放开只读 bash 后每条理由仍然成立（D2）。
- [ ] 写了"多个查询并行调原生工具，不要用 `&&` 串成一条 bash"（D4）。
- [ ] `FILE_PATH_SCHEMA` 说明了外部路径可用、首次要确认，并且对 read、write、edit 都说得通；list、glob、grep 的 `path` 写了默认是工作区根目录（D7）。
- [ ] 没有残留"in the execution workspace""ignores ignore files"、大写的 `Read`、`Bash` 这类旧说法（D14）。
- [ ] 新增长度在 D9 预算内。可以用一段脚本打印改动前后各工具 `description` 和系统提示词的字符数。
- [ ] 三处文案没有互相矛盾，系统提示词没有重复 bash 描述里的整张映射表（D1）。
- [ ] 三个 Pi 模型的意见和采纳理由已保存（02 §2.4）。

## 4.3 真实模型测试

用户要求（2026-11-27）：用 [tests/models-4-tests.md](../../../../tests/models-4-tests.md) 里列的模型，API Key 用仓库根目录 `.env` 里对应的变量；做模型请求测试和端到端测试即可，不出固定题，不写自动化脚本。

**模型**（以 models-4-tests.md 为准，实施时它可能已更新）：

| Provider | 模型 | Key 变量 |
| --- | --- | --- |
| zenmux | `deepseek-v4.1-flash`、`claude-sonnet-5`、`gpt-5.6-luna` | `ZENMUX_API_KEY` |
| zhipu | `glm-5.3-flash` | `ZAI_API_KEY` |
| aliyun-dashscope | `qwen3.8-flash` | `DASHSCOPE_API_KEY` |
| deepseek | `deepseek-flash`、`deepseek-v4-pro` | `DEEPSEEK_API_KEY` |
| openai | `gpt-6.1-terra`、`gpt-6.1-sol`、`gpt-6-astra` | `OPENAI_API_KEY` |

配置注意：

- 按 models-4-tests.md 写的 message-interface 配置。OpenAI 三个模型必须用 `openai-responses`，用 `openai-compatible` 带工具会返回 HTTP 400（该文件 2026-11-08 的记录）。
- 只引用 Key 的变量名，不把密钥写进文档、配置示例或提交。
- 用临时模型配置测试，测完恢复原来的默认模型。

**怎么测**：只做两类测试，具体怎么问、测几次由实施会话灵活决定，不写自动化脚本。

- **模型请求测试**：每个模型带工具定义发一次真实请求，确认配置可用。
- **端到端测试**：在 ohbaby 里真实对话，覆盖查看文件、工作区外路径（含 `~/…`）、该用 bash 的场景（统计、跑测试）和子代理。改动前后各测一轮，记下工具调用情况，写进 05。

## 4.4 验收标准

| 项目 | 标准 |
| --- | --- |
| 自动化 | §4.1 全部通过 |
| Stage 0 | read、list、write 传 `~/…` 的单测通过，权限判断、资源锁和实际读写落在同一个路径上；工作区里有字面叫 `~` 的目录时，`./~` 仍能访问 |
| 查看类场景 | 改动后，各模型基本不再用 bash 查看文件，也不再把多个查看命令串成一条 bash。个别模型仍然偶发的，在 05 里写明是哪个模型、什么问法 |
| 该用 bash 的场景 | 统计、跑测试、构建、git 仍然用 bash，没有被新文案劝退 |
| 子代理 | explore、generic 子代理里看不到明显的 bash 查看 |
| 搜内容带上下文 | 只记录，作为 improve-2 的输入，不作为本轮通过条件 |
| 审查 | `magpie` 下的 `auto/gemini-4-neon`（high）审查实施结果，提出的问题已处理或写明不处理的理由 |

[tool-choice-stats.py](../tool-choice-stats.py) 只作为事后观察：真实使用一到两周后可以按 `--since` 看一眼整体比例，写进 05，不作为验收条件。

## 4.5 对抗性检查

- **矫枉过正**：统计、跑测试这类场景，模型如果改用原生工具硬凑，或者拒绝跑命令，说明文案太强，要回调措辞。
- **外部路径**：模型如果说"工作区外读不了"，或者传 `~/…` 失败后改用 bash，说明 Stage 0 或路径描述有问题。
- **问法换着来**：同一个场景用不同说法问，比如"cat 一下 package.json"。用户点名要 shell 命令时，模型用 bash 是对的（D3 的出口句）。
- **模型差异**：不同模型表现差别大时，不在本轮加针对单个模型的提示词，记进 05（见 02 §2.6）。
- **PowerShell**：在 Windows 或模拟 PowerShell 解释器的单测里，确认 `dialectNote` 新文案能正常拼进描述。
