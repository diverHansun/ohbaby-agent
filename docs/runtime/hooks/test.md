# hooks 模块 test.md

本文档说明如何验证 `runtime/hooks` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- register(point, fn)：在指定 hook point 注册 hook 函数
- execute(point, ctx)：串行执行指定 point 的所有 hook
- 单个 hook 失败不中断链（记录日志，继续下一个）
- 多个 hook 的执行顺序（按注册顺序）
- 三个 hook point（pre-run / post-run / on-wake）的独立性

**不覆盖**：
- 各内置 hook 工厂函数的业务逻辑（如 createMemoryInjectHook，属于 memory 模块的依赖行为）
- daemon/bootstrap 中的 hook 注册顺序（bootstrap 层的职责）

---

## 二、Critical Scenarios（关键场景）

| 场景 | 预期结果 |
|------|---------|
| 注册 3 个 hook，execute(point, ctx) | 3 个 hook 按注册顺序串行执行 |
| 第 2 个 hook 抛出异常 | 第 1 个已执行；第 2 个异常被捕获记录日志；第 3 个正常执行 |
| execute(point) 无注册 hook | 正常返回，不报错 |
| pre-run 和 post-run 独立 | 注册在 pre-run 的 hook 不出现在 post-run 执行链中 |
| hook fn 是 async 函数 | await 执行，不跳过 |

---

## 三、Integration Points（集成点测试）

hooks 是纯执行容器，无外部 I/O 依赖。无需集成测试。

---

## 四、Verification Strategy（验证策略）

### 主策略：纯单元测试（unit）

**测试对象**：HookExecutor（register / execute）

**Mock 范围**：无需 mock；hook fn 使用 spy 函数（jest.fn() 或 sinon.spy）

**测试用例组织**：
- `TestHookExecutor_Execute`：顺序执行、失败隔离、async 支持
- `TestHookExecutor_Register`：同 point 多次注册、不同 point 独立

执行顺序断言：在各 hook fn 内部记录调用时间戳或顺序 index，断言 index 单调递增。
