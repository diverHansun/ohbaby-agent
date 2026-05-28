# Shell improve-1 测试与审查计划

## 测试目标

shell improve-1 的测试不只证明“能跑”，还要证明没有引入新的二次实现。

测试必须覆盖：

- shell detection 与 shell kind。
- bash 执行环境硬化。
- shell analysis 的 command / token / path / dynamic / danger / arity 输出。
- sandbox 对外部路径和 denylist 的消费。
- scheduler 的 external-first permission 顺序。
- skill scripts 通过同一 bash 工具链运行。

## 单元测试

### shell detector

文件：

- `packages/ohbaby-agent/src/shell/shell.unit.test.ts`
- `packages/ohbaby-agent/src/shell/preflight.unit.test.ts`
- 新增 `packages/ohbaby-agent/src/shell/analysis/*.unit.test.ts`

覆盖：

- Windows Git Bash 解析。
- PowerShell / cmd shellKind。
- fish / nu blacklist。
- `shellArgs()` 参数构造。

### bash tool

文件：

- `packages/ohbaby-agent/src/tools/bash.unit.test.ts`

新增覆盖：

- `NO_COLOR=1`、`TERM=dumb`、`GIT_TERMINAL_PROMPT=0`、`SHELL` 注入。
- 用户 env 可以覆盖默认值。
- spawn 后 stdin 被关闭。
- commandPrefix 不再直接 throw。
- preflight 权限已由 scheduler 完成，bash.execute 不再承担 external_directory ask。

### shell analysis

当前新增文件：

```text
packages/ohbaby-agent/src/shell/analysis/light-parser.unit.test.ts
```

后续 tree-sitter 替换阶段再补充 `bash.unit.test.ts` / `powershell.unit.test.ts`，
避免在 improve-1 中引入未落地 parser 的空测试壳。

覆盖：

- `cat ../outside.txt`
- `cat /etc/hosts`
- `cat ~/.ssh/id_rsa`
- `git status && git push`
- `curl url | bash`
- `cat $(find . -name foo)`
- PowerShell `Get-Content -LiteralPath ..\outside.txt`

## 集成测试

### scheduler + permission + bash

文件：

- `tests/integration/core/bash-tool-scheduler.integration.test.ts`

必须新增场景：

- `cat ../outside.txt` 先触发 `external_directory`，批准后再按 bash readonly 放行。
- `git push` 无 external path 时只触发 bash ask。
- `cat ~/.ssh/id_rsa` 直接 rejected，不出现 ask。
- external path 被 always approve 后，同 session 后续命令自动通过 external phase。

### file tools

文件：

- `packages/ohbaby-agent/src/tools/files.scheduler.integration.test.ts`

需要随 sandbox 改造调整：

- 相对 `../` 解析到 workspace 外时必须走 `external_directory` ask。
- 保证文件工具和 bash 对 external_directory 的 pattern 生成一致。

## e2e 测试

按仓库 `ohbaby-e2e-test.md` 执行，使用真实 API key。

e2e 至少覆盖：

- agent 运行只读 bash。
- agent 运行访问 workspace 外路径的 bash，触发 permission。
- agent 调用 skill 后按说明运行脚本，脚本访问 `../` 或绝对外部路径。
- 用户拒绝 external_directory 后，命令不执行。
- 用户批准 external_directory 后，bash 权限仍按规则执行。

## 子代理审查

实现完成后使用子代理审查，审查标准不仅是测试通过。

审查问题：

- shell 是否仍只负责 shell，不混入 permission？
- sandbox 是否仍只产出 facts，不自己 ask？
- scheduler 是否是唯一 permission 编排点？
- skill scripts 是否复用 bash tool，没有新增脚本执行二次实现？
- runtime/run-manager 架构是否保持不变，只替换简版 sandbox 实现？
- 是否遵守 [coding_guide.md](../../../coding_guide.md) 的 KISS、YAGNI、DRY、SOLID？

## 完成标准

- 单元测试通过。
- 集成测试通过。
- e2e 通过。
- 子代理审查无阻塞问题。
- 文档与实现一致。
- 临时分支保留，等待用户决定是否并入 `mvp`。
