# 5. 实施验收文档

> 本文在实施、自动化/真实浏览器验收与三路只读子代理复审后撰写。02 保留规划基线快照；实际实现差异只在本文记录。

## 5.1 元信息

| 项 | 值 |
|----|----|
| 议题 / 批次 | Web `/skills` 发现卡片与 `/skill` 兼容别名 · improve-1 |
| 规划基线 | 2026-09-01，`origin/main@7cec6ba`，分支 `codex/slash-commands-improve-1` |
| 实施范围 | 当前分支相对 `7cec6ba` 的 command / Web UI / 测试 / 文档工作区 diff |
| 验收日期 | 2026-09-01 |
| 结论 | **通过**：02 承重项已完成，04 自动化与真实浏览器门已覆盖，三路复审 findings 已关闭 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
|---------|------|--------------|------|
| Phase A · alias 与 projection | 完成并加强 | `/skills` 增加 input-only `/skill`；单一 projection 同时产出 catalog 与 `/skills` output，按 builtin > accepted extra > skill 处理 path、alias 与 command ID；legacy reserved policy 保持大小写不敏感 | [`catalog.ts`](../../../../../packages/ohbaby-agent/src/commands/catalog.ts)、[`service.ts`](../../../../../packages/ohbaby-agent/src/commands/service.ts)、[`builtin.ts`](../../../../../packages/ohbaby-agent/src/commands/builtin.ts) |
| Phase B · skills modal | 完成 | 三段有界 grid；`scope · source`；hover/keyboard 共用 selection；click 直达；精确行 nearest scroll；notice 切换 remount，避免旧 selection 参与新列表滚动 | [`App.tsx`](../../../../../apps/ohbaby-web/src/ui/App.tsx)、[`styles.css`](../../../../../apps/ohbaby-web/src/ui/styles.css) |
| Phase C · palette 与规格 | 完成 | no-args 行显式三列，有 args 行保持四列；权威规格已从目标态翻转为当前行为 | [`README.md`](../README.md)、[`skill-invocation.md`](../skill-invocation.md) |
| 测试与验收 | 完成 | command/client/UI/style 自动化，lint/typecheck/full test/build，compiled Web E2E 与隔离真实浏览器链路 | [`04-test-and-acceptance.md`](./04-test-and-acceptance.md) |

## 5.3 规划 vs 实际差异

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
|------|----------|----------|----------|----------|
| 文件结构 | 02 C2 建议新增 `external-command-policy.ts` | 按用户 KISS 反馈，不新增文件；policy helper 与 projection 内聚在 `service.ts` | 规则只由 service projection 消费，单独文件增加跳转和抽象层 | 正向：减少文件与导出面；测试继续从公开行为覆盖 |
| 占用维度 | 规划明确 canonical path / alias 占用 | 复审后把 stable command ID 也纳入 builtin > extra > skill 优先级 | 防止不同 path 使用相同 ID 时 handler 被劫持或错误分派 | 正向：关闭 P1；不改变合法 command 协议 |
| handler 装配 | 规划聚焦 catalog/output projection | `extraHandlers` 只注册 accepted extra ID；handlerless `skill.*` extra 不进入 registry skill fallback | catalog eligibility 必须与实际 dispatch 一致 | 正向：fail-closed，避免 source/handler 漂移 |
| builtin helper fallback | 规划要求 `/skills` 消费共享 projection | 生产 service 注入 projection helper；低层公开工厂缺 helper 时安全返回空列表，不回退 raw registry | 保持一参数调用的类型兼容，同时杜绝绕过 policy | 仓库内生产路径无变化；低层直调由 raw output 变为 fail-closed 空结果 |
| UI 生命周期 | 规划要求 notice reset 与 nearest scroll | `SkillsCommandResult` 以 notice ID key remount，并用稳定 selected-row identity 驱动 layout effect | 消除同长度新 notice 使用旧 selection 的双滚动窗口 | 正向；新增专门回归测试 |
| 协议 / 依赖 | 不改 POST shape、skill 注入协议，不新增依赖 | 与规划一致 | — | 无兼容面扩大 |

## 5.4 实施理由与注意事项

- canonical alias 仍由 SDK resolve；Web 不写字符串特判。direct `/skill` 的 POST 使用 `commandId:"skills"` 与 canonical `path:["skills"]`，所有标签仍显示 `/skills`。
- projection 在一次读取中同时返回 catalog 与 `slashInvocableSkills`；`/skills` handler 不再直接读取未经 eligibility 过滤的 registry。
- catalog 请求与稍后的 `/skills` 执行仍会分别读取动态 registry。热更新恰好发生在两次调用之间时，两个快照可短暂不同；算法与优先级相同，不会产生同一快照内部自相矛盾。
- `aria-selected` 仍建立在普通 button + window keydown 模型上。本批只保证可观察 selection 一致性，不宣称完整 listbox/focus 辅助技术语义。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

| 验收项 | 结果 | 证据 |
|--------|------|------|
| A1–A3、A6、A8 · alias/canonical | 通过 | catalog 对 `/skill` 与 `/mcp` 做真实 resolve；client direct `/skill` 断言 canonical invocation；UI 只渲染 `/skills` |
| A4–A5、A7 · projection | 通过 | `service.unit.test.ts` 机械枚举 builtin path/aliases，覆盖三个 legacy roots、两个 permission exact paths、大小写、extra path/alias/ID、handler 与 skill first-wins |
| B1–B6 · modal | 通过 | metadata、hover→Tab、touch-like click、Arrow/Page clamp、Enter/Escape、精确 nearest scroll、无关 rerender与同长度新 notice、三段 ellipsis 均有测试 |
| C1–C3 · palette | 通过 | 同次渲染对照 args/no-args modifier；CSS 四列/三列合同；顶层不 flood 单个 skill |
| C4 · 文档 | 通过 | authority 已翻转为实施态，02 历史快照未回写；本文补齐验收链接 |
| targeted | 通过 | 6 files / 172 tests |
| lint / typecheck / build | 通过 | `pnpm run lint`、`pnpm run typecheck`、`pnpm run build` |
| full test | 通过 | 最终冻结树 308 files / 2942 tests passed，5 files / 16 tests skipped；复审并发阶段曾观察到 1 次无关 TUI frame timeout，单例复跑通过，最终全量重跑为发布依据 |
| compiled Web E2E | 通过 | `pnpm test:e2e:compiled-web`：UI evidence、backend request chain、daemon cleanup、diagnostics 均 pass |
| M1 / M4 | 通过 | 隔离 compiled serve；关闭 palette 后 direct `/skill` 打开 canonical `/skills`；计算样式确认 `/skills`/`status` 三列、`connect`/`goal` 四列 |
| M2 / M3 | 通过 | 两条 project skill；hover 第二行后 `aria-selected` 切换并 Tab 落入；另一行 click 落入；桌面与 390×844 窄屏三段有界且控制台零 warning/error |
| M5 | 通过 | click 落入 `/beta-build ` 后追加 `E2E_ARG`；隔离 OpenAI-compatible provider spy 同时观察到 skill prompt 与 raw argument，command 完成且未修改注入协议 |

### 5.5.2 子代理复审与修复

| 复审面 | 初始 finding | 处理 | 最终结论 |
|--------|--------------|------|----------|
| command policy | command ID 未占用，extra handler 可覆盖 builtin/skill；handlerless `skill.*` extra 会误入 skill fallback | ID 加入 projection；handler 仅注册 accepted ID；fallback 排除 accepted extra；补矩阵测试 | 全部 P1/P2 关闭，无新阻塞 |
| Web UI | notice 切换与 scroll 生命周期有双滚动风险；B2–B5 断言不足 | notice key remount；移除 passive ref cleanup；补完整导航/focus/scroll 测试 | 全部 P2 关闭，无新阻塞 |
| docs/test/out-of-scope | A6 只有 alias 声明、无 canonical resolve；05 尚缺失；全仓测试曾出现一次独立可过的时序 flaky | 补 `/mcp` resolve；写入本文；最终冻结树重跑完整门 | 发布证据闭环 |

### 5.5.3 SWE 与架构层面评估

大白话结论：改动把“哪些命令能出现”和“哪些 skill 能被列出/执行”收敛到同一处，没有为局部规则制造新模块；复审后又把 path、ID 与 handler 三层对齐，复杂度增加有明确正确性收益。

| 发现 | 严重性 | SWE / 架构依据 | 结论或建议 |
|------|--------|----------------|------------|
| projection 每次按顺序筛选，数据流单向 | 低 | 单一事实源、可预测 first-wins、无循环依赖 | 保持；不要在 Web 或 handler 再复制黑名单 |
| 没有新增外部调用、队列、重试或持久化 | 无 | 框架 4 的韧性/一致性项与本批无新增承重关系 | 无需引入超时、缓存或新基础设施 |
| extra 输入继续由路径/ID校验并 fail-closed | 低 | 安全边界要求外部 command spec 不能劫持 builtin | 已由测试锁定；后续新增占用维度时更新同一 projection |
| 动态 registry 两次读取可能短暂跨快照 | 低 / 已知 | 热更新一致性取舍：避免为 UI 列表引入缓存与失效协议 | 当前可接受；只有出现用户可见频繁抖动再引入 snapshot/version |

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|------|----------|------|
| [`catalog.ts`](../../../../../packages/ohbaby-agent/src/commands/catalog.ts) | `/skills` 增加 `/skill` alias | 修改 |
| [`service.ts`](../../../../../packages/ohbaby-agent/src/commands/service.ts) | KISS 内聚 policy；共享 catalog/output projection；path/alias/ID/handler 优先级 | 修改 |
| [`builtin.ts`](../../../../../packages/ohbaby-agent/src/commands/builtin.ts) | `/skills` 消费投影结果，低层缺 helper 时 fail-closed | 修改 |
| [`catalog.unit.test.ts`](../../../../../packages/ohbaby-agent/src/commands/catalog.unit.test.ts) | `/skill`、`/mcp` canonical resolve | 修改 |
| [`service.unit.test.ts`](../../../../../packages/ohbaby-agent/src/commands/service.unit.test.ts) | builtin/legacy/extra/skill、ID 与 handler 对抗性矩阵 | 修改 |
| [`client.integration.test.ts`](../../../../../apps/ohbaby-web/src/api/daemon/client.integration.test.ts) | direct `/skill` canonical POST | 修改 |
| [`App.tsx`](../../../../../apps/ohbaby-web/src/ui/App.tsx) | modal metadata、hover selection、refs/nearest scroll、no-args modifier | 修改 |
| [`App.unit.test.tsx`](../../../../../apps/ohbaby-web/src/ui/App.unit.test.tsx) | modal 全键盘/指针/focus/notice/scroll 与 palette DOM | 修改 |
| [`styles.css`](../../../../../apps/ohbaby-web/src/ui/styles.css) | skill 三段有界 grid 与 palette 三列 modifier | 修改 |
| [`slashCommands.unit.test.ts`](../../../../../apps/ohbaby-web/src/ui/slashCommands.unit.test.ts) | canonical palette label/suffix/header 与不 flood | 修改 |
| [`styles.unit.test.ts`](../../../../../apps/ohbaby-web/src/ui/styles.unit.test.ts) | grid/ellipsis selector 合同 | 修改 |
| [`../skill-invocation.md`](../skill-invocation.md)、[`../README.md`](../README.md) | 权威规格翻转为当前已实施行为 | 修改 |
