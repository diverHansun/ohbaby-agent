# 04 · 测试与验收标准

> CLI 模块改进 · 验证篇  
> 日期: 2026-05-30  

---

## 1. 编译验收

全量 TypeScript 编译通过，零类型错误：

| 检查项 | 命令 | 预期结果 |
|--------|------|----------|
| SDK 包编译 | `pnpm --filter ohbaby-sdk build` | 零错误 |
| Agent 包（后端）编译 | `pnpm --filter ohbaby-agent build` | 零错误 |
| CLI 前端包编译 | `pnpm --filter ohbaby-cli build` | 零错误 |

> 迁移后入口为**动态 import 已删除**，模块解析改为静态依赖。但"编译通过 ≠ 运行通过"仍要警惕——必须执行 §5 手动端到端（真实启动 `ohbaby`）。
>
> ⚠️ `tests/integration/cli/packaging-smoke.integration.test.ts` 不是"保持通过"，而是**需要重写**：它当前硬编码旧拓扑（bin 属 `ohbaby-agent`、手写 `--help` 文案、`-p/--prompt`、agent 版本号），yargs + bin 迁移后这些断言全部失效。重写范围见 [05 §5 行 12](./05-cli-module-migration.md)。`tests/integration/cli/prompt-process.integration.test.ts` 同理（spawn bin、旧 `-p` 行为）需按 `run` 子命令调整。

---

## 2. 单元测试验收

### 2.1 测试文件清单

| 测试文件 | 改动 | 预期 |
|----------|------|------|
| `sdk/src/rpc/proxy.unit.test.ts` | **新增**：测试 createRPC 序列化边界 | 全部通过 |
| `agent/src/cli/args.unit.test.ts` | **删除**（args.ts 被 yargs 替代） | — |
| `agent/src/bin.unit.test.ts` | **删除**（bin.ts 迁出到 `ohbaby-cli`；yargs 入口由 §3 验收覆盖） | — |
| `cli/src/tui/app.contract.test.tsx` | 微调：mock CoreAPI 替代 TuiBackendClient | 全部通过 |
| `cli/src/tui/store/events.unit.test.ts` | 不变 | 全部通过 |
| `cli/src/tui/command/runtime.unit.test.ts` | 不变（commands 改进中已处理） | 全部通过 |
| `tests/integration/tui/main-chain.integration.test.tsx` | 微调：mock CoreAPI 替代 TuiBackendClient | 全部通过 |

> 迁移会移动 `bin`/`cli` 并翻转依赖，连带影响 `tsconfig`（项目引用 + path 映射）、`tsup.config.ts`（external 列表）、`vitest.config.ts` / `vitest.e2e.config.ts`（alias + react 解析路径）等构建配置——完整影响面与逐项验收见 [05 CLI 模块迁移](./05-cli-module-migration.md) 的"影响面"与"验证清单"。

### 2.2 新增 proxy.unit.test.ts

```typescript
describe("createRPC", () => {
  it("serializes and deserializes across the boundary", async () => {
    // 验证 JSON 序列化边界生效
  });

  it("proxies errors from impl to caller", async () => {
    // 验证后端异常在前端重新抛出
  });

  it("supports abort via AbortSignal", async () => {
    // 验证取消正在进行的调用
  });
});
```

---

## 3. CLI 入口验收

### 3.1 yargs 命令验收

- [ ] `ohbaby --help` — 输出正确的帮助信息（yargs 自动生成）
- [ ] `ohbaby --version` — 输出版本号
- [ ] `ohbaby` — 启动 TUI 交互模式（默认 `$0` 子命令）
- [ ] `ohbaby --mode plan` — 启动 TUI，初始权限模式为 plan
- [ ] `ohbaby --permission full-access` — 启动 TUI，初始权限级别为 full-access
- [ ] `ohbaby run "hello world"` — 非交互模式发送 prompt
- [ ] `ohbaby run`（TTY 无 stdin）— 报 usage error，不启动后端
- [ ] `echo "hello" | ohbaby run` — 管道输入
- [ ] `ohbaby run --mode auto "hello"` — 非交互模式 + 权限选项
- [ ] `ohbaby serve` — 输出 "not yet implemented" 并退出
- [ ] `ohbaby invalid-command` — yargs strict 模式报错
- [ ] `ohbaby --invalid-flag` — 未知选项，yargs 报错 + 显示帮助

### 3.2 兼容性验收

- [ ] 旧的 `ohbaby -p "hello"` 语法不再支持（改为 `ohbaby run "hello"`）— 报清晰错误
- [ ] 旧的 `ohbaby -h` 语法仍然支持（yargs 自动 alias）

---

## 4. RPC 通信验收

### 4.1 CoreAPI 方法验收

- [ ] `core.getSnapshot()` — 返回正确的初始化快照
- [ ] `core.submitPrompt("hello")` — prompt 被提交，事件通过 `subscribeEvents` 到达
- [ ] `core.executeCommand({ commandId: "status", ... })` — 命令被执行，结果通过事件到达
- [ ] `core.listCommands({ surface: "tui" })` — 返回 commands 分支确认后的 9 条可见命令
- [ ] `core.respondPermission(requestId, response)` — 权限请求被应答
- [ ] `core.abortRun()` — 运行被中止
- [ ] `core.compactSession()` — session compact 被触发

### 4.2 序列化边界验收

- [ ] RPC 方法调用确实经过 JSON 序列化（修改传入的对象引用不影响后端状态）
- [ ] 后端抛出的异常在前端作为 Error 重新抛出（不是字符串）
- [ ] `subscribeEvents` 回调在前端事件循环中执行（不被 RPC 包装）

---

## 5. 手动验收清单（端到端）

### 5.1 TUI 交互模式

- [ ] 启动 TUI：`ohbaby` — 进入交互界面，无报错
- [ ] 输入 prompt：输入文字 + Enter — prompt 被提交，流式输出正常
- [ ] 输入 `/models` — 命令被解析执行，结果显示当前单活动模型摘要
- [ ] 输入 `/exit` — 退出
- [ ] Ctrl+C — 中断正在运行的 prompt

### 5.2 非交互模式

- [ ] `ohbaby run "what is 2+2"` — 流式输出答案到 stdout
- [ ] `ohbaby run "/models"` — 暂不作为命令执行；`run` 子命令只提交 prompt，启动后的 slash command 仍由 TUI/SDK resolver 处理
- [ ] `echo "hello" | ohbaby run` — 管道输入正常工作
- [ ] `echo "" | ohbaby run` — 空管道输入报 usage error，不启动后端

---

## 6. 回归验收

- [ ] 权限弹窗不受影响（TUI 中正常弹出和操作）
- [ ] Session 切换不受影响
- [ ] MCP 工具正常工作
- [ ] Skill 命令正常工作
- [ ] `stdout-renderer` 的 5 种事件类型渲染正常

---

## 7. 审查标准（grep 检查）

| # | 检查项 | 命令 | 含义 |
|---|--------|------|------|
| 1 | 无 `parseCliArgs` 残留 | `rg "parseCliArgs" packages/` | 手写 parser 已删除 |
| 2 | 无 `renderHelp` 残留 | `rg "renderHelp" packages/` | 帮助文本由 yargs 自动生成 |
| 3 | 无 `CliArgumentError` 残留 | `rg "CliArgumentError" packages/` | 参数错误由 yargs 处理 |
| 4 | CoreAPI 方法被 yargs handler 使用 | `rg -e "core\.submitPrompt" -e "core\.executeCommand" -e "core\.listCommands" packages/ohbaby-cli/src/cli/commands/` | 确认前端 subcommand handler 通过 CoreAPI 通信 |
| 5 | ohbaby-cli 无 TuiBackendClient 引用 | `rg "TuiBackendClient" packages/ohbaby-cli/src/` | TUI 不再依赖旧接口 |
| 6 | SDK 导出 createRPC | `rg "createRPC" packages/ohbaby-sdk/src/index.ts` | RPC 工具对 CLI 可用（Phase 1 完成后生效） |
| 7 | CoreAPI 类型在 SDK 中定义 | `rg "export interface CoreAPI" packages/ohbaby-sdk/src/` | 契约在 SDK 层（Phase 1 完成后生效） |
| 8 | 依赖方向已翻转 | `rg "ohbaby-cli" packages/ohbaby-agent/package.json` 返回空；`rg "ohbaby-agent" packages/ohbaby-cli/package.json` 有匹配 | 后端不再依赖前端；前端依赖后端 |
| 9 | `bin` 字段已迁移 | `rg "\"bin\"" packages/ohbaby-agent/package.json` 返回空；`packages/ohbaby-cli/package.json` 有 | 入口归属前端 |
| 10 | 无动态 import 残留 | `rg "import\(\"ohbaby-cli\"\)" packages/` 返回空 | 反向动态 import 已删除 |

---

## 8. 验收流程

```
1. 编译验收（3 个包，预期全部通过）
   ↓
2. 单元测试（6 个测试文件 + 1 个新增 proxy 测试）
   ↓
3. CLI 入口验收（12 项）
   ↓
4. RPC 通信验收（9 项）
   ↓
5. 手动端到端验收（6 项）
   ↓
6. 回归验收（5 项）
   ↓
7. grep 审查（7 条）
   ↓
验收通过 ✓
```
