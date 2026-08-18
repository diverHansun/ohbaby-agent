# 5. 实施与验收记录

> 日期：2026-08-18  
> 分支：`codex/web-tool-transcript`  
> 状态：自动化验收通过；真实浏览器/TUI 肉眼交互待验收。

## 5.1 已落地

- 新增共享 tool outcome projector；live stream 与持久化 snapshot 共用失败判定与摘要优先级。
- `failed` / `timed_out` / `cancelled`、非零 exitCode、scheduler error 均投影为 UI `failed`；exit 0 保持 completed。
- completed/aborted 已有 output 会保留；空 output 回退 error。
- Web 按 call id 配对 call/result，一次调用只渲染一张卡；标题、摘要、meta 不显示 callId。
- 短失败边界固定为最多 400 字符且最多 8 行；初始失败或 running→failed 时自动展开一次，用户收起后普通 rerender 不重开。

## 5.2 自动化证据

- shared projector、live adapter、persistent adapter 覆盖 FP-1–FP-5、FP-13、FP-14 的独立分支与接线。
- `tool-card.unit.test.tsx` / `App.unit.test.tsx` 覆盖配对、孤立 result、防 callId、单卡、400/401 字符、8/9 行、空 output 与状态跃迁。
- `pnpm test:unit`：213 个文件通过；1892 passed，2 skipped。
- `pnpm run lint`、`pnpm run typecheck`、`pnpm run build`：通过。
- 本次改动文件的 Prettier 检查：通过。

仓库级 `pnpm run format:check` 仍报告 43 个本批未触碰的既有文件；未为本议题扩大格式化 diff。

## 5.3 尚待肉眼验收

- Web 执行 `list` 失败与 `bash false`：确认一张红色 failed 卡、短错误可见、没有 result+callId 标题。
- Web 硬刷新：同一失败仍为 failed 且原 output 可展开。
- 建议在 TUI 复核同一 bash 失败随共享投影显示失败色。
