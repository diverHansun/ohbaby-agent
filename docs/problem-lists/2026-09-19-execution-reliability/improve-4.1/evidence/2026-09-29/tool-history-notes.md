# 工具阶段详情的追加诊断

2026-09-29，生产代码仍为 `8d154655`。未读取用户真实数据库，未运行工具或请求模型。使用合成 props，通过 React server rendering 渲染实际 ToolCard / OrphanToolResultCard；阅读缓存设为展开。

[探针脚本](tool-history-probe.mts)与[基线输出](tool-history-probe.jsonl)。在仓库根执行：

```sh
pnpm exec tsx --tsconfig apps/ohbaby-web/tsconfig.json docs/problem-lists/2026-09-19-execution-reliability/improve-4.1/evidence/2026-09-29/tool-history-probe.mts
```

须使用 Web 的 JSX 配置；最初直接以根配置运行遇到 React 未定义的探针配置错误，使用上述命令后退出 0。这不是产品运行失败。

| 输入                               | 缺失提示 | Execution 详情 | Output |
| ---------------------------------- | -------- | -------------- | ------ |
| 旧 call/result，无 execution       | 显示     | 无             | 可见   |
| 配对 call/result，有合法 execution | 无       | 有             | 可见   |
| 单独 result，有相同合法 execution  | 显示     | 无             | 可见   |

结论：缺 execution 就显示文案，不限工具种类或记录年代；独立结果组件还会遗漏已提供的 execution。不能从此推断截图里的每条旧记录都缺数据或数据库发生丢失。未来新版保存/重新打开链路另由 T37 验证。

本探针不覆盖浏览器滚动、用户真实历史或 SQLite 往返；这些属于未来实施验收。本轮没有新增产品测试或修复实现。
