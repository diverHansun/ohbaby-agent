# Model Center and LLM Config Deferred Problems

日期: 2026-05-31

## 背景

当前 commands 批次保持单模型范围。`/models` 只作为当前模型信息入口，不实现 provider/model CRUD，不输入 API key，不改造多 provider 配置 schema。

以下问题需要在后续 Model Center 设计中集中解决。

## 延后问题

### 多 provider 配置 schema

现有 `config/llm` 以单个顶层 `provider`、`defaultModel` 和 `apiConfig` 为主。后续如果支持多个 provider，需要设计 provider-centric schema，例如每个 provider 拥有独立 `baseUrl`、`apiKeyEnv` 和 model profiles。

需要同时考虑旧 schema 的读取兼容和迁移策略。

### API key 持久化

TUI 未来允许用户在 `/models` 中输入 API key。第一阶段建议优先写入 `~/.ohbaby-agent/.env`，并在 `model.json` 中保存对应的 `apiKeyEnv` 名称。

数据库或系统 keychain 暂不作为第一阶段方案。它们更适合在出现用户账户、云同步、workspace profile 或更强密钥管理需求后评估。

### Provider 和 model CRUD

未来 `/models` 可以升级为 Model Center，支持：

- 新增 provider。
- 修改 provider 的显示名、baseUrl、apiKeyEnv。
- 删除 provider。
- 在 provider 下新增模型。
- 修改模型 label、context window、max output tokens 等信息。
- 删除模型。

当前 commands 分支不实现这些交互。

### 默认模型写回和运行时热切换

未来模型选择需要写回配置并成为默认模型，但还需要明确：

- 写回 `model.json` 的 API。
- 写回后是否立即 reload config。
- 当前 session 的 LLM client 是否热切换。
- 切换失败时如何恢复到旧模型。
- 正在进行的请求如何处理。

当前 commands 分支不处理持久化切换和热切换。

### 同名模型唯一标识

不同 provider 或不同 baseUrl 下可能出现相同 model 名称。后续需要定义稳定 ID，例如：

- provider + model
- provider + baseUrl + model
- 用户显式配置的 model profile id

当前单模型范围不需要解决。

### `/models` 大量模型 UX

后续如果一个 provider 下模型很多，需要设计：

- PgUp/PgDn 的分页规则。
- 跨 provider 跳转规则。
- 当前焦点和当前默认模型的视觉区别。
- 搜索或过滤。
- 删除 provider/model 前的确认流程。

当前 commands 分支只要求单模型或少量只读列表能清晰展示。

## 当前批次结论

本批次 `/models` 只展示当前单模型配置和可读取到的只读模型列表。

API key 输入、provider/model CRUD、多 provider schema、默认模型持久化切换和运行时热切换全部延后。
