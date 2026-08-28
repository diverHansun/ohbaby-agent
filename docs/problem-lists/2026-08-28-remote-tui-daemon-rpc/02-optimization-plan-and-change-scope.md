# 2. 优化方案与改动面

> 推荐方案已由用户于 2026-08-28 确认；实施者按本文改动、按 04 验收。

## 2.1 方案总览

保留现有三层结构：

```text
TUI → SDK fake-RPC proxy → Server RemoteDaemonClient → HTTP JSON-RPC/SSE
```

只修 fake-RPC 调用 impl method 的 receiver：

```text
当前：method(...clonedArgs)
目标：Reflect.apply(method, impl, clonedArgs)
```

`impl` 已经是 `connectImpl()` 接入的权威实现对象；用它做 receiver 正是 JavaScript `impl.method(...)` 的等价语义。参数/result clone、错误序列化、AbortSignal out-of-band、callback 直通均保持不变。

## 2.2 设计决策

| 决策 | 选择 | 理由 | 放弃的方案 | 代价 |
|---|---|---|---|---|
| 修复层 | `ohbaby-sdk/createRPC` | bug 由通用调用边界制造，应在信息拥有处修 | server/CLI 特判 | 所有 connected impl 开始获得正确 receiver；这是兼容修正 |
| 调用方式 | `Reflect.apply(method, impl, args)` | 一处、无缓存、保留动态 method lookup；语义直白 | Kimi 式遍历原型链并预绑定 | 不提前生成 bound method map |
| remote client 形状 | 保持 class | 它需要封装连接/SSE/初始化状态，内聚合理 | arrow fields / constructor bind / facade | 无改动 |
| fake-RPC 拓扑 | local/remote 继续统一 | 维持 clone/error/abort seam 与 CLI 简单组合 | remote 跳过 fake-RPC | remote 仍有一次本地 clone 边界 |
| callback API | 不改 | 当前 Server host 用 closure 显式调用 client，未复现问题 | 顺便泛化 callback receiver | 保留一个未来若出现真实需求再处理的窄议题 |

这是可逆的内部实现修正：不改公开方法名、参数、DTO、wire、存储或配置。

## 2.3 为什么推荐 `Reflect.apply`，而不是“全部 bind”

Kimi Code 的 `bindAllFunctions` 能解决问题，但需要：

1. 遍历实例和原型链；
2. 去重 method name；
3. 决定何时缓存 bound function；
4. 处理实现对象后续 method 替换/Proxy 等边界。

ohbaby 的 `createRPC` 已经在每次调用时按 method name 动态取当前 function，因此直接带 receiver 调用更符合现有实现，改动也更窄。deepseek-harness gateway 的 `Reflect.get(receiver, method)` + `Reflect.apply(method, receiver, args)` 提供了同构参考。

## 2.4 分阶段实施

### Phase A：修正 SDK 调用语义

目标：任何合法 `API` 实现，无论是 object literal、arrow/bound function 还是 class prototype method，经 `createRPC` 后都保持原调用 receiver。

改动：

- `packages/ohbaby-sdk/src/rpc/proxy.ts`
  - 保留 method lookup 和全部 boundary 行为；
  - 调用时以 `impl` 为 receiver；
  - 不引入 binding helper、缓存或 method allowlist。
- `packages/ohbaby-sdk/src/rpc/proxy.unit.test.ts`
  - 新增 class/stateful implementation 回归；
  - 保留 clone/error/AbortSignal/callback 既有断言。

完成定义：当前最小复现转绿，SDK 全部 unit 通过，receiver test 在旧实现上稳定失败。

### Phase B：锁住 CLI + remote 组合缝

目标：测试名称和真实生产组合一致，避免各层单独绿但装配后红。

改动：

- `packages/ohbaby-cli/src/bin.unit.test.ts`
  - 至少一个 remote host fixture 的 method 必须依赖 receiver；
  - 让 terminal 真实调用 proxy method，而不是只断言 renderer 被创建。
- `tests/integration/cli/daemon-terminal.integration.test.ts`
  - 保留真实 daemon/fake LLM/fresh/continue 语义；
  - 增加或改造一条路径，使真实 `RemoteDaemonClient` 经 SDK fake-RPC seam 后再调 snapshot/prompt；
  - 名称不得继续过度宣称未经过的层。

完成定义：旧实现会因 `.rpc` receiver 错误失败；修复后 remote snapshot、prompt、event 与 dispose 通过。

### Phase C：真实 compiled TUI E2E 与文档同步

目标：最终验证 CLI 参数解析、动态加载 `ohbaby-server`、fake-RPC、Ink mount、JSON-RPC/SSE 和 cleanup 的完整链路。

验证：

1. 启动真实 daemon（随机端口、隔离数据目录、scripted/fake provider）。
2. 启动编译后的 `ohbaby --remote-host 127.0.0.1 --remote-port <port> --remote-auth-token <token>`。
3. 等待首次 snapshot；断言 UI 不出现 `.rpc`/receiver error。
4. 提交一条 prompt，等待 assistant 终态；打开 `/status` 验证一次远程读命令。
5. 正常退出 TUI 和 daemon；确认 PID/端口/临时目录无残留。

文档同步：

- `docs/ohbaby-sdk/architecture.md`：fake-RPC 调用 connected implementation 时保留 receiver。
- `docs/cli/architecture.md`：local/remote host 继续共同经过 receiver-safe fake-RPC seam。
- `docs/ohbaby-server/test.md`：remote client ↔ server 之外，增加 CLI fake-RPC ↔ real remote client 组合边界。

完成定义：自动化门通过，真实 compiled TUI E2E 有明确证据，文档不再把 direct remote client 测试等同于 remote terminal 测试。

## 2.5 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-sdk/src/rpc/` | receiver regression test | proxy 调用语义 | 无 | 唯一生产修复点 |
| `packages/ohbaby-cli/src/` | 可选新 test fixture | remote 组合 unit | 无 | 不新增 transport 分支 |
| `tests/integration/cli/` | 可选新 case/helper | daemon terminal integration | 无 | 覆盖真实跨包组合 |
| `packages/ohbaby-server/src/` | 无 | 原则上无生产改动 | 无 | remote client class 保持原状 |
| `docs/ohbaby-sdk/`、`docs/cli/`、`docs/ohbaby-server/` | 无 | 架构/测试边界 | 无 | 与实际契约同步 |

## 2.6 API、协议、迁移与兼容

- `createRPC` 函数签名不变。
- `CoreAPI` / `SDKAPI` / `UiBackendClient` 不变。
- daemon JSON-RPC/SSE 不变。
- 无数据库或配置迁移。
- object literal、arrow、bound method 兼容：显式 receiver 不改变它们的结果。
- class method 从“被错误无 receiver 调用”修正为标准 method 语义。

## 2.7 风险与回滚

| 风险 | 防御 | 回滚 |
|---|---|---|
| 某个既有 impl 意外依赖 `this === undefined` | 全量 SDK/CLI/Agent unit + contract；这不属于合理 method contract | 回滚 SDK 单行调用改动 |
| 只修 unit，真实 remote 又因装配差异失败 | Phase B 跨包 integration + Phase C compiled TUI | 不发布，保留 direct remote client 基线 |
| 顺手扩张 callback/binding framework | 代码审查按 Out of scope 拒绝 | 删除非必要抽象 |
| integration 仍绕过 CLI seam | 测试说明必须列经过的 production layers | 重写测试，不用文件名充当证据 |

## 2.8 与 00 边界对齐

- 不改 daemon wire/auth/workspace：是。
- 不改 RemoteDaemonClient 方法形状：是。
- 不为 callback 预建框架：是。
- 先讨论、后实施：是。

## 2.9 不在本批

- remote reconnect 与连接状态 UI；
- fake-RPC 性能优化或删除；
- 新 RPC method/schema；
- callback class receiver 的泛化；
- 新建通用 reflection/binding library；
- 与本错误无关的 TUI UI 改造。
