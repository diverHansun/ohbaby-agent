# classification.md

**测试分类标准**

本文档定义 ohbaby-agent 的测试分类体系。每个测试文件必须归属于以下四类之一，并在文件名中体现类型：`*.unit.test.ts`、`*.contract.test.ts`、`*.integration.test.ts`、`*.smoke.test.ts`。

---

## 一、分类总览

| 类型 | 关键词 | 回答的质量问题 | 文件名后缀 |
|------|--------|----------------|------------|
| unit | 隔离、纯逻辑、mock 直接依赖 | 这个函数、类或模块的局部逻辑正确吗？ | `.unit.test.ts` |
| contract | 接口边界、格式约定、协议稳定 | 消费者看到的接口契约稳定吗？ | `.contract.test.ts` |
| integration | 真实协作、组件串联 | 多个真实组件一起工作时行为正确吗？ | `.integration.test.ts` |
| smoke | 基础设施、启动、构建、环境 | 项目能在目标环境中启动或构建吗？ | `.smoke.test.ts` |

---

## 二、各类型定义

### 1. unit -- 单元测试

**定义**：在隔离环境中验证单个函数、类或模块的内部逻辑。

**特征**：

- 不访问真实网络、真实 LLM API、真实外部进程。
- 直接依赖使用 mock、stub 或 fake。
- 执行速度应很快，适合频繁运行。
- 失败时应能定位到具体逻辑错误。

**典型对象**：

- `core/message` 的 factory、converter、id-generator。
- `core/lifecycle` 的退出条件、并发状态管理。
- `runtime/stream-bridge` 的 RingBuffer、ReplayPlan。
- `runtime/scheduler` 的 heap 和 next fire time 计算。
- `config/llm` 的配置校验。

**判定标准**：如果只验证一个被测单元，且所有外部依赖都被替换，则它是 unit。

### 2. contract -- 契约测试

**定义**：验证模块对外暴露的接口、事件、DTO、adapter 协议在格式和语义上符合约定。

**特征**：

- 关注输入/输出结构、事件顺序、错误形态，而不是内部计算过程。
- 被测接口之下的业务层通常被 mock 或 fake。
- 保留接口层本身真实执行。

**典型对象**：

- `ohbaby-sdk` 的 `UiBackendClient`、`UiEvent`、command parser。
- `adapters/ui-inprocess` 对 SDK 方法的事件承诺。
- `runtime/stream-bridge` 的 `StreamEvent` 与 `stream.gap` 协议。
- CLI stdout event sink 的输出格式。

**判定标准**：如果测试主要断言“消费者传入 X，会看到 Y 结构/事件/错误”，它是 contract。

### 3. integration -- 集成测试

**定义**：验证两个或以上真实组件协作时的行为。

**特征**：

- 至少两个组件使用真实实现。
- 可使用真实文件系统临时目录、真实内存 store、真实 SQLite 测试库。
- 只 mock 不可控外部依赖，如 LLM API、外部网络、计费服务。
- 文件名或目录名应清楚说明集成了哪些模块。

**典型对象**：

- Core Walking Skeleton：`UiBackendClient.submitPrompt -> Lifecycle -> llm-client fake provider -> UiEvent`。
- `MessageManager + SQLite store`。
- `RunManager + RunLedger + StreamBridge`。
- CLI 非交互路径：argv/stdin -> backend adapter -> stdout renderer。

**判定标准**：如果测试验证真实组件之间的数据流、调用顺序或状态协作，它是 integration。

### 4. smoke -- 冒烟测试

**定义**：验证环境、构建、启动和基础设施是否可用，不深入验证业务逻辑。

**特征**：

- 关注“能否启动/构建/加载”，不是“功能是否完全正确”。
- 可运行 CLI `--help`、package build、数据库迁移可执行性。
- 通常集中放 `tests/smoke/`。

**典型对象**：

- `pnpm build` 能生成包。
- `ohbaby --help` 正常退出。
- 数据库初始化脚本可执行且幂等。
- package exports 可被 Node 解析。

---

## 三、分类决策流程

```text
是否验证启动、构建、迁移、环境可用性？
  ├─ 是 → smoke
  └─ 否
     是否验证消费者可见的协议/DTO/事件/输出格式？
       ├─ 是 → contract
       └─ 否
          是否有两个或以上真实组件协作？
            ├─ 是 → integration
            └─ 否 → unit
```

---

## 四、边界情况

### 混合特征测试

一个文件只属于一种基础类型。若同一场景既需要 unit 又需要 contract，拆成两个文件，例如：

- `ui-inprocess.contract.test.ts`
- `ui-inprocess.unit.test.ts`

### 需要真实外部 API

默认禁止在常规测试中调用真实 LLM API。确需真实 API 的验证应：

- 文件名保留基础类型，如 `.integration.test.ts`。
- 使用 `describe.skipIf(!process.env.XYZ_API_KEY)` 或等价条件跳过。
- 在文件顶部注释说明需要的环境变量。

### 慢测试

超过 10 秒的测试应单独隔离，优先放到 `tests/integration/` 或 `tests/smoke/`，并在文件名或 `describe` 中说明慢的原因。日常 preflight 不应依赖不可控慢测试。

---

## 五、模块原型映射

| 模块原型 | 主要测试类型 | 次要测试类型 |
|----------|--------------|--------------|
| 纯逻辑模块 | unit | - |
| 服务编排模块 | unit | integration |
| 桥接/适配模块 | contract | unit |
| 基础设施模块 | smoke | integration |
| 外部依赖封装模块 | unit | contract |

具体模块仍以该模块 `docs/**/test.md` 的测试策略为准。
