# daemon 模块 test.md

本文档说明如何验证 `runtime/daemon` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

daemon 是 bootstrap 装配根，没有独立的业务逻辑。test.md 不验证业务功能，只验证装配正确性和生命周期行为。

**覆盖**：
- 启动顺序：各模块的 start() 按正确依赖顺序被调用
- 关闭顺序：各模块的 stop() 按正确顺序被调用（与启动顺序相反）
- 关键依赖注入：各模块在 bootstrap 时收到正确的依赖（如 runManager 注册到 heartbeat）
- daemon 关闭时 taskManager.stopAll() 和 scheduler.stop() 被调用

**不覆盖**：
- 各子模块的内部业务逻辑（各自 test.md 负责）
- 完整的端到端 Run 执行流程（超出冒烟测试范围）

---

## 二、Critical Scenarios（关键场景）

| 场景 | 预期结果 |
|------|---------|
| daemon.start() | 依次完成：DB 初始化 → run-manager.initialize() → scheduler.start() → heartbeat.start()（顺序不可颠倒）|
| daemon.stop() | 依次完成：heartbeat.stop() → scheduler.stop() → taskManager.stopAll() → DB 连接关闭 |
| 某个模块 start() 抛出异常 | daemon 进入关闭流程，不留下部分初始化的状态 |

---

## 三、Integration Points（集成点测试）

daemon 的测试本质上是集成/冒烟测试：验证各模块在被装配后能协同启动和关闭。

**方式**：使用真实模块实例（in-memory SQLite、fake Bus），走完 start() → stop() 完整流程；断言无异常抛出、无资源泄漏（如 timer 不残留）

---

## 四、Verification Strategy（验证策略）

### 主策略：冒烟测试（smoke）/ 集成测试（integration），极简覆盖

**测试对象**：daemon 的 start/stop 序列

**不 mock**：scheduler、heartbeat、run-manager（需要验证真实装配）；DB 使用 in-memory SQLite

**可 mock**：Bus 发布的外部 channel 接入（不需要真实网络）

**测试数量**：2~3 个测试足够：
1. 正常 start → stop，无异常
2. start 失败（如 DB 初始化失败），不残留 timer 或打开的连接
3. stop 时 taskManager.stopAll() 确实被调用（若有 running tasks）

daemon 的 test.md 是最轻量的一份——它的价值不在于覆盖业务，而在于确认"接线是否接对了"。
