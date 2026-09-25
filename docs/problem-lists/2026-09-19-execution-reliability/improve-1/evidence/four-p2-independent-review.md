# 四项 P2 收尾：独立复审

评审基线：`5e84e539`。评审对象为本轮未提交修改，范围是用户截图指出的 FullAccess 目录信任、Web 记忆会话恢复、TUI 元数据重试及失败后的查询取消。由独立 review 子代理只读检查生产代码与测试；本代理只写本证据，不改实现、不运行 Pi。

## FullAccess 目录信任

独立追查 scheduler 所有 `trustPath` 调用。自动 allow 只有 shell preflight 和外部 write 两个入口会写信任，现均由参与本次 evaluate 的同一 `permissionSnapshot.level` 保护。`getState()` 返回值快照，因此异步等待后等级变化不会把 FullAccess 决策记成 default 信任。外部 read 的 allow 分支原本不写 trust，不存在第三处遗漏。

用户显式 always 的回调保持不变；default 中显式 session allow 仍可记住目录。新测试使用真实 sandbox 和内置 write/bash，验证临时放行、回到 default、读写拒绝后的实际文件状态和 trusted roots；旧测试把 FullAccess 信任当成正常行为的断言也已纠正。本项无剩余可确认问题。

## TUI 重试与取消

独立核对 bootstrap 的每条退出路径：每次 attempt 单独调用 `getSessionIndex()`；metadata 拒绝或 snapshot 拒绝都会使本次 Promise.all 退出，finally 主动 abort snapshot signal；正常完成、非法 root、卸载或被连接事件取代同样释放本次 controller。引用相等检查避免旧 attempt 清除新 controller。

四次预算、每次 10 秒超时及 100/250/500 ms 间隔保持原值。旧 scope 的完成结果仍经过 disposed/engine 检查，`PERMISSION_UNAVAILABLE` 不自动重试，显式 retry 也保持禁用。本次新增测试在后继 snapshot 开始前检查所有旧 signal 已 aborted，并覆盖 unavailable 的首次即终止。成功返回的旧 metadata 也不跨失败的 snapshot attempt 复用。本项无剩余可确认问题。

## Web 恢复

初次读审确认：提前捕获 remembered id，避免 connect 期间写入默认 root；恢复只等轻量 index，不依赖 history/model；显式 resume/fresh 优先；手动选会话和创建会话有 generation 防过期覆盖。history 请求中的 binding fence 使用 epoch/root/generation 整体比较，因此跨根和 ABA 均需重取，不会提交前一选择的历史。

复审补充发现的两条边界已由实现代理复现并修复，再经本代理独立核对：

- 恢复 index 失败不再让 workspace rollback 或关闭 SSE；保留原 remembered preference，直到明确的后续用户选择。失败处理也检查 client identity、disposed 和 selection generation，避免旧请求重新保护已被用户替换的偏好。
- pending index 后执行 slash `/new` 或 `/resume` 同样推进 selection generation；随后返回的自动恢复不会覆盖用户决定。新 `/new` 用例在真实 Web runtime + SSE fixture 下验证最终 selected id 和没有补发 remembered select。
- remembered id 若已删除或属于 child session，不发起选择，保持当前 live root。旧 history 在选择完成后返回，需根据新 binding 重新请求，最终不能把默认 root 写回导航记忆。

最终代码读审和定向验证中，没有剩余可确认的 P0/P1/P2。结论仅覆盖本轮四项修复及其直接异步边界，不等价于证明整个系统没有其他问题。

## 独立执行的检查

```sh
pnpm exec vitest run packages/ohbaby-cli/src/tui/use-permission-sync.unit.test.tsx packages/ohbaby-sdk/src/permission-sync.unit.test.ts packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts apps/ohbaby-web/src/api/daemon/session-restore.integration.test.ts
```

首次独立执行：**88 项通过 / 4 个文件**，日志 `/tmp/ohbaby-four-p2-review-focused.log`。其中 TUI hook 4、SDK 恢复 19、scheduler 61、Web 恢复 4。

Web 补充修复落地后，按上面命令再加入 `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts` 独立重跑：**99 项通过 / 5 个文件**，其中 Web 恢复增加至 8 项，workspace switch 7 项。日志 `/tmp/ohbaby-four-p2-review-final.log`，进程退出码 0。

未把两次重复测试相加为覆盖量，也不以此定向结果替代主代理最终全量测试、构建或真实浏览器验收。
