# 2026-09-29 调研证据

基线 `8d154655fc64c3ed377eca44c5053a885b966239`。本批仅做只读代码调查、既有测试与纯函数探针，未读取 `.env`，未调用真实模型，未启动服务，未修改产品代码。

## 生产函数探针

[脚本](research-probe.mts)使用合成 command/message/run 事件调用当前 Web `replaceSnapshot` / `reduceUiEvent`，以及模拟技能展开文本调用当前 `sanitizePromptForSessionTitle`。从仓库根复现：

```sh
pnpm exec tsx docs/problem-lists/2026-09-19-execution-reliability/improve-4.1/evidence/2026-09-29/research-probe.mts
```

输出到 stdout，不改产品状态。基线输出保存为 [reducer-and-title-input-probe.json](reducer-and-title-input-probe.json)。

观测：

1. skill 的无 output action 生成 success / Command completed。
2. 同会话下一条 user message 和 running 更新均保留这张卡。
3. 同一命令先输出正文、后输出 action，后者覆盖正文。
4. 4,100 字符的模拟 skill 展开文本在命名输入中截成 2,000 字符，末尾用户要求丢失。

边界：它证明上述 reducer/sanitizer 行为，不证明完整服务端事件顺序、浏览器渲染、真实命令 handler 的所有组合或模型起名质量。调用处的生产链路另由 01 的代码证据说明。

## 现有定向基线测试

```sh
pnpm exec vitest run packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts apps/ohbaby-web/src/ui/conversation/tool-card.unit.test.tsx
```

[输出](baseline-tests.txt)：4 个文件、54 项通过，637ms；退出码 0。未扩大成整仓回归，也没有把通过解释为新需求已满足。Bash 旧图标的存在恰是当前测试断言之一。

## 前序切换诊断

2026-09-28 同一基线的会话切换诊断已在对话中报告：真实本地服务和 Web runtime 的三轮、15 次选择/切换；受控初次读取竞态；100/900ms 的 React banner 探针。原始临时记录分别为 `/tmp/ohbaby-improve4-switch-wire-trace.json`、`/tmp/ohbaby-improve4-first-view-diagnostic.log`、`/tmp/ohbaby-improve4-banner-diagnostic.log`。这些记录未在本次重新执行，临时路径不作为长期验收依赖。

后续 04 应把这些场景转成正式可重跑验收。先前 Pi 的观点在 01 中经过代码核对后归纳，不在此复制模型审查全文，也不以模型判断代替运行证据。
