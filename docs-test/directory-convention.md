# directory-convention.md

**测试目录组织规范**

ohbaby-agent 使用 TypeScript / Vitest。测试目录采用**混合组织**：源码旁 co-located 测试与仓库根目录集中测试并存。目录结构承载测试语义，文件名承载测试类型。

---

## 一、总规则

新增测试文件必须同时回答两个问题：

1. 它属于哪种测试类型？
2. 它属于哪个 package / module / 集成场景？

通过两种方式表达：

- 文件名后缀：`.unit.test.ts`、`.contract.test.ts`、`.integration.test.ts`、`.smoke.test.ts`
- 目录归属：源码旁目录或 `tests/<type>/<domain>/`

历史文件 `*.test.ts` 可以暂时保留；新增和大改测试应使用类型后缀。

---

## 二、co-located 测试：贴近源码的局部测试

适用于单个源码模块的 unit / contract 测试。

```text
packages/ohbaby-agent/src/
  core/llm-client/
    streaming.ts
    streaming.unit.test.ts
  core/lifecycle/
    lifecycle.ts
    lifecycle.unit.test.ts
  adapters/
    ui-inprocess.ts
    ui-inprocess.contract.test.ts

packages/ohbaby-sdk/src/
  commands/
    parser.ts
    parser.unit.test.ts

packages/ohbaby-tui/src/
  components/
    message-list.tsx
    message-list.contract.test.tsx
```

放置规则：

- 测试只关心相邻模块时，优先 co-located。
- co-located 测试不创建 `__tests__` 目录，除非同一模块测试文件很多，需要集中 fixtures。
- fixture 工厂优先放在测试文件内部；被同目录多个测试共享时，放 `test-helpers.ts`。

---

## 三、集中测试：跨模块与跨 package 场景

仓库根目录 `tests/` 用于 integration、smoke，以及跨 package 的 contract 测试。

推荐结构：

```text
tests/
  contract/
    sdk/
    adapters/
    stream/
  integration/
    core/
      core-walking-skeleton.integration.test.ts
    runtime/
      run-manager-ledger.integration.test.ts
    cli/
      prompt-stdout.integration.test.ts
  smoke/
    build.smoke.test.ts
    cli-startup.smoke.test.ts
```

集中测试的分组规则：

- `tests/unit/<domain>/`：仅用于无法自然 co-locate 的跨 package 纯逻辑测试；普通单模块 unit 测试优先放源码旁。
- `tests/integration/core/`：core 内部或 core + adapter 的主链路。
- `tests/integration/runtime/`：run-manager、ledger、stream-bridge、scheduler 等 runtime 协作。
- `tests/integration/cli/`：CLI composition root、stdin/stdout、进程级行为。
- `tests/contract/sdk/`：SDK 对外 DTO / parser / client 契约。
- `tests/contract/adapters/`：backend adapter 对 SDK 的契约。
- `tests/contract/stream/`：stream event / gap / snapshot cursor 契约。

不要把所有跨模块测试堆在 `tests/integration/` 根目录；必须至少按 domain 分组。

---

## 四、命名规范

文件名格式：

```text
<subject>.<type>.test.ts
<subject>.<type>.test.tsx
```

示例：

- `lifecycle.unit.test.ts`
- `message-converter.unit.test.ts`
- `ui-inprocess.contract.test.ts`
- `core-walking-skeleton.integration.test.ts`
- `cli-startup.smoke.test.ts`

测试用例命名使用 Vitest 风格，描述行为而非实现细节：

```typescript
it('publishes assistant message deltas while the model streams', async () => {
  ...
})
```

---

## 五、fixtures 与 helpers

没有 pytest 的 `conftest.py`。TypeScript/Vitest 下使用显式导入：

```text
packages/ohbaby-agent/src/core/lifecycle/
  lifecycle.unit.test.ts
  test-helpers.ts

tests/integration/core/
  core-walking-skeleton.integration.test.ts
  fixtures.ts
```

规则：

- fixture/helper 放在使用它的最小公共目录。
- 只被一个测试文件使用的 helper，直接放在该测试文件中。
- 共享 helper 必须命名具体，例如 `createFakeStreamingProvider()`，不要做万能 `test-utils.ts`。
- `tests/helpers/` 只用于真正跨多个测试类型共享的极少数工具，例如 async iterator 收集函数。

---

## 六、新增测试文件决策流程

1. 按 `classification.md` 判断测试类型。
2. 判断范围：
   - 单模块局部测试 → co-located。
   - 跨模块或跨 package → `tests/<type>/<domain>/`。
   - smoke → `tests/smoke/`。
3. 使用类型后缀命名测试文件。
4. 将 helper 放在最小公共目录。
5. 用精确命令运行新增测试，确认失败/通过过程。

---

## 七、Vitest include 约定

Vitest 应同时包含：

```text
packages/*/src/**/*.test.ts
packages/*/src/**/*.test.tsx
tests/**/*.test.ts
tests/**/*.test.tsx
```

因此 co-located 测试和集中测试都应可由 `pnpm test` 发现。

---

## 八、目录维护

- 模块移动时，同步移动 co-located 测试。
- 集中测试的 domain 目录要随架构演进调整，不保留空目录。
- 如果某个集中测试实际只验证单模块纯逻辑，应下沉到源码旁。
- 如果某个 co-located 测试开始串联多个 package，应上移到 `tests/integration/<domain>/`。
