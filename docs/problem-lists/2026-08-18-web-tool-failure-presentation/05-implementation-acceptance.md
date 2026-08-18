# 5. 实施与验收记录

> 日期：2026-08-18  
> 分支：`codex/web-tool-transcript`  
> 状态：自动化与 Web E2E 验收通过；TUI 复核仍待补充。

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

## 5.3 Web E2E 证据

2026-08-18 使用本分支新鲜构建产物启动 `ohbaby serve`，并使用隔离的临时 `OHBABY_HOME`、SQLite 数据库和 OpenAI-compatible 假模型端点。模型实际调用仓库的 `bash` 工具执行 `false`，不是直接伪造 UI 事件。

- 流式中间态：只出现一张展开的 `bash false failed` 卡，正文为 `Command failed with no output.`，页面未显示 callId。
- 结束态：assistant 区域内 `.ohb-tool-panel` 和 `bash false failed` 按钮均恰好为 1；结论正常追加。
- 硬刷新：失败状态、展开态和错误正文完整恢复；全页仍只有一张对应工具卡。
- 浏览器 console 的 warning/error 记录为空。

## 5.4 尚待补充

- `list` 抛错的 Web 肉眼复核；自动化已覆盖 scheduler error 的单卡与失败投影。
- 建议在 TUI 复核同一 bash 失败随共享投影显示失败色。
