# 2026-11-13 模型设置页细节调整

用户要求：下拉箭头轻量、位置合理；可选输入改用 Optional；模型列表悬停时不出现整行长条背景。

## 实施约束

- 保留原生 select，仅调整箭头图形、右侧内缩和文本留白，保留既有键盘和焦点行为。
- Label、Context window、Max output 的占位改为 `Optional`。空值依然按已有探测/默认值规则解析，Context window 的 `Detected: …` 展示继续保留。
- 不把必填项和当前不可清空的 Key variable 标成 Optional。Prompt cache 的 `auto` 是真实保存值，不作为占位词替换。
- 模型列表取消整行悬停底色，以轻量文字反馈保留可点击性，保留键盘焦点轮廓。
- 不改后端字段、自动探测时机、保存语义、数值范围或 UI 组件体系。

## 验收记录

实现由 Pi `anthropic/claude-opus-5-5`、xhigh 完成，主代理复核和集成。整行 hover 的改动限定在已有 `data-model-id` 包裹的模型行，不影响其他设置列表。下拉箭头复用现有 settings select 类，图形资源遵循 tokens.css 的既有约束。

- 全仓测试：698 个文件通过、6 个跳过；8156 项通过、17 项跳过。Optional 断言补在既有“自动数值留空且无关编辑不序列化覆盖值”用例中，没有新增只复述 CSS 的测试。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run build` 全部通过。lint 有 125 项既有 warning、无 error；生产构建有既有 chunk 大小提示。
- 内置浏览器加载本地新构建，通过只读验收代理查看真实模型配置；未保存配置、触发探测或发送 LLM 请求。Protocol、Reasoning Effort、Prompt cache 箭头位置和细线样式正常。
- Label / Context window / Max output 显示 Optional；Detected: 1,000,000 tokens 保留。输入负数出现既有校验错误、Save 不可用，随后清空草稿恢复原状。Tab 导航可见焦点轮廓。
- 模型行实际 hover 状态下背景为 transparent，标题出现细下划线；无整行长条底色。
- 本地验收截图：`/tmp/model-settings-optional-20261113.png`、`/tmp/model-settings-hover-20261113.png`。
