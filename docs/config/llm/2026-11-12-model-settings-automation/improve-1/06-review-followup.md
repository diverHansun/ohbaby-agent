# 外部审查后的修复与复核

日期：2026-11-12。修复基线：`b583f020`。上一轮四个职责提交已完成且未推送；本页记录此后的增量修复，不把上一轮 8116 项通过结果当成本轮结果。

## 反馈处理

| 反馈 | 源码核实与处理 |
| --- | --- |
| 小 context 新运行被拒，Web 没有可见错误 | 确认。后端拒绝发生在消息持久化之前。本轮用现有 `tokenBudgetIssue` 在 composer 拦截发送，保留草稿，提供 Check settings；没有改准备阶段失败的通用持久化生命周期。 |
| TUI 设默认后探测结束不通知 | 确认。`selectDefaultModel` 传入原有 `publishModelInvalidation` 作为 `onDiscovery`，让终态经既有事件链路到达界面。 |
| connect 数值编辑重启在途探测 | 确认。在现有配置锁内读取同 generation/route 的探测状态并准备启动，任一阶段仍 detecting 时复用；连接变化仍由 writer 使 generation 失效。已结束的 connect 保留已有 metadata GET 刷新行为，可信 reasoning 复用、不重复主动 POST。 |
| `allowActiveProbe`、`deferMetadata` 等无用参数 | 删除确认无用途的开关、参数与分支，包括 metadata expected 的 context 字段、setActive 的 discovered reasoning 输入及其 source；同步清除调用和测试残留。 |
| 重复提示函数、默认常量转导出 | 删除未使用的 model-form detectionFailure 及其集合，保留实际被 ModelEditor 消费的简短提示；删除无消费者的默认常量转导出。 |
| 旧 8192 魔数 | 命名为 `LEGACY_DEFAULT_MAX_OUTPUT_TOKENS`，迁移行为不变。 |
| UI 超出原方案 | 00 补 D11：简化文案和正整数限制是用户后续明确要求；Check settings 与不可用草稿保护是其最小实现细节。新增 T33–T35。 |
| 未知能力可保存 minimal | 保持 D3：能力未知时保存意图，正式请求 service-default 不发送该 effort；之后能力明确才能区分合法映射、budget 和不兼容 adaptive，后者清理并通知。未引入按协议一刀切禁词。 |
| context 不匹配去前缀别名 | 保持已批准的完整模型 id 精确匹配，现有测试明确拒绝跨 provider 前缀猜测。容量误判会影响运行预算，别名支持需另定无歧义规则。 |
| normalize 总写版本 2 | 当前函数会先拒绝显式不支持的版本，再产生当前格式。旧数字迁移仍只在 read 路径按版本缺失执行；没有吞掉未知版本的缺陷。 |
| 数值输入无障碍名为 Auto | 当前源码中 input.id 与 FieldRow label.htmlFor 正确关联，Auto 是 placeholder。补标签关联回归，未添加重复 ARIA 属性。 |

## 最小改动边界

没有拆分整个 discovery 调度器，没有抽象通用预算框架或重写 mock，没有合并所有外观相似的路由清理分支。三处行为修复复用现有字段、事件和组件。大函数、重复解析及 mock 体积作为后续可维护性议题保留。

准备阶段失败消息的持久化/展示是存量问题；composer 拦截覆盖已知预算不兼容的常见路径，不能替代后端兜底，也不宣称覆盖设置缓存尚未到达或其他准备阶段异常。

## 审查记录

子代理复审发现首版 connect 修复仍存在并发窗口：两个同时保存可以都观察到无在途任务，产生两个 GET 并取消第一个。通过 deferred fetch 复现，追加原子性修复与回归。独立复验结果为 1 个 GET 且 signal 未取消；子代理未发现剩余具体 P1/P2。证据 `/tmp/model-settings-review-concurrent-final.log`。没有用延时猜测替代调用次数和 AbortSignal 断言。

Pi 使用 `anthropic/claude-opus-5-5`、`xhigh`，会话 `codex-model-settings-followup-review-20261112`，启动目录为项目根目录。认证检查 ready，但实际审核请求及同会话重试均返回 HTTP 429 rate_limit_error，退出码 1，没有审核正文；不能记录为 Pi 审核通过。未切换模型或 provider。日志 `/tmp/model-settings-followup-pi.log`、`/tmp/model-settings-followup-pi-retry.log`。

## 验证

- 后端通知、探测复用与并发原子性最终专项：2 文件 30 项通过，核心回归先红后绿。
- 数字/偏好清理专项：4 文件 54 测试通过。
- 前端三个套件：App 199、Composer 32、数值与标签 21，共 252 项通过；关键发送与 Stop 回归先失败后通过。
- 原子性修复前的聚合专项：28 文件 506 项通过；最终修复后的结果另列，避免混用。
- 内置浏览器使用真实本地 daemon、构建产物、隔离配置/数据库和纯本地上游；未读取或复制真实 API key。16K context 配默认 32768：提示可见、Send 禁用、Enter 不发出、草稿保留。点击 Check settings 进入 Models，把输出改为 4096 保存后关闭，提示消失且 Send 恢复，草稿仍在。本次没有点击恢复后的 Send，不宣称再次验收模型生成。
- 页面证据：本地忽略目录 `.ohbaby/model-settings-implementation/review-composer-blocked.jpg` 与 `review-composer-recovered.jpg`。

最终全仓 `pnpm test` 通过：697 文件通过、6 文件跳过；8128 测试通过、17 测试跳过，233.27 秒。日志 `/tmp/model-settings-followup-full.log`。这是并发修复完成后的新结果。

最终顺序检查全部退出码 0：typecheck、lint（0 errors、125 warnings）、format:check、build。日志依次为 `/tmp/model-settings-followup-typecheck-final.log`、`/tmp/model-settings-followup-lint-final.log`、`/tmp/model-settings-followup-format-final.log`、`/tmp/model-settings-followup-build-final.log`。临时浏览器服务已停止，没有读取或复制真实凭证。上一轮四个本地提交保持不变；本轮增量修复保留在工作区，未推送。

