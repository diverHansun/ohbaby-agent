# 讨论结论

## 背景

议题总览见 [README](../README.md)。improve-1 解决"模型不知道该用原生工具"，本轮解决"原生工具不够用，模型只好退回 bash"。

## 用户确认的方向（2026-11-27）

- 内置工具能力要升级，单独作为一轮。
- 只读 bash 将在 improve-3 免审批，所以 grep、glob 也要补强，否则模型照样会因为原生工具做不到而选 bash。
- 实施中和实施后，可以调用 `magpie` 下的 `auto/gemini-4-neon`（high）审核。
- 改了参数之后，相应的工具描述要同步更新，并沿用 improve-1 §2.4 的 Pi 协作流程打磨文案。

## 逐条讨论中确认的结论

用户让我和 Gemini（high）先把能定的定下来，关键问题再拿回来问（2026-11-27）。重新统计数据并对照代码后：

- **G1**：grep 加 `before`、`after`（0–20），不加对称的 `context`。数据里 `-C` 一次都没用过，几乎都是 `-A`。看长函数体时先 grep 拿行号，再用 read。
- **G2、G3、G4**：加 `ignore_case`；加 `output_mode`（`content` 默认、`files`、`count`），沿用现有的 `--json` 解析；不加分页。
- **G6、G7、G8**：list 不加多层，也不加文件大小（52 次 `ls -la` 几乎都是习惯写法）；read 不改。
- **G9**：参数定下来后同步描述。

- **G5（2026-11-27 用户确认）**：glob 默认改成遵守 `.gitignore`，加 `include_ignored` 开关。这改变了 2026-10 定下的默认行为（当时只是为了保留现状）。点名的 glob 能覆盖文件级 ignore 规则，接受 rg 的这条语义，和 grep 的 `include` 保持一致，详见 [02 §2.2](02-optimization-plan-and-change-scope.md#22-设计决策表)。
