# 4. 测试与验收

## 4.1 单测

在现有的 `src/tools/grep.unit.test.ts`、`glob.unit.test.ts`、`list.unit.test.ts` 里补：

| 场景 | 期望 |
| --- | --- |
| grep `before=2`、`after=2` | 每处匹配前后各两行，行号正确；上下文行和匹配行格式能区分；相邻匹配的上下文合并，不重复输出 |
| grep 只传 `after=5` | 只有匹配后面的五行 |
| grep `before` 或 `after` 超过 20 | 参数错误，不启动 rg |
| grep `output_mode=files` 或 `count` 同时传 `after` | 参数错误 |
| grep `ignore_case=true` | `Foo` 能匹配 `foo` |
| grep `output_mode=files` | 只返回文件路径，每个文件一次；`limit` 按文件数算 |
| grep `output_mode=count` | 每个文件一行，带匹配行数；`limit` 按文件数算，单个文件的计数不会被截断 |
| grep 大量上下文 | 触发现有的字节上限时，返回明确的截断状态 |
| glob 默认 | `.gitignore` 里列出的目录（例如 `coverage/`）下的文件不出现；固定排除目录照旧 |
| glob 点名被忽略的文件 | `.gitignore` 有 `*.log`，`glob **/*.log` 仍能找到，和 grep 的 `include` 一致。用测试固定这个行为 |
| glob `path` 指向被忽略的目录 | 能找到目录里的文件 |
| glob 默认无结果 | 结果里提示可以设 `include_ignored=true` 或直接把目录设为 `path` |
| glob `include_ignored=true` | 被忽略的文件出现，固定排除目录照旧 |
| glob 和 grep 一致性 | 同一个目录里，两者都不返回 `.gitignore` 忽略的文件；除了 glob 固定排除的 `node_modules`、`dist`、`out`、`target` 之外，glob 返回的文件和 grep 能搜到的文件范围一致 |

## 4.2 回归

```bash
pnpm vitest run packages/ohbaby-agent/src/tools
```

`tools/glob-cleanup.contract.test.ts` 和 `files.scheduler.integration.test.ts` 要特别留意，glob 默认值变化可能影响已有断言。

## 4.3 模型行为

沿用 improve-1 [04 §4.3](../improve-1/04-test-and-acceptance.md#43-真实模型测试) 的方式：用 `tests/models-4-tests.md` 里的模型做模型请求测试和端到端测试。重点看"搜一个函数并看上下文"时，模型改用 grep 的 `before`、`after`，不再用 bash 的 `grep -A`；函数体很长时先 grep 再 read。

## 4.4 验收标准

- §4.1 和 §4.2 全部通过。
- 端到端测试里，搜内容带上下文时基本改用原生 grep。
- 工具描述已同步，并经过 Pi 打磨；`magpie` 下的 `auto/gemini-4-neon`（high）审查过实施结果。
