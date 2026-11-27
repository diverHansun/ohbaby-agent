# 3. 参考项目

路径相对 `code-cli/`，锚点来自 2026-11-27 子代理调研。

| 项目 | grep 参数 | glob 的 ignore 行为 | 对本轮的启发 |
| --- | --- | --- | --- |
| claude-code | pattern、path、glob、output_mode、-A、-B、-C、context、-n、-i、type、head_limit、offset、multiline | — | `output_mode` 的三种取值可以照用；参数太多，ohbaby 只取常用的 |
| kimi-code | pattern、path、glob、type、output_mode、-i、-n、-A、-B、-C、head_limit、offset、multiline、include_ignored | 默认遵守，`include_ignored` 显式打开 | G5 的做法直接参考这里 |
| ZCode | — | 默认开启内嵌搜索时根本不注册 Glob 和 Grep | 路线不同，不采用 |
| deepseek-harness | 每个参数都有描述 | — | 参数描述的写法 |
| opencode | — | — | read 能读目录，ohbaby 不采用（G6、G8） |

借鉴原则：取"大家都有、我们数据里也用得多"的参数（上下文行、忽略大小写、输出模式），不照搬完整参数表。
