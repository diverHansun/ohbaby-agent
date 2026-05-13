# ci-strategy.md

**Vitest 执行策略**

本文档定义 ohbaby-agent 在本地开发和 CI 中如何执行测试。项目使用 pnpm + Vitest + TypeScript。

---

## 一、测试发现范围

Vitest 应发现以下测试：

```text
packages/*/src/**/*.test.ts
packages/*/src/**/*.test.tsx
tests/**/*.test.ts
tests/**/*.test.tsx
```

文件名后缀用于表达测试类型：

| 后缀 | 含义 |
|------|------|
| `.unit.test.ts(x)` | 单元测试 |
| `.contract.test.ts(x)` | 契约测试 |
| `.integration.test.ts(x)` | 集成测试 |
| `.smoke.test.ts(x)` | 冒烟测试 |

历史 `*.test.ts` 文件可被发现，但新增测试必须使用类型后缀。迁移完成前，CI 仍应保留 `pnpm test` 作为兜底，避免旧测试被类型化脚本漏跑。

---

## 二、本地开发命令

```bash
# 运行全部测试
pnpm test

# 运行单个测试文件
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts

# 运行当前 in-process adapter 契约测试
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts

# 运行所有 unit 测试（真实枚举文件后运行）
pnpm test:unit

# 运行所有 contract 测试
pnpm test:contract

# 运行所有 integration 测试
pnpm test:integration
```

Vitest 2.1.x 不支持 `--include` CLI 参数，且 glob positional 参数会被当成 filter。根脚本通过 `scripts/run-vitest-by-type.mjs` 先枚举真实文件，再把精确路径传给 Vitest。

---

## 三、当前 package scripts

根 `package.json` 已提供：

```json
{
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:unit": "node scripts/run-vitest-by-type.mjs unit",
    "test:contract": "node scripts/run-vitest-by-type.mjs contract",
    "test:integration": "node scripts/run-vitest-by-type.mjs integration",
    "test:smoke": "node scripts/run-vitest-by-type.mjs smoke"
  }
}
```

当某类测试暂时没有文件时，分类脚本输出 `No <type> test files found.` 并成功退出；一旦该类型已有文件，脚本会运行真实文件路径，不会被 Vitest filter 语义静默跳过。

---

## 四、CI 阶段

| 阶段 | 执行范围 | 目标 |
|------|----------|------|
| 本地开发 | 当前修改相关测试文件 | 快速反馈 |
| 提交前 | format:check + lint + typecheck + test + unit + contract | 防止旧测试、局部逻辑和协议破坏 |
| PR 检查 | preflight + integration | 验证跨模块协作 |
| 合并前 | unit + contract + integration + build | 保证主分支可工作 |
| 发布/部署前 | smoke | 验证启动、构建、迁移等环境能力 |

当前根脚本 `pnpm preflight` 已包含 format、lint、typecheck、test、build。随着测试规模增长，可以将 `test` 拆分为更细粒度脚本。

---

## 五、执行速度预算

| 类型 | 单文件目标 | suite 目标 |
|------|------------|------------|
| unit | 3 秒内 | 30 秒内 |
| contract | 5 秒内 | 60 秒内 |
| integration | 30 秒内 | 5 分钟内 |
| smoke | 视环境而定 | 视环境而定 |

如果 unit 测试变慢，通常说明它引入了真实 I/O 或过多装配，应重新分类或拆分。

---

## 六、外部 API 与慢测试

常规 CI 不应调用真实 LLM API。需要真实 API 的测试必须：

- 通过环境变量显式启用。
- 在没有密钥时自动 skip。
- 在文件顶部注释说明依赖。

慢测试应集中放在 integration 或 smoke 下，并避免成为日常开发的默认阻塞项，除非它覆盖的是核心高风险路径。

---

## 七、失败处理

- unit / contract 失败：阻断提交。
- integration 失败：阻断合并。
- smoke 失败：阻断发布或环境变更。

任何失败都应优先判断是测试分类错误、mock 边界错误，还是实现确实破坏了契约。
