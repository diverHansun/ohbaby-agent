# 下一次发布（未发布）

状态：发布准备中，尚未发布。本文件不指定下一次发布的版本号或日期；本轮源码版本保持 `0.1.16`。

## LLM 包提取

- 新增独立公开包 `ohbaby-llm`，包含 LLM client、三种协议 provider，以及纯配置类型、校验和模型 profile 函数；包不依赖其他 workspace 包，唯一公开入口为 `ohbaby-llm`。
- 独立使用者通过 `createLLMClientFromConfig` 提供已解析、已校验的配置，并用 `streamResponse` 消费流式响应。配置文件与环境变量 IO、日志接线、模型探测、系统代理和 UI 能力视图仍由 `ohbaby-agent` 负责。
- `ohbaby-agent` 继续提供原有 `createLLMClient` 和其他既有公开导出。提取不改变模型请求、重试、缓存键或 token 统计行为，不需要数据迁移。

## 包与发布准备

公开包由四个增加为五个。统一版本并按 `ohbaby-sdk` → `ohbaby-llm` → `ohbaby-agent` → `ohbaby-server` → `ohbaby-cli` 顺序发布；用户继续只安装 `ohbaby-cli`。Node.js 要求仍为 >= 24。

发布前使用五包 `pnpm pack` 产物，核对没有残留 `workspace:`，agent 的 `ohbaby-llm` 依赖为具体版本，再从临时 registry 和独立目录安装 CLI，验证 `ohbaby --version`。实际验证结果见 [实施与验收记录](../problem-lists/2026-10-21-llm-package-extraction/improve-1/05-implementation-acceptance.md)；本文件不代表已经完成 npm 发布。
