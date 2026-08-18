# 4. 测试与验收标准

> 项目测试规则：`docs-test/`。Web 见 [`docs/ohbaby-web/test.md`](../../ohbaby-web/test.md)。投影属 `ohbaby-agent` adapters，用 unit（必要时 persistent-store 现有 integration）。**不要求**改 TUI 测试文件；**不要求** Playwright。手工需同时看 Web 与（建议）TUI 一次 bash 失败。

## 4.1 测试范围

| 类型 | 覆盖 | 不覆盖 |
|------|------|--------|
| unit | `projectUiToolOutcome` 判定与摘要；adapter 把 exitCode 1 标 failed 且保留 output；persistent-store completed+metadata.failed 与 aborted output；Web pair 后只有一张卡、无 `result ${id}` 标题；短/长错误初始展开与 `running → failed` 跃迁 | 真 shell、真 LLM |
| 手工 | 浏览器：list 缺路径；bash `false` 或 `ls 不存在的路径`；刷新 session 后再看该卡 | 像素级豪华卡 |

定向命令：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/tool-ui-outcome.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/persistent-store.unit.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui/tool-card.unit.test.tsx
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx
```

完整发布门另跑 `pnpm test:unit`。仓库的 `test:unit` 包装脚本会枚举全部 unit 文件，不支持在 `--` 后用路径缩小范围。若复用现有 integration 才能覆盖某条接线，可追加，但不能替代已有 `persistent-store.unit.test.ts`。

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Phase |
|----|------|------|--------|----------------|
| FP-1 | scheduler error（list throw 形状） | unit | `call.status=failed`，`result.error` 使用 scheduler message；领域 `ToolState.error` 当前没有 output 字段，UI output 为空是类型边界 | A |
| FP-2 | scheduler success + metadata.status 分别为 `failed / timed_out / cancelled` + `exitCode: null` | 参数化 unit live+snapshot | 三种 metadata 终态均投影为 UI failed；timeout/cancelled 摘要保留差异；证明不依赖 exitCode | A |
| FP-3 | scheduler success + 无 metadata.status + `exitCode: 1` + output | unit live+snapshot | 两条路径均为 failed，output 原样保留；证明 exitCode 分支独立生效 | A |
| FP-4 | `exitCode: 0` / `metadata.status="completed"` | unit | 仍是 completed，无 error | A |
| FP-5 | live / snapshot 收敛 | unit | 同一逻辑结果经两条 adapter 后的 `status/error/output` 完全一致 | A |
| FP-6 | 配对 | unit | `[call, result, text]` → 一个 tool 节点 + text；已配对 result 不再单独渲染 | B |
| FP-7 | 失败卡 UI 文案 | unit | 标题为工具名并出现 failed；标题/meta/摘要/aria/data 等 UI 自生成字段不含 callId；原始 output 不作该断言 | B |
| FP-8 | 初始展开与阈值边界 | unit | 首次就是 failed：非空 output 优先；400/401 字符、8/9 行分别验证，只有字符和行数同时达标才 initial open | C |
| FP-9 | 未配对 result（call 缺失） | unit | 不丢弃；fallback 的 UI 自生成字段仍不使用 callId | B |
| FP-10 | 隐藏 todo 工具 | unit | 现有 `filterTodoToolParts` 回归：todo 仍不进流 | B 回归 |
| FP-11 | 直播状态跃迁 | unit | 同一个 call 先 running、后 failed+短错误：更新后自动 open；用户随后手动折叠，普通 rerender 不再强制打开 | C |
| FP-12 | 空 output 回退 | unit | `output: ""` + 非空 error：展开正文显示 error，不是空白 | C |
| FP-13 | aborted 已有 output | unit snapshot | 状态 failed；已有 output 原样保留；error 仍有短摘要 | A |
| FP-14 | 短摘要优先级 | 参数化 unit | 分别验证 `error.message → metadata.error → timed out/cancelled → exit code N → "failed"`，并验证多项同时存在时取最高优先级 | A |

## 4.3 集成边界

| 边界 | 验证 | 失败时 |
|------|------|--------|
| lifecycle 仍把 bash 非零写成 `ToolState.completed` | 不改 lifecycle；snapshot 路径必须从 completed+metadata 读出 failed | 刷新后 bash 又变成功 |
| 直播 `ToolCallResult` 带 metadata | 上游事件已有 metadata；adapter 本地 payload 类型需声明它，接线测试必须传入 metadata，不能只测 projector | 只 snapshot 对、直播不对 |
| TUI 只读 UiMessage | 不改 cli；手工或现有 TUI 测喂 `status: "failed"` 仍红 | 投影字段名写错 |

## 4.4 回归清单

- bash exit 0：不是 failed。
- 工具成功：仍一张（配对后）或至少无红、无 callId 标题。
- `select_tools` / `todo_*` 仍不进 transcript（adapter 已有隐藏逻辑，本批勿打破）。
- 时序议题：本批不要改 `eventReducer` 尾部 text 规则。
- 模型侧 tool 结果：不改 `tool-metadata-projection`；勿把 UI 摘要写进给模型的 content。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 定向单测 | FP-1–FP-14 绿 | 4.1 命令 |
| 全量单测 | `pnpm test:unit` 通过 | 仓库根执行 |
| 肉眼 Web list 失败 | 一张卡，failed，可见短错误，无 `result 数字` 徽章 | 浏览器 |
| 肉眼 Web bash `false` | 一张卡，failed，短摘要；长/多行输出默认折叠 | 浏览器 |
| 肉眼刷新 | 同一 session 刷新后 bash 失败仍 failed，展开仍有原 output | 浏览器硬刷新 |
| 肉眼 TUI（建议） | 同一失败 bash 在 TUI 为失败色，无需改 TUI 代码 | `ohbaby` TUI |
| grep | Web 源码无 `` `result ${` `` 作为工具卡标题 | grep `App.tsx` `tool-card.tsx` |
| 范围 | diff 不含 `tools/bash.ts`、不含 sdk snapshot 新字段、不含 TUI 组件（cli `message-row` 等） | `git diff --stat` |
| 前置 | 时序 problem-list 的 TO 验收已过 | 上一份 04 |

## 4.6 对抗性审查要点

1. **只改 projector 没接到 persistent-store**：刷新后 bash 又变成功。防御：FP-2/3/5 必须覆盖真实 adapter 接线。
2. **把“保留失败 output”写成不可能的承诺**：普通 `ToolState.error` 没有 output 字段，投影层无法恢复。防御：FP-1 固定类型边界；FP-13 只验证 aborted 的真实可选 output；completed+metadata.failed 由 FP-3/5 验证。
3. **metadata 终态或 exitCode 分支漏实现**：同时给 status.failed + exitCode 1 的测试无法发现，timeout 又常为 null。防御：FP-2 与 FP-3 拆开输入，并在 FP-2 参数化三种终态。
4. **配对后 key 与时序议题冲突**：时序用 `tool-call:${id}`；配对后 result 不再单独挂载，key 以 call.id 为准即可。两批都碰 App.tsx 时按分支顺序合。
5. **摘要把整段 JSON error 塞进标题**：`displayToolError` 已能 parse；helper 应复用或看齐，避免标题爆炸。
6. **阈值边界各写一套**：开发与测试若各自理解“很短”会漂移。防御：FP-8 固定 400/401 字符、8/9 行，并复用生产常量。
7. **只用 `useState(isShortFailure)`**：直播首次挂载是 running，initializer 不会在 failed 更新时再执行。防御：FP-11 必须使用 rerender 覆盖真实状态跃迁。
8. **用 `output ?? error` 选正文**：必填空字符串会挡住 error，造成已展开仍空白。防御：FP-12 固定 non-empty fallback 契约。
9. **只断言摘要非空**：实现退化成统一 `"failed"` 也会通过。防御：FP-14 参数化钉死来源与优先级。
