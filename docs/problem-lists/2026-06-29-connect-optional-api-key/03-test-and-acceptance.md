# 测试与验收标准

> 前置：[01-problem-analysis.md](./01-problem-analysis.md)、[02-implementation-plan.md](./02-implementation-plan.md)。
> 总原则：**无 key 也能连上并真正推理**；**已配 key 的云端行为零回归**；
> **"key 对不对"由上游 401 在请求时回答**。

## 一、验收标准（用户故事级，必须全绿）

| AC | 场景 | 期望结果 |
|---|---|---|
| AC1 | 本机 LM Studio（`http://127.0.0.1:1234/v1`），只填 provider/baseUrl/model | `/connect` 保存成功；可发起对话并收到回复；`model.json` 不含密钥、`.env` 未被写入占位符 |
| AC2 | AC1 之后**重启** daemon / 新开会话 | 配置加载不抛 `MISSING_API_KEY`/`EMPTY_API_KEY`，runtime 正常起，可继续推理（验证第 6 层已放开） |
| AC3 | 私有 LAN 推理服务（如 `http://192.168.1.50:1234/v1`），不填 key | 同 AC1，连得上、用得了 |
| AC4 | 远程公网服务，不填 key，但该服务**需要鉴权** | `/connect` 可保存（不被前端/后端强制拦截）；**发起推理时**返回清晰的 401/鉴权错误（验证"交给上游"） |
| AC5 | 云端 provider，填了 `apiKeyEnv` + `apiKey` 值（既有用法） | 行为与改动前完全一致：密钥写入全局 `.env`，推理正常（零回归） |
| AC6 | 填了 `apiKey` 值但没填 `apiKeyEnv` 名 | 按 D2 决策：以 `<PROVIDER>_API_KEY` 持久化密钥；不报"缺名"错误 |
| AC7 | context window 探测 | 本机：probe 用占位符成功探测到真实窗口；远程无 key probe 失败：回退默认值 + warning，**不中断** connect |

## 二、单元测试

### 后端（阶段 A 重点）

| 测试对象 | 文件 | 用例 |
|---|---|---|
| `resolveApiKey` | `config/llm/apply-active-model-config.*test*` | ①显式值优先 ②环境变量次之 ③**都没有 → 返回占位符且不抛** ④占位符标记正确 |
| `applyActiveModelConfig` | 同上 | ①无 key 时保存成功、不写 `.env` ②有真实值时写 `.env` 到正确 KEY ③"有值无名" → 按 D2 生成键名 |
| `LLMConfigManager.performLoad` | `config/llm/manager.*test*` | ①无密钥值 → 不抛、`apiKey` 为占位符 ②无 `apiKeyEnv` → 不抛 ③有真实值 → 行为不变 |
| `validateModelJson` | `config/llm/validation.*test*` | ①缺 `apiConfig.apiKeyEnv` → **通过**（不再 `MISSING_FIELD`）②其余字段校验不变 |
| env 来源优先级 | `config/llm/apply-active-model-config.*test*` / `manager.*test*` | process env 非空优先；process env 缺失或空白时，回落到 `.env` 的非空值；两者都没有才用占位符和 warning |
| 占位符常量 | 单点定义处 | 非空、非密钥样式、单一来源 |

### 前端 / 契约（阶段 B/C）

| 测试对象 | 文件 | 用例 |
|---|---|---|
| `parseConnectArgs` | `commands/connect.*test*` | ①缺 `--api-key-env` → **不再** `MISSING_ARGS`，正常解析 ②`--api-key` 明文入参仍被拒 ③其余必填仍校验 |
| `buildPayload`（TUI） | `connect-panel.*test*` | 缺 `apiKeyEnv` → 不再 `incomplete`，可触发保存 |
| `connectModelRequest`（Web） | `App.*test*` / 选择器测试 | 缺 `apiKeyEnv` → 不抛 "required"，请求体不含该字段 |
| `modelConnectInputFromBody`（Server） | `app/*test*` / `public-api.unit.test.ts` | 缺 `apiKeyEnv` → input 有效（不再 400）；缺 provider/baseUrl/model 仍 400 |
| 类型可选性 | 编译期 | `tsc` 全绿；`apiKeyEnv?: string` 处理 undefined |

## 三、集成 / 契约测试

| 测试 | 内容 |
|---|---|
| connect → load 往返 | 模拟"无 key connect 成功 → reload 配置 → 取到带占位符的 `LLMConfig`"全链路不抛（覆盖 AC2） |
| Web 端到端（daemon HTTP） | POST `/v1/model` 无 `apiKeyEnv` → 200 + `ModelConnectResponse`；GET `/v1/model` 回读 `apiKeyEnv` 缺省时的契约（D3） |
| CLI `/connect` E2E | 仅 `--provider --base-url --model` → 保存成功 |
| 回归：云端有 key | 既有 connect/load 测试保持通过，断言 `.env` 写入与推理不变（守 AC5） |

## 四、手动验收清单

1. **LM Studio 本机**：启动 LM Studio 本地服务（截图所示 `http://127.0.0.1:1234`），
   `/connect provider=lmstudio baseUrl=http://127.0.0.1:1234/v1 model=<loaded-model>`，
   发一条消息确认有回复；检查 `~/.ohbaby-agent/.env` 未新增占位符行。
2. **重启复测**：重启 daemon，再发消息，确认无 `MISSING_API_KEY`。
3. **云端有 key**：用现有 zhipu/zenmux 配置回归一遍，确认行为不变。
4. **远程无 key 报错**：故意连一个需鉴权的远程地址且不填 key，确认推理时报清晰 401。
5. **CLI + Web + TUI 三端**：各自跑一遍"只填 provider/baseUrl/model"，均能保存。

## 五、回归保护（不可破）

- 既有 `model.json`（含 `apiKeyEnv`）仍合法加载。
- 已配 `.env` 密钥的云端推理路径零变化。
- `--api-key` 明文入参禁用、密钥错误信息脱敏（`connect-panel.tsx:510-524` `sanitizeError`）保持有效。
- 占位符**绝不**出现在 `.env` / `model.json` / 日志中的密钥位置。

## 六、Definition of Done

- [ ] AC1–AC7 全部通过（自动化 + 手动各一遍）。
- [ ] 阶段 A/B/C/D 各自 `pnpm -w test`（或对应包测试）+ `tsc` 全绿。
- [ ] 新增/修改的单元测试覆盖"无 key"与"有 key"两条路径。
- [ ] 三端文案已标注 api key 可选。
- [ ] 无新增地址探测启发式代码（护栏自检）。
