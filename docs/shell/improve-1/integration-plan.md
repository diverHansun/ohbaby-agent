# Shell improve-1 接入方案

本文给出 shell improve-1 的分批实施计划。当前分支采用方案二降低落地风险：
先以轻量 parser 达到本轮所需的方案三效果（结构化命令事实、arity、external-first permission），
再把完整 opencode 风格 tree-sitter parser 作为独立后续增强，不阻塞 improve-1 合并。

## 总览

| 阶段 | 目标 | 可独立提交 |
|---|---|---|
| 1 | bash 执行层硬化 | 是 |
| 2 | shell analysis 类型与轻量实现 | 是 |
| 3 | sandbox preflight 消费 shell analysis | 与 sandbox 阶段配合 |
| 4 | scheduler external-first 权限编排 | 与 sandbox 阶段配合 |
| 5 | skill scripts 路径验证 | 与 e2e 配合 |
| 后续 | tree-sitter parser 替换轻量实现 | 是 |

## 阶段 1：bash 执行层硬化

修改：

- `packages/ohbaby-agent/src/tools/bash.ts`
- `packages/ohbaby-agent/src/tools/bash.unit.test.ts`

改动：

- `stateEnvironment()` 注入 `NO_COLOR`、`TERM`、`GIT_TERMINAL_PROMPT`、`SHELL`。
- spawn 后关闭 stdin。
- 移除或替换 `commandPrefix is not supported` 的直接 throw。
- 保持现有 timeout、abort、killTree、输出截断行为。

测试：

- env 注入测试。
- stdin close 测试。
- commandPrefix 不再直接 throw 的测试。
- timeout / abort 现有测试不退化。

## 阶段 2：shell analysis 类型与轻量实现

新增：

```text
packages/ohbaby-agent/src/shell/analysis/
  index.ts
  types.ts
  light-parser.ts
  arity.ts
  classify.ts
```

职责：

- 复用当前 `utils/command-parser` 和 `shell/preflight.ts` 中已有逻辑。
- 输出 `ShellAnalysisResult`。
- 不做 workspace boundary，不抛外部路径错误。
- 产出 bash permission 所需的 `arityKey` 与 `danger`。

迁移原则：

- `shell/preflight.ts` 当前较大，先不要一次性拆空。
- 新 analysis 可以先包装现有解析能力，保持行为可测。
- 后续 tree-sitter 替换时只替换 analysis 内部，不改 sandbox/scheduler。

## 阶段 3：sandbox preflight 消费 shell analysis

详见 [sandbox integration-plan](../../sandbox/improve-1/integration-plan.md)。

shell 侧只保证：

```ts
analyzeShellCommand(command, shellKind): Promise<ShellAnalysisResult>
```

sandbox 侧负责：

- `pathArgs` → 绝对路径。
- outside → `externalPaths`。
- denylist → `denylistHits`。
- `tokens` / `arityKey` / `danger` 从 shell analysis 透传给 permission。

## 阶段 4：scheduler external-first 权限编排

shell 侧没有直接改动，但需要保证 `bash.execute()` 不再自己做 permission 前置检查。

顺序：

1. scheduler 调 `environment.preflight(command, shellKind)`。
2. 如果 `denylistHits` 非空，直接 rejected。
3. 如果 `externalPaths` 非空，逐路径或逐目录发 `external_directory` ask。
4. 外部路径批准后，再按原 `evaluatePermission()` 处理 bash。
5. 全部批准后才执行 `bash.execute()`。

## 后续阶段：tree-sitter parser

新增：

```text
packages/ohbaby-agent/src/shell/analysis/tree-sitter.ts
packages/ohbaby-agent/src/shell/analysis/bash.ts
packages/ohbaby-agent/src/shell/analysis/powershell.ts
```

依赖建议：

- `web-tree-sitter`
- `tree-sitter-bash`
- `tree-sitter-powershell`

采用 opencode 的 WASM lazy-load 思路，但不要复制其 Effect runtime。

验收：

- 多命令拆分准确。
- PowerShell `-Path` / `-LiteralPath` 参数能被识别。
- 动态表达式被标记而不是误解析。
- 解析失败有 fallback，不导致普通 bash 完全不可用。

## 阶段 5：skill scripts 验证

目标：

- 确认 skill `scripts/` 后续运行时可以复用 builtin bash。
- 确认 `../` 和绝对外部路径走 `external_directory`。
- 确认敏感路径 hard deny。

测试来源：

- unit：shell analysis / sandbox preflight。
- integration：tool-scheduler + bash + permission。
- e2e：按仓库 `ohbaby-e2e-test.md` 使用真实 API key。
- 子代理审查：不仅看测试，还审查职责边界、二次实现风险、KISS/YAGNI/DRY/SOLID。

## 提交策略

建议按阶段提交：

1. `docs: document shell sandbox improve-1 design`
2. `feat(shell): harden bash execution environment`
3. `feat(shell): add structured command analysis`
4. `feat(sandbox): add preflight facts from shell analysis`
5. `feat(permission): ask external directories before bash`
6. `test(sandbox): cover external bash path integration`
7. `fix(sandbox): tighten approved external execution`

如果任一阶段发现现有架构无法支持，不继续硬写代码，应停止并回到设计讨论。
