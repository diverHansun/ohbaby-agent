# ohbaby 当前接入基线

来源：当前仓库 `0bcda4846f57fb02c20f67d989297ff6225ffffd`，现有 session-export 文档和主代理源码检查。

## 已证实事实

| 主题 | 事实 | 证据 |
|---|---|---|
| 数据读取 | 不传 scope 参数返回所有上下文；显式传 `{ contextScopeId: undefined }` 才只读主上下文。 | `packages/ohbaby-agent/src/core/message/database-store.ts:701`，`listBySession` |
| 排序 | 消息按 created_at、rowid 排序；parts 按 order_index 读取。 | 同上，`:712-741` |
| compact | 原 part 标记 time.compacted，历史仍保留；摘要是独立消息。 | 同文件 `commitCompaction`；`core/message/types.ts#CommitCompactionInput` |
| 隐藏内容 | model-context 必须同时满足 text、synthetic=true、kind=model-context:runtime:v1；不能把所有 synthetic 都删除。 | `packages/ohbaby-agent/src/core/message/origin.ts:28-42` |
| UI 投影 | UI 排除 compact parts；context 摘要只显示统计提示；运行时回填会投影为 system。 | `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts:187-267` |
| 用量位置 | modelRequests 上有每次请求 usage；旧 carrier 可以是 text、tool，也可以是 model-state。 | `core/llm-client/types.ts:256-296`；`core/message/store.ts:675-694` |
| 用量语义 | reasoningTokens 是 outputTokens 的子集；totalTokens 是 inputTokens+outputTokens。未报告 usage 不等于零。 | `services/interface-providers/types.ts:55-64`；`core/llm-client/types.ts:257-259` |
| 会话元数据 | Session 有 isSubagent、status、title、projectRoot、agentName；模型在助手消息上。 | `services/session/types.ts:11-27`；`core/message/types.ts:46-57` |
| SDK | UiBackendClient 组合 Query 和 Command；现无 exportSession。 | `packages/ohbaby-sdk/src/client.ts:113,180,232` |
| 本地 RPC | 代理序列化 Error.code，接受稳定格式的大写错误码；不需要为无 signal 的新方法加 signal 映射。 | `packages/ohbaby-sdk/src/rpc/proxy.ts:14-29,50-85`；`src/error-code.ts` |
| 远程 RPC | 方法名有白名单、路由分发、客户端三个接入位置；RPC 请求体 1 MiB 限额是请求限制，不等于导出响应大小限制。 | `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts:3`；`rpc-route.ts:59,520`；`client.ts:510` |
| REST | archive 校验 token、clientId、已注册 client；读取 view/history/control 则要求当前根会话。 | `packages/ohbaby-server/src/app/create-app.ts:1455,1999`；`coordination/session-access.ts` |
| RPC 鉴权 | /api/rpc 验 token 后分发；已注册检查不是所有方法统一强制执行，不能仅新增 switch case 就认为等同 REST 注册校验。 | `packages/ohbaby-server/src/app/create-app.ts:1266-1377`；`protocols/jsonrpc/rpc-route.ts#callDaemonBackend` |
| 写入网关 | 只有 RECORDED_METHODS 中的方法会进入命令记录；普通查询透传。 | `packages/ohbaby-agent/src/host/ui-command-gateway.ts:29,178-185` |
| Web 接口实现 | BrowserDaemonClient 显式 implements UiBackendClient；http/client 两层分别负责请求和 SDK 返回值。 | `apps/ohbaby-web/src/api/daemon/client.ts:53,979`；`http.ts:332` |
| 依赖 | Web 安装 marked ^15.0.3、jsdom ^25.0.1；agent 当前未声明这两个依赖。 | `apps/ohbaby-web/package.json:15,23`；`packages/ohbaby-agent/package.json` |

表中未写包前缀的 core/services 路径均相对于 `packages/ohbaby-agent/src/`。

## 已执行验证

- 创建临时分支 `codex/session-export-backend`，起点为上述 HEAD。开始时仅 `docs/services/session-export/` 未跟踪，代码没有未提交修改。
- `pnpm typecheck` 通过。
- 五个已有测试文件共 68 项通过：database-store.integration、origin.unit、SDK rpc/proxy.unit、server jsonrpc/protocol.unit、jsonrpc/client.unit。
- 用已安装 marked 15 执行最小实验：禁用 tokenizer.html/tag 后，script、img/onerror、details 都输出为转义文字。这个实验不等于完成 HTML 安全验收。
- 执行 String.replace 最小实验：字符串 replacement 中 `$$` 变成 `$`；函数 replacement 保持 `$$`。
- Pi 模型清单没有精确的 opencode-go/gemini-4-argon。用户确认 contributor ID 后，`pi auth check --provider opencode-go --model gemini-4-argon-contributor` 返回 ready。没有读取或输出凭据。

本次没有导出实现，以上属于实施前基线，不应记为导出功能测试通过。

## 待核实

- 运行中流式片段的持久化时点，需要在实际 collector/adapter 验收中核实。现有文档的“当时已有内容”不能自动解释为所有屏幕尾部均已落库。
- JSONL token 汇总的缺失值与不完整统计尚无明确字段契约；实现时应避免把 reasoning 重复加进 total。
- 当前平台未执行 Windows/Linux 下载目录检查，且本批计划暂不实现 TUI 保存。

## 推断

- 必需 SDK 方法会要求 BrowserDaemonClient 补实现，否则 TypeScript implements 检查不满足。依据是 SDK 和 Web 的类型关系。
- 保持只读导出不经过命令记录，符合现有查询/变更分工。依据是 RECORDED_METHODS 的显式集合；这是架构判断，不是已完成的实现。
