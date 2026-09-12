# 5. 实施与验收记录

## 5.1 提交与改动面

| 阶段 | 精确提交 | 内容 |
| --- | --- | --- |
| 规划 | `24cc423` | improve-2 方案与验收基线 |
| Task 1 | `19844686` | 第三 kind、factory、cache observe-only 守卫与配置边界 |
| Task 2 | `c5080043` | Responses adapter、事件状态机、usage/observability 与集成覆盖 |
| Task 3 | 本文件所在的原子文档/契约提交 | Responses cache wire 回归、权威文档同步、验收记录；另含 Task 1 测试的一行 Prettier 机械格式修复 |

本阶段只修改契约测试和文档，例外是为恢复项目 `format:check` 门而格式化 `apply-active-model-config.unit.test.ts` 的既有断行；该修改不改变测试逻辑。没有改动 production lifecycle、context、SQLite、UI 或能力范围。

## 5.2 契约与文档落点

- Chat / Anthropic 的既有 prompt-cache wire 回归仍保留；Responses 针对 `auto`、`enabled`、`disabled` 三种 policy 均验证 `store: false`，且没有 cache、`prompt_cache_key` 或 `previous_response_id` 出站字段。
- factory/配置的已有测试继续保证：缺省为 Chat、Responses 仅显式 kind、未知 kind 拒绝而不 fallthrough。
- `docs/core/llm-client/` 已说明第三 kind 并非默认、共享消息仍为 Chat-shaped、Responses cache 为 observe-only、原生 continuation/canonical message/context/lifecycle 均未完成。
- 02 与 04 已同步 streaming message 澄清：`output_item.added` 的 message 只能是 `in_progress` + `content=[]`；唯一 `output_text` 由唯一 `content_part.added` 建立，part done/item done/terminal 必须对该 part 有序一致。

## 5.3 TDD、定向与全量本地验证

| 层次 | 命令 / 范围 | 结果 |
| --- | --- | --- |
| TDD / characterization | 新增 Responses prompt-cache contract 后运行该文件 | 直接 GREEN，17 tests / 1 file；这是 Task 2 已实现行为的 acceptance/characterization，不伪造 RED |
| 定向 | Responses adapter、integration、factory、cache resolver、config validation/apply 与 cache contract | 311 tests / 7 files passed，exit 0 |
| 全量门禁 | 清理遗留的本地 CLI package-install 进程/空锁目录后，单进程运行 `pnpm preflight` | **exit 0**；format、lint、typecheck、Vitest 与 build 均通过。Vitest 为 312 passed / 5 skipped files（317），3193 passed / 16 skipped tests（3209）；build 链执行各包 `tsc -b --force`。 |
| 失败诊断（已解除） | 更早的一次 `pnpm preflight` | exit 1：三项 CLI integration hook 在 420000ms 超时（309 passed / 3 failed / 5 skipped files；3188 passed / 21 skipped tests），根因为先前重复门禁遗留的本地 CLI package-install 进程与空锁目录；清理后以上单进程重跑通过。 |

`pnpm preflight` 的 build 链定义中包含各包 `tsc -b --force`；上述最终单进程门禁已实际运行该链并退出 0。

## 5.4 审查与 SWE 边界

Task 1 与 Task 2 ledger 均记录为 task review clean。Task 3 的独立 task review 与 final whole-branch review 均 **pending**；本文件不提前宣称通过。此次改动遵守最小边界：以 provider contract 固化外部 wire，未将 Responses 原生状态泄漏进共享 Chat-shaped 模型，也没有为未来 canonical/cache/continuation 增加抽象或状态。这避免把本轮协议接入的复杂度扩散到 lifecycle、context 或持久化层。

## 5.5 Live 与合入状态

没有读取或打印真实密钥，也没有运行任何真实外部 API。官方 Responses 文本和 function-tool smoke（T12）为 **live 未验证**，因此本地测试不能证明显式 Responses 已真实可用。

完整 preflight 已通过；但在 T12 与独立审查完成前，仍**禁止合入 `openai-responses-migration`**。
