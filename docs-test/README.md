# docs-test

**ohbaby-agent 项目级测试方法论**

本目录定义 ohbaby-agent 的测试决策规则。项目是 TypeScript / pnpm / Vitest monorepo，主要代码位于 `packages/`，因此测试规范采用**混合组织**：

- 模块局部的 unit / contract 测试可以与源码 co-located。
- 跨模块、跨 package、端到端骨架类测试集中放在仓库根目录 `tests/`。
- 无论放在哪里，测试文件都必须通过命名和目录表达测试类型与所属模块，避免堆成一个“大杂烩”目录。

---

## 一、定位与职责

`docs-test/` 回答四个问题：

- 写了一个测试，它属于 unit / contract / integration / smoke 中的哪一种？
- 新增测试文件时，应放在源码旁边，还是放在根目录 `tests/`？
- 一个依赖应该 mock、fake、stub，还是使用真实实现？
- 本地开发和 CI 分别应该跑哪些测试？

模块自己的 `docs/**/test.md` 描述“该模块应该测什么”；本目录描述“项目里测试怎么分类、怎么命名、怎么摆放、怎么执行”。

---

## 二、核心原则

### 1. 测试目标是建立信心，不是追求覆盖率

优先测试失败代价最高的路径：LLM 流式事件累积、Lifecycle 循环退出条件、Message/Part 顺序、ToolScheduler 状态机、SDK/TUI 协议契约、Runtime 的 Run/Stream 控制面。

### 2. 测试类型服从模块性质

纯逻辑模块以 unit 为主；SDK/adapter/stream 协议以 contract 为主；core walking skeleton、message + lifecycle + adapter 这类真实协作以 integration 为主；CLI 启动、构建产物、数据库迁移可用性属于 smoke。

### 3. Mock 边界由测试类型决定

“mock 更方便”不是理由。unit 测试 mock 直接依赖；contract 测试 mock 接口之下的业务层；integration 尽量使用真实组件，只 mock LLM API、外部网络、计费服务等不可控依赖。

### 4. 测试位置必须显式维护

ohbaby-agent 允许 co-located 与集中式测试并存，但不允许模糊命名。测试文件名必须包含测试类型：

- `*.unit.test.ts`
- `*.contract.test.ts`
- `*.integration.test.ts`
- `*.smoke.test.ts`

历史文件 `*.test.ts` 可以暂时保留，但新增测试应使用类型后缀。

### 5. 测试是设计的延伸

模块文档的 `test.md` 在实现前就应该指导测试设计。实现阶段先写能失败的测试，再写最小实现；文档、测试、代码共同定义模块契约。

---

## 三、推荐目录

```text
packages/
  ohbaby-agent/src/
    core/lifecycle/lifecycle.unit.test.ts
    adapters/ui-inprocess.contract.test.ts
  ohbaby-sdk/src/
    commands/parse-slash-input.unit.test.ts
  ohbaby-tui/src/
    components/message-list.contract.test.tsx

tests/
  contract/
    sdk/
    adapters/
    stream/
  integration/
    core/
    runtime/
    cli/
  smoke/
    build.smoke.test.ts
    cli-startup.smoke.test.ts
```

放置原则：

- 单个源码文件或模块的 unit/contract 测试，优先 co-located。
- 根 `tests/unit/` 只用于无法自然 co-locate 的跨 package 纯逻辑测试。
- 跨两个以上模块或 package 的测试，放 `tests/integration/<domain>/`。
- 面向外部消费者的协议契约测试，若只测单个 adapter 可 co-located；若涉及 SDK + adapter + stream，放 `tests/contract/<domain>/`。
- smoke 测试集中放 `tests/smoke/`。

---

## 四、文档索引

| 文档 | 回答的问题 |
|------|----------|
| `classification.md` | 测试有哪几种类型？如何判定归属？ |
| `directory-convention.md` | 测试文件放在哪里？命名和目录怎么组织？ |
| `writing-guide.md` | mock/fake 边界、fixture/工厂、断言怎么写？ |
| `ci-strategy.md` | 本地与 CI 跑哪些 Vitest 命令？ |

---

## 五、适用范围

本方法论适用于 ohbaby-agent 仓库内所有 TypeScript 测试代码，包括：

- `packages/ohbaby-agent`
- `packages/ohbaby-sdk`
- `packages/ohbaby-tui`
- 仓库根目录 `tests/`

非 TypeScript 辅助脚本如未来出现，应遵循相同分类原则，但可按对应语言生态调整执行方式。
