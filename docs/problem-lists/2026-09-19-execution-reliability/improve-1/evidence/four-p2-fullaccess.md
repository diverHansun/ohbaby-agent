# 四项 P2 收尾：FullAccess 不遗留目录信任

基线：`5e84e539`。范围：tool scheduler 的外部写入及 shell preflight。

## 根因与修复

`confirmExternalWritePermission` 和 `confirmExternalPreflightPermissions` 将所有 `allow` 都转换成环境 `trustPath`。FullAccess 的临时自动放行也进入该分支，导致切回 default 后，先前目录内的读取无需再确认。此前一个单元测试还将这种副作用当作正确行为。

两个分支现在均使用与 `evaluatePermission` 相同的状态快照：FullAccess 只授权当前调用，不新增目录信任；default 下显式 session allow 和用户选择 always 的原有信任行为保留。快照避免权限等级在异步等待后发生变化时，错误地将 FullAccess 决策记为持久信任。已存在的可信目录和规则不被清除。

## 回归证据

新增两例使用真实 HostLocal SandboxLease、真实目录和内置工具：分别由 `write` 与 `bash` 在 FullAccess 下成功写入外部文件；切回 default 后，读取原文件与向同目录写新文件均需确认。拒绝后原文件不变、新文件不存在，环境只剩原 workspace root，session rules 为空。

- RED：`/tmp/ohbaby-four-p2-fullaccess-red.log`。两例均在降级后的读取处失败，实际 `success`，期望 `rejected`；证明旧代码留下了信任。
- GREEN：`/tmp/ohbaby-four-p2-fullaccess-green.log`。scheduler 61、files scheduler integration 9、permission evaluator 25、sandbox path boundary integration 5，合计 **100 项通过 / 4 个文件**。
- 已保留 always / once / 已有可信目录的测试；原 auto-allow 信任用例改成 default + 显式 session allow，验证应保留的信任语义。

命令：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts packages/ohbaby-agent/src/tools/files.scheduler.integration.test.ts packages/ohbaby-agent/src/permission/evaluator.unit.test.ts packages/ohbaby-agent/src/sandbox/path-boundary.integration.test.ts
pnpm exec eslint packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts
```

本项不迁移运行中已经遗留的 trust roots，因为现有存储未区分其授权来源，直接清除会损坏用户显式授权。新运行从源头阻止 FullAccess 创建这类信任。
