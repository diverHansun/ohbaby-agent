# 四个 P2 收尾：Web 记忆会话恢复

## 根因与修复

审查基线为 `5e84e539`。`connect()` 为了让权限订阅独立于 history/model，改为后台刷新普通视图；但 workspace 初始化仍立即从 `view.snapshot.sessions` 判断记忆会话是否存在。真实 HTTP 的历史查询尚未返回时，snapshot 为 null，恢复直接跳过。随后默认 root 的历史快照经 store subscription 写回 localStorage，把原本的记忆会话覆盖。

保留权限独立恢复边界，修复内容：

- 在连接前捕获本 workspace 的记忆会话；恢复仅依赖轻量 session index 与当前 live binding，不等待 history/model。
- 显式 bootstrap resume/fresh 优先；缺失或 child metadata 不触发主会话恢复。
- 恢复期间暂停写入记忆值；用户 create/select 与 `/new`、`/resume` 推进选择代数，使迟到的恢复不能覆盖用户选择。
- 持久化优先使用 live binding。若旧 history 查询在切换后才返回，丢弃该次投影，重新读取当前 binding 对应的视图；这同时修复了 pending resync 合并掉切换刷新后只剩旧会话视图的问题。
- 恢复 metadata 失败不会关闭已连接 SSE。保留原记忆偏好，直到用户显式选会话或下次重新启动/切换 workspace；仍使用现有错误展示与权限同步的独立重试机制。没有为导航另加无界重试。

## 回归证据

新增 `apps/ohbaby-web/src/api/daemon/session-restore.integration.test.ts`，实例化真实 `createOhbabyWebRuntime`、HTTP client、SSE reader、permission sync 和 store；仅用可控 fetch 替代外部 HTTP。测试共 8 项：

1. history/model 一直 pending 时完成记忆会话恢复且 permission ready；旧 history 放行后 UI 和记忆值仍指向恢复会话。
2. 显式 startup resume 优先。
3. 显式 startup fresh 优先。
4. 记忆 child 不作为主 root 选择。
5. 已删除的记忆会话跳过，保留 live transport。
6. metadata 失败仍保留 live transport 和原偏好；后续显式选择可以更新偏好。
7. metadata pending 时用户 `/new` 不被后续自动恢复覆盖。
8. metadata pending 时用户选会话不被覆盖，迟到历史亦不覆盖视图和偏好。

先运行失败测试，再修改生产代码：

- `/tmp/ohbaby-four-p2-web-red.log`：4 项中 2 项失败；分别得到 `default` 而不是 `remembered`、旧 history 最终仍为 `default` 而不是用户选择的 `explicit`。
- `/tmp/ohbaby-four-p2-web-edge-red.log`：child 被错误选中、metadata failure 使 runtime.ready 拒绝，2 项失败。
- `/tmp/ohbaby-four-p2-web-slash-red.log`：`/new` 后实际绑定被改回 `remembered`，1 项失败。
- `/tmp/ohbaby-four-p2-web-persist-red.log`：加入 metadata failure 下保留偏好的断言，证明默认 root 会错误覆盖偏好。

最终定向验证：

```sh
pnpm exec vitest run apps/ohbaby-web/src/api/daemon apps/ohbaby-web/src/store
pnpm exec eslint apps/ohbaby-web/src/api/daemon/client.ts apps/ohbaby-web/src/api/daemon/session-restore.integration.test.ts
```

`/tmp/ohbaby-four-p2-web-broad.log`：**9 个文件、64 项测试全部通过**；两个文件 ESLint 无 warning/error。测试覆盖真实 runtime 组合和可控异步顺序，不将其宣称为真实浏览器/真实 LLM 验证。完整 build、全量测试与收尾记录由主代理统一执行。
