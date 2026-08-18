# 5. 实施与验收记录

> 日期：2026-08-18  
> 分支：`codex/web-tool-transcript`  
> 状态：自动化与 Web E2E 验收通过；纯工具负对照、滚动贴底和 TO-9 现场轨迹仍待补充。

## 5.1 已落地

- reducer 只更新消息尾部 text；tool part 后的新 delta 追加为新 text part。
- 缺少 messageId 或目标消息不存在时不再创建匿名/幽灵消息，seq 仍前进。
- tool part 使用 call id 稳定 key；text/reasoning 使用确定性的类型内序号。
- Web 权威文档已改为 snapshot / `message.appended` 建消息，delta 只更新已有消息。

## 5.2 自动化证据

- `eventReducer.unit.test.ts`：TO-1–TO-8 对应形状已覆盖，包括两轮工具、纯工具负对照、完整定稿、孤立 delta 与 seq 前进。
- `App.unit.test.tsx`：交换两个工具 part 后，展开态仍跟随原 call。
- `pnpm test:unit`：213 个文件通过；1892 passed，2 skipped。
- `pnpm run lint`、`pnpm run typecheck`、`pnpm run build`：通过。
- 本次改动文件的 Prettier 检查：通过。

仓库级 `pnpm run format:check` 仍报告 43 个本批未触碰的既有文件；未为本议题扩大格式化 diff。

## 5.3 Web E2E 证据

2026-08-18 使用本分支新鲜构建产物启动 `ohbaby serve`，并使用隔离的临时 `OHBABY_HOME`、SQLite 数据库和 OpenAI-compatible 假模型端点。假模型先流出前言，随后请求真实 `bash false`，最后延迟 6 秒流出结论。

- 流式中间态：页面仍为 `running` 时已稳定显示「前言 → 一张 `bash false failed` 卡片」，结论尚未出现，卡片没有先落到结论下方。
- 结束态：结论追加在卡片下方；assistant 区域内 `.ohb-tool-panel` 数量为 1。
- 硬刷新：数据库重建后仍按「前言 → 失败卡片 → 结论」显示，卡片数量仍为 1，浏览器 console 无 warning/error。
- 刷新前直播将三段合成一个 assistant 容器；刷新后持久化视图将结论恢复为下一个 assistant 容器。它是已知的数据分段差异，视觉时间顺序未改变，且属于本议题明确的 out of scope。

## 5.4 尚待补充

- 验证纯「工具 → 文字」负对照与滚动贴底无回归。
- TO-9 真实异常 run 事件轨迹尚未采集；它是现场归因证据，不是 merge blocker，也不得在缺少轨迹时宣称覆盖所有未知现场形状。
