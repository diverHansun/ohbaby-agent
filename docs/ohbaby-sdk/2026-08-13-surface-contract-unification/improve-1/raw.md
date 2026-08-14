# Project architecture discussion

## User

看看我的项目ohbaby-agent，docs/下的文档以及我的database中的经验/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness，为什么当时我们做的tui是in-process而不是和后段分开的？而web端是有ohbaby serve后段启动的+前端单独的进程，之间使用http hono链接，我说的对吗？为什么我们当时这样决策？看看code-cli下的其它项目是怎么做的？通俗易懂解释

### Tool Run Terminal Command V2

```
{"command":"ls \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness\"","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01YSDjnbHiHGY5CAhtHUckpv","simpleCommands":["ls"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"ls","args":[{"type":"string","value":"\"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness\""}],"fullText":"ls \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness\""}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出agent-harness知识库目录","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Run Terminal Command V2

```
{"command":"ls /Users/hansunwork26/workspace/projects/code-cli/","workingDirectory":"","timeout":30000,"toolCallId":"toolu_011dTgXZ2wRZ3RgQnqAZcs6V","simpleCommands":["ls"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"ls","args":[{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/"}],"fullText":"ls /Users/hansunwork26/workspace/projects/code-cli/"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出code-cli目录下的项目","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Run Terminal Command V2

```
{"command":"find /Users/hansunwork26/workspace/projects/code-cli -maxdepth 2 -iname \"*ohbaby*\"","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01GugGo9ymzytCsnXZy4JovJ","simpleCommands":["find"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli"},{"type":"word","value":"-maxdepth"},{"type":"number","value":"2"},{"type":"word","value":"-iname"},{"type":"string","value":"\"*ohbaby*\""}],"fullText":"find /Users/hansunwork26/workspace/projects/code-cli -maxdepth 2 -iname \"*ohbaby*\""}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"查找ohbaby-agent项目路径","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Run Terminal Command V2

```
{"command":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent -maxdepth 3 -type d | grep -v node_modules | grep -v '\\.git'","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01SCd6LBz29gJFHF94c6v2Em","simpleCommands":["find","grep","grep"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent"},{"type":"word","value":"-maxdepth"},{"type":"number","value":"3"},{"type":"word","value":"-type"},{"type":"word","value":"d"}],"fullText":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent -maxdepth 3 -type d"},{"name":"grep","args":[{"type":"word","value":"-v"},{"type":"word","value":"node_modules"}],"fullText":"grep -v node_modules"},{"name":"grep","args":[{"type":"word","value":"-v"},{"type":"raw_string","value":"'\\.git'"}],"fullText":"grep -v '\\.git'"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出ohbaby-agent目录结构","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Run Terminal Command V2

```
{"command":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs -type f | grep -v node_modules","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01A2Pyk1vx12qyS8NRSyZuLe","simpleCommands":["find","grep"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs"},{"type":"word","value":"-type"},{"type":"word","value":"f"}],"fullText":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs -type f"},{"name":"grep","args":[{"type":"word","value":"-v"},{"type":"word","value":"node_modules"}],"fullText":"grep -v node_modules"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出ohbaby-agent/docs文件","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Run Terminal Command V2

```
{"command":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/project /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-cli /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-web /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/interfaces -type f","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01PZzH8GGj3Ph5Z81tX4ZSMG","simpleCommands":["find"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/project"},{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-cli"},{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server"},{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-web"},{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/interfaces"},{"type":"word","value":"-type"},{"type":"word","value":"f"}],"fullText":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/project /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-cli /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-web /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/interfaces -type f"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出关键架构文档文件","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Run Terminal Command V2

```
{"command":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/runtime/daemon /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/2026-07-11-global-single-daemon /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/terminal-daemon -type f","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01H168hwQB42gn6FuCoCf13e","simpleCommands":["find"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/runtime/daemon"},{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/2026-07-11-global-single-daemon"},{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/terminal-daemon"},{"type":"word","value":"-type"},{"type":"word","value":"f"}],"fullText":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/runtime/daemon /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/2026-07-11-global-single-daemon /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/terminal-daemon -type f"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出daemon相关文档文件","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

## Assistant

Found the key file: `docs/ohbaby-server/c1-cli-inprocess.md`. This looks exactly on-topic. Let me read that plus the top-level architecture docs.

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server/c1-cli-inprocess.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/project/architecture.md"}
```

### Tool Read File V2

```
{}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server/architecture.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-web/architecture.md"}
```

### Tool Run Terminal Command V2

```
{"command":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server -type f","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01RfYBVd8kzz57aSN7EejrJF","simpleCommands":["find"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server"},{"type":"word","value":"-type"},{"type":"word","value":"f"}],"fullText":"find /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server -type f"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出server问题清单目录文件","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server/07-route-c-cli-inprocess-explicit-server.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server/01-current-state-and-problems.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server/02-goals.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server/06-reference-runtime-findings.md"}
```

### Tool Run Terminal Command V2

```
{"command":"find \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/daemon\" -type f","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01AdAtjprSkuhCBGzH7nyq4Q","simpleCommands":["find"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"string","value":"\"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/daemon\""},{"type":"word","value":"-type"},{"type":"word","value":"f"}],"fullText":"find \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/daemon\" -type f"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出知识库daemon目录文件","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/daemon/2026-06-16-agent-daemon-comparison.md"}
```

### Tool Run Terminal Command V2

```
{"command":"find \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server\" \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/runtime\" -type f","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01LhqHstTW1pfKbhQh9B51Ln","simpleCommands":["find"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"find","args":[{"type":"string","value":"\"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server\""},{"type":"string","value":"\"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/runtime\""},{"type":"word","value":"-type"},{"type":"word","value":"f"}],"fullText":"find \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server\" \"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/runtime\" -type f"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"列出server和runtime知识库文件","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/runtime/2026-06-16-coding-cli-runtime-comparison.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server/2026-08-03-agent-communication-taxonomy.md"}
```

### Tool Run Terminal Command V2

```
{"command":"rg -n \"inProcess|daemon|remotePort\" /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli/src/cli/commands/terminal.ts | head -50","workingDirectory":"","timeout":30000,"toolCallId":"toolu_01Vabe8Cob4NFuuUos4fAr9x","simpleCommands":["rg","head"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"rg","args":[{"type":"word","value":"-n"},{"type":"string","value":"\"inProcess|daemon|remotePort\""},{"type":"word","value":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli/src/cli/commands/terminal.ts"}],"fullText":"rg -n \"inProcess|daemon|remotePort\" /Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli/src/cli/commands/terminal.ts"},{"name":"head","args":[{"type":"number","value":"-50"}],"fullText":"head -50"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"检查terminal.ts当前默认逻辑","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server/hono-app/01-app-assembly-and-transport.md","offset":1,"limit":80}
```

## Assistant

我看了 `ohbaby-agent` 的 `docs/` 目录（特别是 `docs/problem-lists/server/`、`docs/ohbaby-server/`、`docs/ohbaby-web/`）以及你数据库里 `agent-harness` 知识库的 `daemon/`、`server/`、`runtime/` 三个横向对比文档。先直接回答你的两个问题：

## 一、你的描述基本对，但有一处细节要纠正

- **TUI**：确实是 **in-process**——同一个 Node 进程里，UI 和 agent runtime 是直接函数调用，没有网络层。
- **Web**：确实是**两个独立进程**——`ohbaby serve` 起一个 Node 后端进程（HTTP/SSE server），`ohbaby-web`（Vite 打的前端）单独跑，两者之间走 HTTP + SSE。

要纠正的一点：**Hono 不是"协议"，只是后端用来装配路由的框架**。前后端之间实际"说话"用的是 **REST（发命令）+ SSE（收事件流）**，Hono 只是在服务端把这些路由、鉴权（token）、CORS 中间件组装成一个 HTTP server（见 [`docs/ohbaby-server/architecture.md`](/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server/architecture.md)、[`docs/ohbaby-web/architecture.md`](/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-web/architecture.md)）。而且这套 server 除了服务 web，也同时服务"显式 attach 的 CLI"（`ohbaby --remote-port`），走的是 JSON-RPC 协议，是同一个后端进程的另一个协议适配器。

## 二、为什么这样决策——三句话版本

> **同一个进程里，没必要发明协议；一旦拆成两个进程，就必须有协议。TUI 不需要拆，浏览器必须拆。**

这是你数据库里那篇笔记的判断标准：

```55:70:/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server/2026-08-03-agent-communication-taxonomy.md
### 1.1 同进程时，几乎不需要协议

以 ohbaby 为例：TUI 交互往往是 **in-process**——界面和 agent loop 在同一进程里，直接函数调用即可

### 1.2 一旦 UI 与 runtime 分家，通信就出现

Web UI、多客户端、后台守护进程、子进程隔离、远程协作，都会让「发起请求的程序」和「真正跑 loop 的程序」变成不同进程（有时不同机器）
```

判断标准很朴素：**发起 prompt 的程序和真正跑 loop 的程序，是不是同一个进程里的直接函数调用？** 是 → 不上协议；否（比如浏览器 tab 和 Node 后端天然是两个进程）→ 至少要有 HTTP/SSE 这层协议。TUI 天然满足"是"，浏览器天然满足"否"，所以两条路径的架构从一开始就该不一样，这不是巧合，是需求决定的。

## 三、但这不是"设计之初就想清楚的"，而是踩坑之后改回来的

看 `docs/problem-lists/server/` 这一串文档（01→07），会发现 ohbaby 一开始其实**默认给 TUI 也套了一层隐藏 daemon**（terminal 命令默认 auto-spawn 一个后台 daemon 进程，TUI 通过 RPC+SSE 连它），后来发现这是个坑：

```1:12:/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server/02-goals.md
当前 ohbaby 已经有一套 daemon/server 代码：HTTP JSON-RPC、SSE、权限路由、prompt queue、state/pid 文件、auto-spawn 等。它解决了一部分多窗口和前后端协作问题，但也把默认 CLI 的生命周期变复杂了：

- 用户只是运行 `ohbaby`，却可能触发后台进程发现、启动、连接、重启、旧状态复用。
- 多路径、多窗口、版本升级后容易出现 stale daemon、旧 session 被误复用、连接失败、端口/状态文件漂移。
- 默认 CLI 的错误模型变成"前台 UI + 后台 daemon + 持久化 session + 网络传输"的混合体，调试成本偏高。
```

根因分析写得很直白：默认走 daemon，其实是把 **三种完全不同的生命周期**捆在了一起——

1. 终端 UI 的生命周期（你开关这个窗口）
2. agent runtime/session 的生命周期（这次对话跑多久）
3. 后台 server 进程的生命周期（daemon 活多久、几个窗口共享它）

一旦这三个绑在一起，版本升级、多窗口、旧状态文件、端口冲突、"到底哪个窗口拥有这个 session" 这些问题就会互相传染，出了 bug 很难定位是哪一层的锅。于是团队做了个"路线 C"的决策（[`docs/problem-lists/server/07-route-c-cli-inprocess-explicit-server.md`](/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server/07-route-c-cli-inprocess-explicit-server.md)）：

- **默认 `ohbaby`**：只在当前进程里跑，关窗口/Ctrl+C 就彻底释放，没有"后台还留了个进程"这种模糊状态。
- **`ohbaby serve`**：显式启动一个独立 server 进程，这时候才需要处理端口、鉴权、CORS、断线重连——这些复杂度只出现在你**主动选择**要多客户端/远程能力的时候。
- **`ohbaby attach <url>`** / web 前端：显式连接那个 server。

这个决策后来落地成了 [`docs/ohbaby-server/c1-cli-inprocess.md`](/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server/c1-cli-inprocess.md) 里记录的具体改动（删掉 `--daemon`/`--in-process` 这两个用户可见 flag，默认路径不再自动发现/拉起 daemon），我看了代码 `terminal.ts` 现在确实是"没给 `--remote-port` 就是 in-process"，和文档一致。

## 四、为什么敢这么改：看了别的项目都是这么干的

`docs/problem-lists/server/06-reference-runtime-findings.md` 里记录了对 `gemini-cli`、`kimi-code`、`claude-code`、`opencode` 的复核，结论是**没有一个项目默认在交互式 CLI 背后藏一个常驻 daemon**：

```7:14:/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists/server/06-reference-runtime-findings.md
| 项目 | 默认 CLI | server/remote 能力 | 对 ohbaby 的启发 |
|------|----------|--------------------|------------------|
| Gemini CLI | 前台父进程 supervisor 重新拉起子进程，真实 TUI/runtime 在当前命令生命周期内 | A2A server、ACP、devtools 是显式模式或独立包 | 可以有很薄的前台 launcher，但不要变成跨命令常驻 daemon |
| Kimi Code | 单前台进程，`KimiHarness` + `KimiTUI` + in-process fake RPC | SDK/vis server 是独立能力，默认 CLI 不起本地 server | 保留接口边界，但不要为了边界强行引入网络拓扑 |
| Claude Code | 普通 CLI 直接 render REPL 并调用 query/runtime | daemon、remote-control、ACP 都是显式入口或独立 package | 默认 CLI 与 long-running server 的职责分离清楚 |
| Opencode | 默认 TUI 是前台 worker + injected fetch；`run` 直接打 in-process server app fetch | `serve`、`web`、`attach`、desktop sidecar、SDK helper 显式启用 server | server 抽象可以很强，但默认路径不需要 hidden daemon |
```

`code-cli` 目录下正好也有 `opencode`、`kimi-code`、`claude-code-best`（应该是 claude-code）这几个项目，它们的模式高度一致，用大白话总结一下每家怎么做：

- **Kimi Code**：最简单粗暴，就一个前台进程，UI 和引擎之间甚至懒得用真的网络协议，用一个"假 RPC"（JSON 序列化+异步调度）在内存里模拟一下边界，图的是以后想拆的话改动小，但根本不开端口。
- **Claude Code**：普通交互模式就是前台 REPL 直接调用，`daemon`/远程控制是完全独立的命令和包，普通用户根本碰不到。
- **Opencode** 最值得借鉴的一点是 **injected fetch** 这个技巧：它做了一个统一的 client 抽象，这个 client 既可以直接调用本地内存里的 server app（`app.fetch(request)`，不开端口），也可以打真实的 HTTP server——**同一套协议模型，换一个"运输方式"**。ohbaby-server 后来的 `create-app.ts` + `in-process.ts`/`node-listen.ts` 设计（见 [`hono-app/01`](/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-server/hono-app/01-app-assembly-and-transport.md)）就是直接抄的这个思路：同一个 Hono app，`app.fetch()` 直接调是给 in-process/测试用的，`node-listen` 挂端口是给 `ohbaby serve` 用的。
- **Gemini CLI**：前台有个很薄的父进程会 `spawn` 一次子进程（这只是为了处理 Node flags、版本升级检查之类的事，不是常驻 daemon），真正的 TUI 在子进程里跑，A2A/ACP 这些重协议能力是完全独立的包。

四个项目的共同点被总结成一句话：**"默认 CLI 应该是当前命令生命周期内的 runtime，server 可以很强，但必须是显式入口"**——这正是 ohbaby 最后抄的作业。

## 五、通俗版比喻

把这套关系想象成"点外卖 vs 在自己家做饭"：

- **TUI = 在自己家做饭**：你（UI）和厨房（agent runtime）在同一个屋子里，喊一声就行，不需要电话、不需要外卖平台，做完饭这顿事就结束了，厨房也跟着收工。这就是 in-process：进程一退出，什么都不留。
- **Web = 点外卖**：顾客（浏览器）和厨房（agent runtime）根本不在一个地方，必须有电话/外卖 App（HTTP+SSE 协议）来传菜单（prompt）和传菜（事件流）。这时候你就绕不开一堆"点外卖"才有的麻烦事：怎么验证是不是本人下单（auth token）、平台能不能跨城市接单（CORS）、外卖小哥半路网络断了怎么补送（SSE 断线重放/`Last-Event-ID`）——这些复杂度**只在你需要"外卖"这个场景时才会出现**，在自己家做饭完全不需要考虑。

ohbaby 最早的问题就是：**明明是在自己家做饭，却非要先打个电话给"中央厨房"再让它把饭端过来**——多此一举不说，中央厨房（隐藏 daemon）还可能因为版本升级/多个人同时打电话而出现"上次点的菜还没收拾干净就又来新单"的脏状态（stale daemon、session 指针冲突）。后来的改法就是想明白了：**"自己家做饭"和"点外卖"是两种完全不同的场景，不该共用一套默认路径**，于是让 TUI 老老实实做饭（in-process），把"中央厨房"（server）变成你必须自己开口点单才会启动的东西（`ohbaby serve` + attach）。

## User

建议把这部分决策+我的疑问（之前的设计舍取我忘了，所以今天有了这样的疑问）+优秀项目的设计写入我的数据库文档中，放在/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness下的合适路径

## Assistant

我先看一下 `agent-harness/server/` 目录现有文档的格式，以保持风格一致，然后选一个合适的文件名写入

### Tool Read File V2

```
{"path":"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/index.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server/2026-06-16-agent-server-comparison.md","limit":40}
```

### Tool Run Terminal Command V2

```
{"command":"ls -la /Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server/","workingDirectory":"","timeout":30000,"toolCallId":"chatcmpl-tool-4a2b8724e90442b5a9cc1419ea311cc5","simpleCommands":["ls"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"ls","args":[{"type":"word","value":"-la"},{"type":"word","value":"/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server/"}],"fullText":"ls -la /Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server/"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"requestedSandboxPolicy":{"type":"TYPE_WORKSPACE_READWRITE","networkAccess":false,"additionalReadwritePaths":["/Users/hansunwork26/workspace/projects/code-cli"],"additionalReadonlyPaths":[],"enableSharedBuildCache":true,"readBoundary":"READ_BOUNDARY_MODE_UNSPECIFIED","additionalReadPaths":[]},"fileOutputThresholdBytes":"40000","isBackground":false,"skipApproval":false,"timeoutBehavior":"TIMEOUT_BEHAVIOR_BACKGROUND","hardTimeout":86400000,"description":"检查server目录是否有index","closeStdin":true,"conversationId":"4c64ec01-14f2-480f-b5a5-3e083788fc40","adminCommandDenylist":[]}
```

## Assistant

我把这份决策记录写入 `server/` 目录（它讲的是通信架构选型，与已有的 `agent-server-comparison.md`、`agent-communication-taxonomy.md` 同属一个知识夹），文件名沿用日期前缀惯例

### Tool Edit File V2

## Assistant

已写入。文件位置：

`/Users/hansunwork26/personal/projects/Hansun-database/knowledge-base/computer-science/agent-harness/server/2026-08-11-tui-inprocess-vs-web-server-split.md`

放在 `server/` 目录下，和已有的 `2026-06-16-agent-server-comparison.md`、`2026-08-03-agent-communication-taxonomy.md` 同夹，因为这篇讲的就是「通信拓扑选型」的决策记录。

文档结构（八节）：

1. **为什么会忘记、为什么会重新问**——把你今天「忘了之前的设计取舍、所以重新冒出疑问」这件事本身记下来，作为以后回看的锚点。
2. **纠正一个常见误读**——把「HTTP Hono 不是协议、是装配框架」这个细节固化，避免下次又混。
3. **决策的第一性原理**——「发起 prompt 的程序和跑 loop 的程序是不是同一个进程」这条判断标准。
4. **踩坑后改回来的故事**——早期默认走隐藏 daemon 的病根（三种生命周期捆绑）、路线 C 的决策、`c1-cli-inprocess.md` 的落地。
5. **四个参考项目都这么干**——gemini-cli / kimi-code / claude-code / opencode 的做法，大白话版 + opencode injected fetch 这条最值得借鉴的迁移路径。
6. **通俗比喻**——在自己家做饭 vs 点外卖，对应 in-process vs Web+server。
7. **决策要点（写给自己以后看）**——6 条可检索的判断线，下次再纠结时直接看这一节。
8. **与已有文档的分工**——和通信版图、server 对比、daemon 对比的分工图，避免以后重复写。

frontmatter 里 `sources` 把 `ohbaby-agent/docs/problem-lists/server/` 那串关键文档都列了，以后想回溯原始材料直接按图索骥。`tags` 加了 `architecture-decision` 和 `ohbaby-agent`，方便以后按 ADR 风格或按项目过滤。

要不要我顺手在 `agent-harness/index.md` 里也加一行指向这篇？目前 `index.md` 只列子模块和顶层文件，`server/` 目录下的具体文档没逐个列出，所以不加也符合现有惯例——但如果你想让它更显眼，我可以补。

## User

1.hono装配路由是什么意思？ 什么叫装配框架 2.查看项目：/Users/hansunwork26/workspace/projects/SpeedClaw 其中的cli或者叫tui是in-process的直接函数调用？似乎是submit/subscriber的订阅者/推送者机制，也没有把cli和后段分离，但是web端/app端和后段agent-harness的部分是分离的 3.appserver作用起什么作用？连接前端ui和agent通信吗？协议部分在protocol是吗？相当于ohbaby-agent的sdk契约 4.前端事件的api是如何定义的？tui/web/app等共享一套前端的api？还是tui走直接的函数调用，web/app端有前端的契约？ 针对我的以上问题来详细分析一下，通俗易懂大白话解释

### Tool Run Terminal Command V2

### Tool Run Terminal Command V2

### Tool Run Terminal Command V2

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/docs/protocol.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent/agent.go","limit":120}
```

### Tool Run Terminal Command V2

### Tool Ripgrep Raw Search

```
{"pattern":"func \\(a \\*Agent\\) (Submit|Subscribe|Request|Events|Close)","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent/agent.go","outputMode":"content","contextAfter":15,"caseInsensitive":false,"multiline":false,"toolCallId":"chatcmpl-tool-ac3c78efab45460aa197f22aa0352c67","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/tui/tui.go"}
```

### Tool Ripgrep Raw Search

```
{"pattern":"^func .* (Submit|Subscribe|Request|Events|Close)\\(","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent/agent.go","outputMode":"content","caseInsensitive":false,"multiline":false,"toolCallId":"chatcmpl-tool-67ca296691654cb89ef79219e7895add","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/tui/model.go","limit":120}
```

### Tool Ripgrep Raw Search

```
{"pattern":"Submit|Subscribe|Request\\(|Events\\(\\)|Close\\(\\)","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent/agent.go","outputMode":"content","caseInsensitive":false,"headLimit":40,"multiline":false,"toolCallId":"chatcmpl-tool-ef4ae9a6aa594b65b55430921881ec49","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/tui/events.go"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent/agent.go","offset":580,"limit":120}
```

### Tool Ripgrep Raw Search

```
{"pattern":"^func \\(a \\*Agent\\)","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent/agent.go","outputMode":"content","caseInsensitive":false,"headLimit":40,"multiline":false,"toolCallId":"chatcmpl-tool-a5287778565b49329e0cbded80a3f6b7","offset":0}
```

### Tool Ripgrep Raw Search

```
{"pattern":"func \\(a \\*Agent\\) (Submit|Subscribe|Request|Events|Close)\\b","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent","outputMode":"content","contextAfter":12,"caseInsensitive":false,"multiline":false,"toolCallId":"chatcmpl-tool-cfcf99510d1549ce9136f2e429bf8e16","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go","limit":120}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/chat_runs.go","limit":120}
```

### Tool Ripgrep Raw Search

```
{"pattern":"func \\(s \\*Server\\) (HandleChat|handleChat|chatSSE|chatStream|Subscribe|Submit)","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go","outputMode":"content","contextAfter":25,"caseInsensitive":false,"headLimit":3,"multiline":false,"toolCallId":"chatcmpl-tool-ba0db3a21bc843358d8d2f83a9b43573","offset":0}
```

### Tool Ripgrep Raw Search

```
{"pattern":"/api/chat|/api/events|sse|SSE|Subscribe\\(|Submit\\(","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go","outputMode":"content","caseInsensitive":false,"headLimit":30,"multiline":false,"toolCallId":"chatcmpl-tool-ca6c7061324d43448f4d06f7a7b9e65e","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go","offset":975,"limit":90}
```

### Tool Ripgrep Raw Search

```
{"pattern":"func translateEvent","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go","outputMode":"content","contextAfter":40,"caseInsensitive":false,"multiline":false,"toolCallId":"chatcmpl-tool-a56f0ac63dde4357b572957f5fe9983a","offset":0}
```

### Tool Run Terminal Command V2

### Tool Ripgrep Raw Search

```
{"pattern":"/api/chat|EventSource|fetch.*chat","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/console/src","outputMode":"files_with_matches","caseInsensitive":false,"headLimit":30,"multiline":false,"toolCallId":"chatcmpl-tool-3d52194d03314367848fc72e9041ce7e","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/console/src/api/chat.ts","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/console/src/hooks/useSSE.ts","limit":80}
```

### Tool Run Terminal Command V2

### Tool Ripgrep Raw Search

```
{"pattern":"SSEEvent|export type|export interface","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/console/src/types","outputMode":"content","caseInsensitive":false,"headLimit":30,"multiline":false,"toolCallId":"chatcmpl-tool-b8bee2c2219e415e8fd4f033c8873764","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/console/src/types/index.ts","offset":195,"limit":35}
```

### Tool Run Terminal Command V2

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/mobile/src/api.ts","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/protocol/op.go","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/protocol/doc.go"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/doc.go"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/doc.go"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/exec/exec.go","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/cmd/codar/chat.go","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/cmd/codar/serve.go","limit":100}
```

### Tool Ripgrep Raw Search

```
{"pattern":"func \\(s \\*Server\\) (ServeHTTP|Handler|Routes|Register|mux|Mount)","path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go","outputMode":"content","caseInsensitive":false,"headLimit":10,"multiline":false,"toolCallId":"chatcmpl-tool-a30ccd2e485f45d6a5a8a3b4f1c08faa","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go","offset":200,"limit":170}
```

## Assistant

我已经把 SpeedClaw 的关键代码都看了一遍。下面按你的四个问题逐一回答，尽量用大白话。

---

## 1. Hono 装配路由是什么意思？什么叫"装配框架"？

先把这个词拆开：

- **路由（route）**：就是"URL → 处理函数"的映射表。比如 `POST /api/chat` → `handleChat()`、`GET /api/sessions` → `handleListSessions()`。这是任何 HTTP server 都要有的东西。
- **中间件（middleware）**：套在路由外面的"过滤层"。比如鉴权（检查 token 对不对）、CORS（检查浏览器跨域能不能放行）、日志（每个请求记一行）。每个请求先穿过中间件，再进路由。
- **装配（assemble）**：就是把这些零件——路由表、中间件、错误处理、监听端口——**拼成一个能跑的 server**。

Hono 自己**没发明** HTTP、没发明 SSE、没发明 JSON。它只是给你一个写法，让你声明式地把这些东西拼起来：

```typescript
const app = new Hono()
app.use(corsMiddleware)              // 套中间件
app.use(authMiddleware)
app.post('/v1/sessions', handler)   // 挂路由
app.get('/v1/events', sseHandler)
export default { port, fetch: app.fetch }  // 监听端口
```

**类比**：Hono 像宜家的组装工具——板子和螺丝是现成的（HTTP、SSE、JSON 都是 Web 标准），Hono 帮你按图纸把它们拧成一个柜子。它不是柜子本身（协议），是组装工具（框架）。

所以"前后端之间用 HTTP Hono 连"这句话其实有点偷懒，准确说法是：**前后端之间用 HTTP+SSE 通信，后端用 Hono 这个框架把路由和中间件组装成一个 HTTP server。**

SpeedClaw 这边对照一下就更清楚——它**没用 Hono**，用的是 Go 标准库的 `http.ServeMux`：

```212:212:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
```

后面一长串 `mux.HandleFunc("POST /api/chat", s.handleChat)` 就是手动挂路由。Go 标准库的 mux 比 Hono 简陋（没有中间件管线、没有声明式 schema），但干的是同一件事——**装配路由**。Hono 和 `http.ServeMux` 是同类东西，只是 Hono 更现代、更顺手。

---

## 2. SpeedClaw 的 TUI 是 in-process 直接函数调用吗？

**不完全是"直接函数调用"，是"in-process 的消息队列"**。这点和 ohbaby 不一样，需要说清楚。

看 `cmd/codar/chat.go`，TUI 启动方式是：

```28:36:/Users/hansunwork26/workspace/projects/SpeedClaw/cmd/codar/chat.go
// runChat boots an agent and hands it to the bubbletea TUI. Mirrors
// the early portion of runExec — same cfg load, same default-filling,
// same provider/agent build — but skips the one-shot run/copy
// machinery because the TUI drives multi-turn directly.
func runChat() {
```

它把 `*agent.Agent` 直接传给 bubbletea TUI，**同一个进程，没有网络**。这点和 ohbaby 一样——TUI 不开端口、不连 socket。

但 TUI 跟 agent 之间**不是直接调函数**，而是走 Go channel 做的 pub/sub。看 `internal/frontend/tui/events.go`：

```49:67:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/tui/events.go
// submitUserTurn submits an OpUserTurn and returns its assigned Op id so the
// model can match it against EventTurnComplete when the turn finishes.
func submitUserTurn(ag *agent.Agent, sessionID, text string) (string, error) {
	opID := newOpID("turn")
	return opID, ag.Submit(context.Background(), &protocol.OpUserTurn{
		ID:        opID,
		SessionID: protocol.SessionID(sessionID),
		Text:      text,
	})
}

// submitInterrupt asks the agent to cancel the in-flight turn for the session.
func submitInterrupt(ag *agent.Agent, sessionID string) error {
	return ag.Submit(context.Background(), &protocol.OpInterrupt{
		ID:        newOpID("intr"),
		SessionID: protocol.SessionID(sessionID),
		Source:    "tui_user",
		Reason:    "esc_key",
	})
}
```

用户在 TUI 里按回车 → `submitUserTurn` → `ag.Submit(ctx, Op)` 把一个 `OpUserTurn` 结构体塞进 agent 的 channel。agent 内部有个 dispatcher goroutine 从 channel 里取 Op、跑 loop、把结果 Event 推到另一个 channel。TUI 再从 `ag.Events()` 这个 channel 读 Event：

```34:37:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/tui/events.go
func startEventReader(ag *agent.Agent) (<-chan protocol.Event, tea.Cmd) {
	events := ag.Events()
	return events, waitForEvent(events)
}
```

所以 SpeedClaw 的 TUI 拓扑是：

```
同一个 Go 进程
┌──────────────────────────────────────────┐
│  TUI (bubbletea)                          │
│      ↓ ag.Submit(Op)        → channel     │
│      ↑ <-ag.Events()  ← channel           │
│                                          │
│  Agent (dispatcher + loop)                │
│      ← 从 submitCh 取 Op                  │
│      → 把 Event 推到 eventSource          │
│      → broadcaster 扇出到所有 subscriber  │
└──────────────────────────────────────────┘
```

**和 ohbaby 的区别**：
- ohbaby 的 TUI 是**直接函数调用**——UI 调 `createPersistentUiBackendClient(...)`，拿到一个本地 backend 对象，方法调用就是函数调用。
- SpeedClaw 的 TUI 是**进程内消息队列**——UI 调 `ag.Submit(Op)` 把消息塞 channel，agent 从 channel 取，结果从另一个 channel 出。中间没有网络，但有 channel 解耦。

**为什么 SpeedClaw 选 channel 而不是直接函数调用？** 看 `docs/protocol.md` 第 1 节，它明说抄的是 codex 模式：

```13:15:/Users/hansunwork26/workspace/projects/SpeedClaw/docs/protocol.md
This refactor adopts the **codex pattern**: one core, addressed through one well-typed bidirectional protocol (`Op` in / `Event` out), with thin per-channel adapters (TUI, exec, app-server, inbox, scheduler) on top.
```

核心想法是：**agent 只暴露一个契约——`Submit(Op)` + `Events() <-chan Event`**。所有前端（TUI、exec、appserver、scheduler）都用这同一个契约跟 agent 说话。这样：
- TUI 在同进程里用 channel 调这个契约
- appserver 在同进程里也用 channel 调这同一个契约，只是它拿到 Event 后再翻译成 HTTP+SSE 发给浏览器
- 将来要加新前端（比如 IM bot），还是用这同一个契约

**类比**：ohbaby 像你直接进厨房跟厨师说话（函数调用）；SpeedClaw 像你在家里的传菜窗口放个订单（Op），厨师做好菜放到出菜口（Event channel），你不用进厨房，但你们还是在同一个屋子里（同进程）。后者的好处是厨师可以在厨房里自由安排（dispatcher goroutine），不用被你堵在门口。

至于 Web/App 端——你的观察是对的，**它们和后端是分离的**：
- `console/` 是 React + Vite 的独立前端
- `desktop/` 是 Electron 壳，里面装着同一个 React 前端 + 一个本地 Go sidecar
- `mobile/` 是 React Native，通过远程代理连后端

它们都不在 agent 进程里，必须走 HTTP+SSE。

---

## 3. appserver 起什么作用？协议在 protocol 吗？相当于 ohbaby 的 sdk 契约吗？

**三个问题都是"对"，但要分清楚层次。**

### appserver 是什么

`internal/frontend/appserver/` 是 **HTTP 前端适配器**——它是 `internal/frontend/` 下和 `tui/`、`exec/`、`scheduler/` 平级的一个兄弟。看它的 doc：

```1:11:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/doc.go
// Package appserver is the HTTP frontend that backs the React console and the
// Electron desktop app. It owns the route table and the SSE chat stream; on
// the wire it speaks the legacy REST + per-event SSE shape until Phase 5
// flips both the HTTP layer and the console TS layer to the protocol-native
// Op/Event format.
//
// In runtime terms, appserver subscribes to the agent through the same
// Agent.Submit / Agent.Events contract every other frontend uses; the SSE
// handler translates protocol.Event back to the legacy wire format on its way
// out to the browser.
package appserver
```

它干两件事：

1. **进的方向**：把 HTTP 请求翻译成 `protocol.Op`，调 `agent.Submit`。比如 `POST /api/chat` 收到 JSON → 包成 `OpUserTurn` → `s.agent.Submit(...)`：

```1003:1013:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go
	if err := s.agent.Submit(r.Context(), &protocol.OpUserTurn{
		ID:                   opID,
		SessionID:            protocol.SessionID(req.SessionID),
		Text:                 req.Message,
		Model:                req.Model,
		ReasoningEffort:      req.ReasoningEffort,
		Attachments:          req.Attachments,
		EditUserMessageIndex: req.EditUserMessageIndex,
		GoalMode:             req.GoalMode,
		WorkspaceOverride:    projectWorkspace,
	}); err != nil {
```

2. **出的方向**：`agent.Subscribe()` 拿到一个 Event channel，把每个 `protocol.Event` 翻译成 SSE 行发给浏览器：

```1031:1046:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go
			ssePayload := translateEvent(event)
			if ssePayload == nil {
				continue
			}
			data, err := json.Marshal(ssePayload)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", string(data))
			flusher.Flush()
			if _, done := event.(*protocol.EventTurnComplete); done {
				if ssePayload["event"] != "done" {
					writeSSE(w, flusher, map[string]any{"event": "done", "data": nil})
				}
				return
			}
```

所以 **appserver 不是"连接前端和 agent 的中间件"**——它本身就是前端的一种，是"把 HTTP 适配到 Op/Event 协议上的那种前端"。它和 TUI 是平级的兄弟，只是面向的 I/O 不同：TUI 面向终端按键和屏幕渲染，appserver 面向 HTTP 请求和 SSE 流。

### 协议在哪

协议在 `internal/protocol/`，看它的 doc 说得很直白：

```1:11:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/protocol/doc.go
// Package protocol is the wire contract between the Codar agent core
// and any frontend (TUI, exec, app-server, scheduler, inbox).
//
// Frontends speak Op → agent; agent emits Event → frontends. This package
// has no IO, no goroutines, and no imports from internal/agent. Changing
// any type here changes the public surface of Codar.
```

关键句：**"no IO, no goroutines, and no imports from internal/agent"**——这个包是**纯 schema**，只有数据结构定义和 JSON 编解码，没有任何业务逻辑、没有任何 IO。改这里就是改 Codar 的"公开 API 表面"。

里面是：
- `op.go` — 31 个 Op 变体（`OpUserTurn`、`OpInterrupt`、`OpSteer`、`OpCreateSession`、`OpListProjects`...）
- `event.go` — 32 个 Event 变体（`EventAgentMessageDelta`、`EventToolCallBegin`、`EventTurnComplete`...）
- `envelope.go` — JSON 编解码（带 `type` 字段做判别）
- `types.go` — 值类型（`Session`、`Project`、`Schedule`...）

### 相当于 ohbaby 的 sdk 契约吗

**是的，但 SpeedClaw 的更纯粹。** 对照一下：

| | ohbaby | SpeedClaw |
|---|---|---|
| 契约包 | `ohbaby-sdk`（UiEvent 类型 + CoreApiHost/UiBackendClient 接口） | `internal/protocol`（Op + Event + 值类型） |
| 契约内容 | UI 事件类型 + backend 客户端接口 | Op 变体 + Event 变体 + JSON wire format |
| 谁用 | ohbaby-cli（TUI）、ohbaby接着上面被打断的地方继续。

### 相当于 ohbaby 的 sdk 契约吗（续）

**是的，但 SpeedClaw 的更纯粹。** 对照一下：

| | ohbaby | SpeedClaw |
|---|---|---|
| 契约包 | `ohbaby-sdk`（`UiEvent` 类型 + `CoreApiHost`/`UiBackendClient` 接口） | `internal/protocol`（`Op` + `Event` + 值类型） |
| 契约内容 | UI 事件类型 + backend 客户端接口 | Op 变体 + Event 变体 + JSON wire format |
| 谁用 | ohbaby-cli（TUI）、ohbaby-server、ohbaby-web 都依赖它 | TUI、exec、appserver、scheduler 都依赖它 |
| 纯度 | 还包含 `CoreApiHost` 这种"行为接口" | 纯 schema，no IO、no goroutine、no business logic |

SpeedClaw 更纯粹的地方在于：`protocol` 包**只有数据结构**，没有任何行为接口。`Submit`/`Subscribe`/`Request`/`Close` 这些方法是定义在 `*agent.Agent` 这个具体类型上的（见 `internal/agent/dispatcher.go`），不在 protocol 包里。protocol 只管"消息长什么样"，agent 只管"怎么处理消息"，frontend 只管"怎么把 I/O 翻译成消息"。三者切开。

所以你的判断完全对：**`internal/protocol/` 就是 SpeedClaw 的 sdk 契约，相当于 ohbaby 的 `ohbaby-sdk`，但更纯粹——它只定义消息形状，不定义行为接口。**

---

## 4. 前端事件的 API 如何定义？TUI/Web/App 共享一套前端 API 吗？

**这里要分两层看，答案不一样：**

### 后端侧（Go）：所有前端共享一套 `protocol.Op` + `protocol.Event`

TUI、exec、appserver、scheduler 全都用同一套 Go 类型跟 agent 说话：

```41:53:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/agent/dispatcher.go
func (a *Agent) Submit(ctx context.Context, op protocol.Op) error {
	if op == nil {
		return errors.New("agent.Submit: nil op")
	}
	env := submitEnvelope{op: op, ctx: ctx}
	select {
	case a.submitCh <- env:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-a.closed:
		return ErrAgentClosed
	}
}

func (a *Agent) Subscribe() (<-chan protocol.Event, func()) {
```

TUI 调 `Submit(OpUserTurn)`，appserver 也调 `Submit(OpUserTurn)`，exec 也调 `Submit(OpUserTurn)`——**完全一样的入口，只是各家的 Op 来源不同**（TUI 来自键盘、appserver 来自 HTTP、exec 来自命令行参数、scheduler 来自 cron 触发）。

### 前端侧（TypeScript）：Web 和 App 不直接吃 protocol.Event，吃的是 appserver 翻译过的 legacy SSE 格式

这里有个**关键事实**：appserver 在把 `protocol.Event` 推给浏览器时，**做了一层翻译**，不是直接转发 Go 的 JSON。看 `translateEvent`：

```2411:2422:/Users/hansunwork26/workspace/projects/SpeedClaw/internal/frontend/appserver/server.go
func translateEvent(event protocol.Event) map[string]any {
	switch e := event.(type) {
	case *protocol.EventAgentMessage:
		return map[string]any{
			"event": "text",
			"data":  map[string]any{"text": e.Text},
		}
	case *protocol.EventAgentMessageDelta:
		return map[string]any{
			"event": "text_delta",
			"data":  map[string]any{"text": e.Delta},
		}
```

Go 侧的 `EventAgentMessageDelta` 被翻译成 `{"event": "text_delta", "data": {"text": "..."}}` 这种 legacy SSE 形状。浏览器收到的不是 protocol 的原始 JSON，是这层翻译后的格式。

前端 TS 那边对应有一套**手写的类型**，对齐 appserver 发出来的 legacy SSE 形状：

```197:222:/Users/hansunwork26/workspace/projects/SpeedClaw/console/src/types/index.ts
export type SSEEvent =
  | { event: "text"; data: { text: string } }
  | { event: "text_delta"; data: { text: string } }
  | { event: "reasoning"; data: { text: string } }
  | { event: "reasoning_delta"; data: { text: string } }
  | { event: "status"; data: { message: string; kind?: string; attempt?: number; max_attempts?: number; clear?: boolean } }
  | { event: "steer_applied"; data: { text?: string; attachments?: ChatAttachment[]; client_message_id?: string } }
  | { event: "tool_use"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { event: "tool_result"; data: { tool_use_id: string; content: string; is_error: boolean } }
  | { event: "tool_output_delta"; data: { tool_use_id: string; text: string } }
  | { event: "subagent_start"; data: { id?: string; agent: string; task: string } }
  | { event: "subagent_delta"; data: { id?: string; agent: string; text: string } }
  | { event: "subagent_tool_call"; data: { id?: string; agent: string; call_id?: string; name: string; input?: Record<string, unknown> } }
  | { event: "subagent_tool_result"; data: { id?: string; agent: string; call_id?: string; name: string; output?: string; is_error: boolean } }
  | { event: "subagent_end"; data: { id?: string; agent: string; result?: string; is_error?: boolean } }
  | { event: "context_usage"; data: UsageStats }
  | { event: "context_compaction"; data: { message: string } }
  | { event: "result"; data: UsageStats }
  | { event: "task_snapshot"; data: { tasks: TaskItem[] } }
  | { event: "edited_files"; data: { files: EditedFile[] } }
  | { event: "session_goal_update"; data: { session_id: string; goal?: SessionGoalInfo | null } }
  | { event: "tool_approval_request"; data: { call_id: string; batch_id?: string; batch_size?: number; tool_call_id?: string; tool_name: string; args: string; response_token?: string } }
  | { event: "ask_user_request"; data: { call_id: string; tool_call_id?: string; questions: AskUserQuestion[]; response_token?: string } }
  | { event: "in_app_browser_command"; data: InAppBrowserAgentCommand }
  | { event: "error"; data: { code?: string; message: string } }
  | { event: "done"; data: null };
```

这套 `SSEEvent` 是**手写的 discriminated union**，不是从 Go 的 `protocol.Event` 自动生成的。`docs/protocol.md` 第 8 节也明说了这一点：

```519:519:/Users/hansunwork26/workspace/projects/SpeedClaw/docs/protocol.md
Tygo TS generation remains the only item still open — frontend keeps hand-written types until someone wants to wire it up.
```

### Mobile 端又是另一层

`mobile/src/api.ts` 里的 `RemoteAPI` 类不走本地 appserver，它走的是远程代理——先登录云端（`/v1/login`），列设备（`/v1/codar/remote/devices/list`），然后通过 `/api/remote/devices/{deviceId}/stream` 把请求转发到远程设备上的那个 appserver：

```69:72:/Users/hansunwork26/workspace/projects/SpeedClaw/mobile/src/api.ts
  async fetchProjects(deviceID: string): Promise<ResearchProject[]> {
    const data = await this.proxy<{ projects?: ResearchProject[] }>(deviceID, "GET", "/api/projects");
    return data.projects ?? [];
  }
```

所以手机端最终也是连一个 appserver，只是中间多了一层云端代理。它收到的 SSE 形状和 console 一样，用的也是手写 TS 类型。

### 总结成一张表

| 前端 | 跟后端怎么说话 | 用什么类型 | 是否共享 |
|---|---|---|---|
| TUI（Go，同进程） | `ag.Submit(Op)` + `<-ag.Events()`，走 Go channel | Go 的 `protocol.Op`/`Event` | 后端契约共享 |
| exec（Go，同进程，headless） | 同上 | 同上 | 后端契约共享 |
| scheduler（Go，同进程，cron） | 同上 | 同上 | 后端契约共享 |
| appserver（Go，同进程，HTTP） | 同上 + 翻译成 SSE | 同上 + `translateEvent` | 后端契约共享 |
| console（React，浏览器） | HTTP + SSE | 手写 TS `SSEEvent` | **不共享**，手写镜像 |
| desktop（Electron，本地 sidecar） | 同 console | 同 console | 同 console |
| mobile（React Native，远程） | 云端代理 → 远程 appserver 的 HTTP+SSE | 手写 TS 类型 | 同 console |

---

## 把四个问题串成一张全景图

```
                        ┌─────────────────────────────────────────┐
                        │  同一个 Go 进程（codar 进程）              │
                        │                                          │
                        │  ┌───────────┐   Op   ┌───────────────┐  │
                        │  │   TUI     │ ─────→ │               │  │
                        │  │ (bubbletea)│ ←─── │               │  │
                        │  └───────────┘ Event │               │  │
                        │                      │   Agent       │  │
                        │  ┌───────────┐   Op   │  (dispatcher  │  │
                        │  │  exec     │ ─────→ │   + loop)     │  │
                        │  └───────────┘        │               │  │
                        │                      │   契约：       │  │
                        │  ┌───────────┐   Op   │   protocol    │  │
                        │  │ scheduler │ ─────→ │   .Op/Event   │  │
                        │  └───────────┘        │   (纯 schema) │  │
                        │                      └───────┬───────┘  │
                        │  ┌───────────┐   Op           │ Event  │
                        │  │ appserver │ ─────→ ────────┘        │
                        │  │ (HTTP)    │ ←─── Event + translate   │
                        │  └─────┬─────┘ to legacy SSE            │
                        │        │ HTTP+SSE                     │
                        └────────┼──────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌────────────┐    ┌────────────┐    ┌──────────────┐
       │  console   │    │  desktop   │    │   mobile     │
       │  (React)   │    │ (Electron  │    │ (React Native│
       │            │    │  + React)  │    │  + 云端代理)  │
       │            │    │            │    │              │
       │ 手写 TS    │    │ 手写 TS    │    │  手写 TS     │
       │ SSEEvent   │    │ SSEEvent  │    │  类型        │
       └────────────┘    └────────────┘    └──────────────┘
```

### 三句话总结

1. **Hono / `http.ServeMux` 是"装配路由的框架"，不是协议本身**。协议是 HTTP+SSE+JSON，框架只是帮你把路由和中间件拼成一个能监听端口的 server。

2. **SpeedClaw 的 TUI 是 in-process，但不是直接函数调用，是 in-process 的 Go channel pub/sub**。所有前端（TUI/exec/appserver/scheduler）共享同一个 `Submit(Op)` + `Events() <-chan Event` 契约，agent 只暴露这一个面。Web/App 端确实和后端分离，走 HTTP+SSE。

3. **appserver 是"前端的一种"，不是中间件**。它把 HTTP 请求翻译成 `Op` 提交给 agent，把 `Event` 翻译成 SSE 发给浏览器。协议在 `internal/protocol/`，相当于 ohbaby 的 `ohbaby-sdk` 契约，但更纯粹（只有数据结构，没有行为接口）。后端 Go 侧所有前端共享一套 `protocol.Op/Event`；前端 TS 侧（console/desktop/mobile）目前用的是**手写的 `SSEEvent` 类型**，不是从 Go 自动生成的——这是 `docs/protocol.md` 里挂着没做完的最后一项。

---

要不要我把这份 SpeedClaw 的分析也写进你的数据库 `agent-harness/server/` 目录下？它可以和昨天那篇 `2026-08-11-tui-inprocess-vs-web-server-split.md` 形成对照——一篇讲 ohbaby 的决策，一篇讲 SpeedClaw 的 codex 模式落地，两篇放一起就是"in-process 通信拓扑的两种实现风格"的双案例。

## User

1.你认为我的ohbabyagent的tui形式是否有必要做解耦？变成事件推送而不是直接的函数调用？ 2.我再确认一下：你说的是：ag.Submit(Op) + <-ag.Events()，走 Go channel 这个go channel是由外部packages依赖定义的？本质上也是在http+sse的基础上实现的？3.来通俗易懂解释！

## Assistant

让我先确认一下 ohbaby-agent 内部到底是"纯函数调用"还是已经有事件总线，这样能给你更准确的判断。

### Tool Ripgrep Raw Search

```
{"pattern":"class Bus|UiEvent|StreamBridge","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src","outputMode":"files_with_matches","caseInsensitive":false,"multiline":false,"toolCallId":"toolu_01HVrmmp9M4Vj89kXmGUeAPE","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess.ts"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess/event-router.ts","limit":80}
```

### Tool Ripgrep Raw Search

```
{"pattern":"interface UiBackendClient|interface UiPromptQueueClient|type UiEventHandler","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src","outputMode":"content","contextAfter":15,"caseInsensitive":false,"multiline":false,"toolCallId":"toolu_013o27iKkVNfFobcCJGEPp66","offset":0}
```

## Assistant

我先把刚才验证到的事实说清楚：**ohbaby-agent 的 TUI 其实已经不是"纯函数调用"了，它内部也有一层事件推送**，这个发现会改变第一个问题的答案。下面按你的三个问题依次说。

---

## 问题 2 先答（这样第 1、3 题才有地基）：Go channel 是什么、是不是建立在 HTTP+SSE 上

**先纠正一个关键误解：不是。Go channel 和 HTTP+SSE 是两种完全不同层次的东西，channel 不是"建立在" HTTP+SSE 之上，反而是 HTTP+SSE 的更底层、更原始的东西。**

### channel 是谁定义的

`chan` 不是某个 package 提供的库，它是**Go 语言内置的关键字**，就像 JS 里的 `Promise`、`async/await` 是语言内置的一样，不需要 import 任何东西：

```go
ch := make(chan int)   // 语言内置语法，不来自任何 package
```

具体到 SpeedClaw 这个例子：

- **channel 的类型**（`chan protocol.Event`）——`protocol.Event` 这个数据形状定义在 `internal/protocol` 包里，这个包**是被其他 package 依赖导入的**（TUI、appserver、exec 都 `import "internal/protocol"`）。
- **channel 的实例**（`submitCh`、`eventSource` 这些具体变量）——是 `*Agent` 这个结构体的私有字段，定义在 `internal/agent` 包内部，**不对外暴露**。外部包只能通过 `ag.Submit(op)` 和 `ag.Subscribe()` 这两个方法"间接"操作它，摸不到 channel 本身。

所以准确说法是：**channel 机制是 Go 语言自带的，具体这几个 channel 变量是 `agent` 包私有实现细节；跨包共享的只是"消息长什么样"（`protocol.Op`/`Event` 类型），不是 channel 本身。**

### channel 和 HTTP+SSE 的真实关系：不是"建立在"，是"两条并行的路"

这是最容易搞混的地方，我画个图：

```
                     ┌─────────── 同一个 Go 进程内 ───────────┐
                     │                                          │
  TUI ──ag.Submit()──┤                                          │
  TUI ←─ch <- event──┤          Agent (内存里)                  │
                     │      submitCh / eventSource              │
                     │      （纯内存指针传递，无序列化）          │
                     └────────────────┬─────────────────────────┘
                                       │
                          appserver 也在同一个进程里
                          调同一个 ag.Subscribe()
                          拿到同一种 Event
                                       │
                                       ▼
                          但 appserver 还要把这个 Event
                          "翻译成文字" 发给远处的浏览器
                                       │
                                       ▼
                     ┌─────── 另一个进程（浏览器）───────┐
                     │   HTTP + SSE（走网卡/socket）      │
                     │   json.Marshal(event) 变成一行文字 │
                     └────────────────────────────────────┘
```

**channel 走的是内存指针，一次 CPU 指令级别的操作，没有网络栈、没有序列化、没有 socket。HTTP+SSE 走的是 TCP 连接、要经过操作系统网络栈、要把 Go 结构体序列化成 JSON 文本、对方还要反序列化回来。**

两者唯一的共同点是：**它们承载的"消息形状"是同一套**（`protocol.Event`）。appserver 是"把 channel 里流出来的 Event，用 `translateEvent()` 转写成 JSON 文本，再通过 HTTP+SSE 这根管子发出去"。这是**转发/翻译**关系，不是"实现"关系——channel 不依赖 HTTP+SSE 才能工作，反而是 HTTP+SSE 这条路是"锦上添花"加出来的，专门服务于"agent 和消费者不在同一个进程"这种场景。

**一句话记住**：channel 是水管里的水（同一屋子里直接流），HTTP+SSE 是把水装瓶子快递到隔壁屋子。装瓶子这个动作是额外做的，水本身（消息内容）没变。

---

## 问题 1：ohbaby-agent 的 TUI 要不要从"直接函数调用"改成"事件推送"

**好消息：不需要改，因为它已经是了。** 我刚才去读了 ohbaby-sdk 的契约定义，发现 ohbaby 的 TUI 从来就不是"纯函数调用、同步等结果"，它早就是"命令用函数调，结果用事件推"的模式：

```63:70:/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/client.ts
export interface UiBackendClient {
  getSnapshot(): Promise<UiSnapshot>;
  getContextWindowUsage(input: {
    readonly sessionId: string;
  }): Promise<UiContextWindowUsage | null>;
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
  listCommands(query: UiListCommandsQuery): Promise<UiSlashCommandCatalog>;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
```

看这个契约的形状：

- `submitPrompt(text)` —— TUI 提交一句话，是个函数调用（发起动作）
- `subscribeEvents(handler)` —— TUI 注册一个回调，之后所有的流式增量、工具调用、状态变化都通过**回调**（不是返回值）推给 TUI

这跟 SpeedClaw 的 `ag.Submit(op)` + `ag.Subscribe()` 是**同一种设计模式**，只是实现手法不同：

| | ohbaby-agent | SpeedClaw |
|---|---|---|
| 发起动作 | `submitPrompt(text)`，async 函数调用 | `ag.Submit(op)`，塞进 channel |
| 接收结果 | `subscribeEvents(handler)`，注册回调，事件来了直接调 `handler(event)` | `ag.Subscribe()`，返回一个 channel，用 `<-ch` 阻塞等 |
| 底层机制 | JS 的 `Set<Handler>` + 遍历调用（EventEmitter 风格） | Go 的 `chan` + goroutine 广播 |
| 契约包 | `ohbaby-sdk` 里的 `UiBackendClient` | `internal/protocol` 里的 `Op`/`Event` |

而且看 `InProcessEventRouter` 的实现，"推事件"这件事早就做了：

```21:29:/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess/event-router.ts
publish(event: UiEvent): void {
  for (const handler of this.handlers) {
    try {
      handler(event);
    } catch {
      // UI event handlers are observers; they must not break backend state.
    }
  }
}
```

`for (const handler of this.handlers) handler(event)` 就是"广播"——跟 SpeedClaw 那个 `runBroadcaster()` 遍历 `subscribers` 把 event 塞进每个 channel，是同一件事，只是 JS 用回调数组、Go 用 channel 集合。

### 所以我的判断是什么

**不需要为了"解耦"这个目的去改动 ohbaby 的 TUI**，因为它已经具备了你想要的那种解耦：命令是"发出去就不管"（`submitPrompt` 内部虽然是 `await`，但那是等业务完成，不是等函数同步返回结果——注意它返回 `Promise<void>`，真正的结果内容是通过后续的事件流带出来的），状态更新走独立的事件订阅通道，而不是"调一次函数拿一次完整结果"这种强耦合的同步调用。

**真正值得思考的问题不是"要不要事件推送"，而是"in-process 实现和跨进程实现是不是共用同一份契约"**——这个 ohbaby 也已经做到了：`createInProcessUiBackendClient`（TUI 用）和 daemon/server 那边的 remote client，都实现同一个 `UiBackendClient` 接口。TUI 走 in-process 的 `event-router.ts`（内存回调），Web 走 `ohbaby-server` 的 SSE（把同一个 `UiEvent` 翻译成 SSE 文本发出去）——这跟 SpeedClaw 的 appserver `translateEvent()` 做的事一模一样。

**唯一可以打的一个"分"是命名上的一致性**：ohbaby 叫它 `submitPrompt`/`subscribeEvents`，SpeedClaw 叫它 `Submit`/`Subscribe`，概念上是同一个模式，只是 SpeedClaw 因为借鉴了 codex，把"命令"这个概念显式抽成了一个叫 `Op` 的类型（一个统一的 union type，31 种变体），而 ohbaby 目前是"每个操作一个具名方法"（`submitPrompt`、`compactSession`、`archiveSession`……）。这是**风格差异**，不是谁更"解耦"——两种都是合法的契约设计，前者（Op 联合类型）在"要不要给这一层加统一的日志/重放/审计"时更方便（因为所有命令都长一个形状，可以统一记录），后者（具名方法）在"IDE 自动补全、类型检查更直接"上更省心。如果你以后想做"重放所有历史命令"这种功能，可以参考 SpeedClaw 的 `Op` 联合类型思路；如果不需要，现在这样没问题。

---

## 问题 3：通俗解释一遍，把三件事串起来

用一个类比说清楚这次搞明白的三件事：

**场景**：你在一家餐厅点菜。

1. **Hono / `http.ServeMux` 是收银台的点单机**：它不是"菜"，是"把顾客的纸条整理归档、分给对应厨师"的工具。前后端真正传的东西是 HTTP 请求和 SSE 消息（菜单和上菜通知），点单机只是帮忙分发。

2. **Go channel 是"厨房内部的传菜口"**：厨师炒完一道菜，往传菜口一放，前台服务员立刻能拿到——这一切都发生在**同一间厨房（同一个进程）里**，没有走出大门，不需要打包、不需要送外卖员。TUI 就是站在传菜口旁边的那个服务员，直接拿现炒的菜（channel），比隔壁桌顾客（appserver 后面的浏览器用户）快得多，因为浏览器那桌必须让服务员把菜**装进外卖盒**（JSON 序列化）**通过外卖小哥**（HTTP+SSE）**送过去**。传菜口（channel）和外卖（HTTP+SSE）是两套完全不同的运输方式，装外卖盒这一步是"多做的一层翻译"，不是"传菜口的实现基础"。

3. **ohbaby 的 TUI 早就是"服务员站传菜口"模式，不是"自己进厨房炒菜"**：你点一句话（`submitPrompt`），厨师在后面炒（agent loop 跑），炒的过程中一有进展就往传菜口丢一次（`subscribeEvents` 收到的每个 `UiEvent`），服务员（TUI）站在那儿一直等、一有就端给你看（渲染出来）。这跟"你说一句话，厨师做完整套菜一次性端给你"（真正的直接函数调用、同步拿完整结果）完全不是一回事——**已经解耦了，不用再改**。

一句话总结三件事：**Hono 是装配工具不是协议；channel 是同屋传菜不是隔屋送外卖；ohbaby 的 TUI 早就是"点单+等上菜"模式，不是"自己进厨房"模式，不需要为了解耦再动它。**

## User

对于你说的“唯一可以打的一个"分"是命名上的一致性：ohbaby 叫它 submitPrompt/subscribeEvents，SpeedClaw 叫它 Submit/Subscribe，概念上是同一个模式，只是 SpeedClaw 因为借鉴了 codex，把"命令"这个概念显式抽成了一个叫 Op 的类型（一个统一的 union type，31 种变体），而 ohbaby 目前是"每个操作一个具名方法"（submitPrompt、compactSession、archiveSession……）。这是风格差异，不是谁更"解耦"——两种都是合法的契约设计，前者（Op 联合类型）在"要不要给这一层加统一的日志/重放/审计"时更方便（因为所有命令都长一个形状，可以统一记录），后者（具名方法）在"IDE 自动补全、类型检查更直接"上更省心。如果你以后想做"重放所有历史命令"这种功能，可以参考 SpeedClaw 的 Op 联合类型思路；如果不需要，现在这样没问题。” 我准备来做优化，把数据结构层面规范化，来和我讨论下怎么做？

## Assistant

这是契约层风格选型，动手前先对齐设计原则和现状边界。我先加载相关 skill，再对照 ohbaby 现有契约一起讨论怎么规范化。

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/SKILL.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/learn-swe-before-after-implement/SKILL.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/swe-architecture-design/SKILL.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/learn-swe-before-after-implement/references/README.md","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/client.ts","limit":150}
```

### Tool Ripgrep Raw Search

```
{"pattern":"^export type UiEvent|type: \\\"","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src","glob":"**/events*.ts","caseInsensitive":false,"multiline":false,"toolCallId":"call-c65a1065-f0f3-4732-adf5-8571db1e562a-76\nfc_c1cc3c19-d8b4-956f-b036-fa4e3e3d4e67_2","offset":0}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent","globPattern":"**/ohbaby-sdk/src/**/*event*"}
```

## Assistant

可以，先讨论、先定边界，再写改造文档。动手前有几条先对齐。

## 先校正目标

你现在想规范化的，其实不是「TUI 还不够解耦」，而是：

> **出站事件已经是 `UiEvent` union；进站命令还是 `UiBackendClient` 上一堆具名方法。要不要把「命令侧」也收成统一数据结构？**

现状其实是**半边已经规范化**：

| 方向 | ohbaby 现状 | SpeedClaw |
|------|-------------|-----------|
| Agent → UI | `UiEvent` 联合类型（约 20+ 变体） | `Event` 联合类型 |
| UI → Agent | `submitPrompt` / `compactSession` / `archiveSession`… 具名方法 | `Op` 联合类型 + `Submit(op)` |

所以这不是「从零发明 Op」，而是：**要不要把进站命令补成和 `UiEvent` 对称的 `UiOp`（或类似命名）**。

---

## 三条候选方案（先别急着抄 SpeedClaw）

### A. 全量 Op 化（SpeedClaw 同构）

所有命令变成 `UiOp` union，对外只剩：

- `submit(op: UiOp): Promise<…>`
- `subscribeEvents(handler)`
- 查询类可选：`request(op)` 等一个匹配 Event

**好处**：日志 / 重放 / 审计 / 统一中间件最好做。  
**代价**：破坏现有 `UiBackendClient` 面；TUI/web/server 全要迁；IDE 补全变差（先选 `type`，再填字段）。  
**风险**：不可逆成本高，像一次协议大迁移。

### B. 双层契约（我更倾向先讨论这个）

保留具名方法做 DX，底下统一落到 `UiOp`：

```ts
// 对外 DX（不变或少变）
client.submitPrompt(text, opts)
client.compactSession(opts)

// 内部/传输/审计层（新增）
type UiOp = { id; type: "user_turn"; ... } | { type: "compact_session"; ... } | ...
dispatch(op: UiOp)  // in-process 与 server 共用
```

**好处**：可渐进；TUI 几乎不用大改；server/日志/重放先吃到统一结构。  
**代价**：两层要同步维护一段时间。  
**可逆性**：高——先加底层，再决定要不要废弃具名方法。

### C. 只规范化「写操作 / 可回放操作」（YAGNI 友好）

只把这些收成 Op：

- `user_turn` / `interrupt` / `steer`（若有）
- `compact` / `archive_session`
- `respond_permission` / `respond_interaction`
- `connect_model` / `set_permission` …

查询继续用方法：`getSnapshot`、`listCommands`、`getCurrentModel`。

**好处**：改动面小，对准「重放/审计」真实价值。  
**代价**：契约仍不对称，以后还可能再扩一轮。

---

## SWE 层面的判断（先别拍板）

- **YAGNI**：若近期没有「命令重放 / 统一审计 / 跨协议同一入口」的硬需求，全量 A 容易变成为抽象而抽象。
- **复杂度**：A 把复杂度压到协议层；C 把复杂度留在「哪些是 Op、哪些不是」；B 短期双轨，长期最稳。
- **不可逆性**：对外删掉具名方法 = 硬契约变更；先加 `UiOp` 内部层 = 可逆。
- **已有不对称其实合理**：Event 天然多样、适合 union；Command 若主要由 IDE/人调用，具名方法更省心。SpeedClaw 全 Op 是因为它学的是 Codex「一个 core、多 shell」——ohbaby 已有 `UiBackendClient` 这层接口，动机不完全一样。

我的倾向：**先走 B，或更窄的 C→B**；不要一上来做 A。除非你明确要「命令日志可回放」作为产品能力。

---

## 动手前必须和你确认的几件事

按改造规划流程，这几项会直接决定文档落点和方案形状：

1. **真正痛点是什么？**  
   更像下面哪一种？  
   - 想做命令审计 / 重放 / 统一中间件  
   - 想让 in-process 与 `ohbaby serve` 共用同一命令形状  
   - 只是觉得数据结构「不整齐」，想对齐 SpeedClaw  
   - 为将来 ACP / 多客户端做准备  

2. **成功标准怎么验收？**  
   例如：所有写操作都能落到带 `id` 的 `UiOp`；server 路径能打出统一 op 日志；TUI 行为零变化。

3. **本批范围**  
   - 只动 `ohbaby-sdk` 类型？  
   - 还要动 `ui-inprocess` / `ohbaby-server` / TUI / web？  
   - Event 侧要不要一起再整理命名？

4. **文档落点偏好**（确认后我再写 problem-list）：  
   - `docs/ohbaby-sdk/`（若已有）  
   - 或 `docs/problem-lists/2026-08-12-ui-op-contract/`  
   - 或你指定路径  

5. **批次**  
   - improve-1：只定义 `UiOp` + in-process 内部落地，对外方法保留  
   - improve-2：server / remote 走同一 Op  
   - improve-3（可选）：再考虑是否废弃具名方法  

---

你先回这几项就行，尤其是 **1（真实痛点）** 和 **3（本批范围）**。  
确认后我按 `plan-code-improvement` 产出讨论与方案文档，本会话先不写代码。

## User

来看看code-cli/ 下的这些优秀项目是如何做的，你可以详细调研，然后分项目来和我讨论这些项目是怎么做的？

## Assistant

先分项目摸清各自的「命令/事件契约」怎么做，再逐个和你对一遍。

### Tool Run Terminal Command V2

### Tool New agent

### Tool New agent

### Tool New agent

## Assistant

调研结论先说清楚：**业界并没有“大家都用 Op union”这一回事。** 更常见的是——**出站事件用判别联合；进站命令用具名方法（HTTP/RPC/接口）**。SpeedClaw/Codex 的全量 Op 是其中一条路，不是唯一正确答案。

下面按项目拆开讲。

---

## 1. Codex —— 「核心 Op 队列 + 对外具名 RPC」双层

**一句话：** 内核是 `Submission{id, op: Op}` ↔ `Event{id, msg: EventMsg}`；TUI 不直接吃 Op，而是走 app-server 的具名 JSON-RPC（`thread/start`、`turn/start`…），再由 server 翻译成 Op。

| 层 | 形态 | 谁用 |
|---|---|---|
| Core SQ/EQ | Rust enum `Op` / `EventMsg` | core + app-server 内部 |
| App-server | 具名 method 字符串 union | TUI / CLI / remote client |

**对你有启发的点：**
- **Op 在“内核队列”最有价值**（统一入队、中断、审批、shutdown）。
- **给人用的面仍是具名方法**——DX 更好。
- SpeedClaw 直接抄了这一层 core 契约；ohbaby 若学 Codex，更贴切的是 **B（双层）**：对外 `submitPrompt`，对内落到 `UiOp`。

关键路径：`codex-rs/protocol/src/protocol.rs`、`app-server-protocol/src/protocol/common.rs`。

---

## 2. Claude Code —— 「消息 union + control subtype」，没有 Submission/Op

**一句话：** stdout 是 `SDKMessage`（`type` 判别联合）；命令侧是 `control_request` + 内层 `subtype`（`interrupt`、`can_use_tool`…），不是 Codex 那种 Op 队列。

**对你有启发的点：**
- 事件侧强类型 union —— 和 ohbaby 的 `UiEvent` 同路。
- 控制命令用 **外层固定信封 + subtype**，介于「具名方法」和「大 Op enum」之间。
- Daemon 只是拉起 worker，**不另立协议** —— 和 ohbaby「默认 CLI in-process、serve 显式」一致。

关键路径：`claude-code-best/src/entrypoints/sdk/coreSchemas.ts`、`controlSchemas.ts`。

---

## 3. OpenCode —— 「具名 HTTP 客户端 + Event 联合」，明确没有 Op

**一句话：** 权威契约是 Effect `HttpApi` 具名端点 → 生成 `sdk.client.session.prompt(...)`；事件是 Schema 判别联合；TUI/App/Embedded **共用同一 HTTP 契约**，本地只换 `fetch` / 事件源。

**对你有启发的点：**
- **业界标杆之一选择了和 ohbaby 现状更接近的路**：命令 = 具名方法，事件 = union。
- 复用靠 **同一 Client + 可插拔传输**，不是靠把命令收成 Op。
- 这强烈支持：**「规范化数据结构」≠「必须引入 UiOp」**；也可以是「把具名方法的载荷类型、错误形状、id 关联再收紧」。

关键路径：`packages/protocol/src/groups/session.ts`、`packages/schema/src/event.ts`、`packages/tui/src/context/sdk.tsx`。

---

## 4. Kimi Code —— 「fake-RPC 具名方法 + 统一 AgentEvent」

**一句话：** 进程内用 JSON 序列化模拟网络的 `createRPC`，对外是具名 SDK API；事件统一 `AgentEvent`；TUI / VS Code / print 共享；transcript 另有 `TranscriptOperation` op union（那是持久化层，不是 UI 命令面）。

**对你有启发的点：**
- **为边界做序列化，但不强行上网络** —— 和 ohbaby in-process 精神一致。
- Op union 出现在 **transcript/审计层**，不是每个 `submitPrompt` 都变成 Op。
- 对应你可选的路径：**C（只规范化可回放写操作）**，甚至「Op 只服务 ledger，不替代 client API」。

关键路径：`packages/agent-core/src/rpc/client.ts`、`packages/protocol/src/events.ts`、`packages/transcript/src/ops/operation.ts`。

---

## 5. Pi —— 「三套并列，TUI 不走 wire」

**一句话：** TUI 直接 `session.subscribe(AgentSessionEvent)`；无头是 JSONL `RpcCommand`；实验性多客户端是 CBOR `Command`/`ServerEvent`——**故意不共用一套 wire**。

**对你有启发的点：**
- 强烈反对「为整齐强行统一所有前端到一种 Op」。
- ohbaby 已有 `UiBackendClient`（TUI）+ server HTTP（web）——可以像 Pi：**共享事件语义，命令传输允许分叉**，只要语义可对齐。

关键路径：`packages/coding-agent/src/core/agent-session.ts`、`modes/rpc/rpc-types.ts`、`packages/protocol/src/schemas.ts`。

---

## 6. Kun —— 「统一 RuntimeEvent SSE + HTTP 命令」，GUI 多一层 IPC

**一句话：** 契约在 runtime：`HTTP /v1/...` + SSE `RuntimeEvent`（`kind` + `seq`）；TUI 直连；Electron 经 IPC 转发同一套。

**对你有启发的点：**
- 和 ohbaby web 路径很像：**事件 union 已规范化；命令仍是 REST 具名路由**。
- 多前端共享靠 **同一 runtime 契约**，不是靠 Op 枚举。

关键路径：`Kun/kun/src/contracts/events.ts`、`kun/src/tui/client.ts`。

---

## 7. SpeedClaw / ohbaby（对照，上次已聊过）

| | SpeedClaw | ohbaby |
|---|---|---|
| 命令 | `Op` union + `Submit` | `UiBackendClient` 具名方法 |
| 事件 | `Event` union | `UiEvent` union（已齐） |
| TUI | 同进程 channel | 同进程 `subscribeEvents` |
| Web | appserver 翻译成 legacy SSE | server 翻译成 HTTP/SSE |

---

## 横向对照（回答「他们到底怎么做」）

```
命令侧（UI → Agent）          事件侧（Agent → UI）
─────────────────────────────────────────────────
Codex core        Op enum      EventMsg union
Codex 对外        具名 RPC     具名 notification
Claude Code       control+subtype   SDKMessage union
OpenCode          具名 HTTP    Event union
Kimi              具名 fake-RPC     AgentEvent union
Pi TUI            进程内方法   AgentSessionEvent
Pi wire           Rpc/Command  ServerEvent
Kun               具名 HTTP    RuntimeEvent union
SpeedClaw         Op union     Event union
ohbaby            具名方法     UiEvent union   ← 你在这
```

**统计直觉：**
- **事件侧几乎人人用 union**（ohbaby 已对齐主流）。
- **命令侧多数是具名方法**；全量 Op 主要是 Codex core / SpeedClaw 这条线。
- **优秀实践常是双层**：内核可 Op/队列化，对外具名；或事件统一、命令按通道分叉。

---

## 对 ohbaby「要不要做 UiOp」的讨论含义

调研后我会把上次建议收紧一点：

1. **不要为了「对齐优秀项目」去做全量 A（只剩 `submit(op)`）** —— OpenCode、Kun、Kimi、Claude 都没这么干；Codex 对外也不是裸 Op。
2. **若动机是审计/重放/统一中间件** —— 学 **Codex 双层** 或 **Kimi transcript Op**：底层加 `UiOp`，对外方法保留（上次的 B/C）。
3. **若动机只是数据结构整齐** —— 更划算的是：
   - 给每个写操作补齐 `clientRequestId` / correlation id
   - 统一错误形状
   - 让 server 与 in-process 的「命令载荷类型」同构  
   而不必引入大 Op enum。
4. **OpenCode 路径**也值得单列：契约权威放在「可生成客户端的具名 API + Event schema」，用传输插拔复用——ohbaby 的 `UiBackendClient` 已经很接近。

---

## 建议我们怎么往下讨论

你更想先深挖哪一个？我可以按你的兴趣展开到「具体类型清单 / 调用链图」：

- **A.** Codex 双层（最贴近「要不要 UiOp」）
- **B.** OpenCode 具名 HTTP + injected fetch（最贴近 ohbaby 现状强化）
- **C.** Kimi fake-RPC + transcript Op（审计层单独 Op）
- **D.** 直接对照出「ohbaby 建议方案草案」（仍先讨论，不写代码）

另外请你拍板一个真实动机（影响选型）：  
**审计重放 / 多前端统一 / 只是契约整齐 / 为 ACP 铺路？**

## User

1.我的动机偏向数据结构整齐，审计 以及多前端统一 2.优秀实践常是双层，什么是“双层” ohbaby-agent是否要做双层？是否是过度设计？看看swe原则？ 3.什么叫“具名方法”说清楚一些，都是中文字但我似乎听不懂 4.来看看我们的项目现状，来提一些修改/优化建议，去学习借鉴code-cli/下优秀项目的做法

## Assistant

先把三个概念讲清楚，再对照 ohbaby 现状和 SWE 原则给建议。我会补读契约层和 SWE 文档，避免空谈。

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/learn-swe-before-after-implement/references/00-philosophy.md","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/learn-swe-before-after-implement/references/03-design-principles.md","limit":120}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages","globPattern":"**/ohbaby-sdk/src/**/*.ts"}
```

### Tool Ripgrep Raw Search

```
{"pattern":"UiBackendClient|createInProcessUiBackendClient|createRemote","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent","glob":"*.{ts,md}","caseInsensitive":false,"headLimit":40,"multiline":false,"toolCallId":"call-b308524c-5a2c-4663-aa48-9ea5b26421b4-85\nfc_01f53241-ea9b-9971-9369-52e218645267_3","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/rpc/types.ts"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/rpc/proxy.ts","limit":120}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/index.ts"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/events.ts","limit":80}
```

### Tool Ripgrep Raw Search

```
{"pattern":"submitPrompt\\(|subscribeEvents\\(|client\\.compactSession","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli","glob":"**/*.{ts,tsx}","caseInsensitive":false,"headLimit":25,"multiline":false,"toolCallId":"call-12ce17fb-603a-4d4d-a53d-7ed0b9c2af58-90\nfc_8efc3122-d986-9b19-b626-39b7d6e1d052_0","offset":0}
```

### Tool Ripgrep Raw Search

```
{"pattern":"submitPrompt|compactSession|/v1/","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-server/src","glob":"**/*.{ts,tsx}","caseInsensitive":false,"headLimit":30,"multiline":false,"toolCallId":"call-12ce17fb-603a-4d4d-a53d-7ed0b9c2af58-91\nfc_8efc3122-d986-9b19-b626-39b7d6e1d052_1","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/goals-duty.md","limit":80}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk","globPattern":"**/*"}
```

### Tool Ripgrep Raw Search

```
{"pattern":"method:|\\\"submitPrompt\\\"|rpc","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-server/src","glob":"**/*.{ts,json}","caseInsensitive":false,"headLimit":40,"multiline":false,"toolCallId":"call-47ffff51-8182-4d2e-b7e0-2cbe9c58bc83-94\nfc_73bb64a6-b134-9bfe-98e5-47f7b63507b7_0","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/data-model.md","limit":80}
```

### Tool Ripgrep Raw Search

```
{"pattern":"submitPrompt|/v1/prompts|executeCommand","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src","glob":"**/*.{ts,tsx}","caseInsensitive":false,"headLimit":25,"multiline":false,"toolCallId":"call-47ffff51-8182-4d2e-b7e0-2cbe9c58bc83-96\nfc_73bb64a6-b134-9bfe-98e5-47f7b63507b7_2","offset":0}
```

### Tool Ripgrep Raw Search

```
{"pattern":"interface OhbabyWebClient|submitPrompt\\(","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web","glob":"**/*.{ts,tsx}","caseInsensitive":false,"headLimit":20,"multiline":false,"toolCallId":"call-f1aa0e09-38b7-403f-b9bf-5520de147daa-97\nfc_98087aba-8bff-956b-a5b7-204d8bf3b0c6_0","offset":0}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src","globPattern":"**/api/**/*.ts"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/prompt.ts","limit":80}
```

## Assistant

先把词说成人话，再对照现状给建议。你的三个动机（整齐、审计、多前端统一）会直接决定「要不要双层」。

---

## 3. 什么叫「具名方法」——用点菜说清楚

假设餐厅有两种点单方式：

**方式一：具名方法 = 菜单上每一道菜都有自己的按钮**

```
submitPrompt("帮我改这个 bug")     ← 按钮叫「提交对话」
compactSession()                 ← 按钮叫「压缩上下文」
archiveSession({ sessionId })    ← 按钮叫「归档会话」
abortRun(runId)                  ← 按钮叫「中断」
```

每个动作有**自己的函数名**。你在编辑器里打 `client.`，IDE 会列出这些按钮。参数形状也跟着这个函数走。

这就是 ohbaby 现在的 `UiBackendClient`：

```63:94:/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/client.ts
export interface UiBackendClient {
  getSnapshot(): Promise<UiSnapshot>;
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
  compactSession(...): Promise<UiCompactSessionResult>;
  archiveSession(input: UiArchiveSessionInput): Promise<void>;
  executeCommand(invocation: UiSlashCommandInvocation): Promise<void>;
  respondPermission(...): Promise<void>;
  abortRun(runId?: string): Promise<void>;
  // ... 还有一串
}
```

**方式二：统一 Op = 只有一个「下单」窗口，菜名写在纸条上**

```
Submit({ type: "user_turn", text: "帮我改这个 bug" })
Submit({ type: "compact_session" })
Submit({ type: "archive_session", session_id: "..." })
```

对外只有一个函数 `Submit`。差别全在那张纸条（数据结构）的 `type` 字段。

SpeedClaw / Codex 内核走的是这种方式。

**对照：**

| | 具名方法 | 统一 Op |
|---|---|---|
| 人怎么用 | `client.submitPrompt(text)` | `client.submit({ type: "user_turn", text })` |
| 编辑器补全 | 直接列出动作名 | 先选 type，再填字段 |
| 记日志 | 要给每个函数分别打点 | 一张纸条原样记下就能重放 |
| 像什么 | 每个菜一个按钮 | 一张总订单 |

两种都合法。**「具名」= 这个动作在代码里有自己的名字**，不是「有名字的变量」这种空话。

---

## 2. 什么叫「双层」？ohbaby 要不要做？是不是过度设计？

### 双层不是「再加一个包」

是**两张脸对着两种使用者**：

```
给人用的脸（外层）          给机器用的脸（内层）
TUI / 你写代码时            日志 / 审计 / 跨进程转发
─────────────────          ─────────────────────
submitPrompt(text)    →    { type: "submitPrompt", args: [...] }
compactSession()      →    { type: "compactSession", args: [...] }
```

**Codex 就是这样：**
- 内核：`Op` 枚举（机器好排队、好记）
- 对外：`thread/start`、`turn/start` 这种具名 RPC（人好用）
- 中间有一层翻译

**OpenCode 也是「弱双层」：**
- 人用：`sdk.client.session.prompt(...)`
- 机器用：同一请求其实是 `POST /api/session/:id/prompt`（HTTP 路径就是那张纸条）
- 本地 TUI 不换 API，只换「怎么运」：内存里的 `fetch` vs 真 HTTP

所以双层的意思是：

> **不要逼人只用 Op，也不要让机器去调 15 个不同函数才能记日志。**  
> 人走具名方法；机器走一份能原样序列化的命令记录。两层翻译一次。

### ohbaby 要不要做双层？用 SWE 过一遍

你的动机是：**数据结构整齐、审计、多前端统一**。这三条里，**后两条会真正用到「内层那张纸条」**；第一条单独不够格上大改。

| 原则 | 判断 |
|------|------|
| **本质 vs 偶然复杂度**（00） | 「TUI 和 Web 命令形状不一致、审计没法原样重放」是本质痛点。把对外 API 改成只剩 `Submit(op)` 是**自己制造的偶然复杂度**（所有调用点、IDE、测试全要改）。 |
| **YAGNI** | 现在没有「命令录像机产品」。为了想象中的重放，把 TUI 改成只认 Op = 过度设计。 |
| **KISS** | 更简单的做法：保留 `submitPrompt`，在边界处**自动拍一张命令快照**（method + args + id）。 |
| **DRY（知识的单一来源）** | 该统一的是「命令长什么样」这一份知识，不是「人怎么调用」这一份知识。人用方法和机器用纸条可以描述同一件事。 |
| **OCP 护栏** | 「先为扩展搭抽象」正是 OCP 最容易用坏的地方。第二次前端已经存在（Web），所以**补一份命令信封**有证据；**砍掉具名方法**没有证据。 |
| **货物崇拜** | SpeedClaw 全 Op，是因为它学 Codex、且 TUI/HTTP/cron 都从零接到同一 `Submit`。ohbaby 已经有 `UiBackendClient`，再拆掉等于推倒重来。 |

**结论：要做「薄双层」，不要做「SpeedClaw 那种只剩 Submit」。**

- **该做：** 内层有一份统一的命令记录（为审计、为 TUI/Web/RPC 对齐）。
- **不该做：** 对外取消 `submitPrompt` / `compactSession`，强迫所有人写 `{ type: "..." }`。
- 这不是再叠一层架构，而是承认：**人接口和线协议本来就该是两件事**，ohbaby 现在把它们糊成了一块，Web 又偷偷长出了第三块。

过度设计的分界：  
- 薄双层 = 给已有的 15 个方法配一张「可序列化信封」+ 统一 id。成本低、可逆。  
- 厚双层 = 再搞 dispatcher、Op 队列、废弃旧 API。那才是过度。

---

## 4. 项目现状：已经半整齐，真正乱的地方在别处

对照代码，现状比「要不要引入 Op」更具体：

### 已经对齐优秀项目的部分

1. **出站事件已经是 union**：`UiEvent` 带 `type: "message.appended"` 等（学 OpenCode / Kun / Kimi 的事件侧）。
2. **G4 事件优先**已写进 `docs/ohbaby-sdk/goals-duty.md`：方法只表示「请求已提交」，结果走事件。
3. **TUI 已是 subscribe + submit**，不是同步拿完整结果。
4. **已有一层 fake-RPC**（`packages/ohbaby-sdk/src/rpc/`）：`createRPC` 用 JSON 克隆模拟跨边界——和 Kimi 的 `createRPC` 几乎同款。
5. **Server 的 JSON-RPC 已经在用方法名字符串**：`{ method: "submitPrompt", params }`。机器脸其实有了雏形，只是没当一等公民。

### 真正不整齐、会挡「审计 + 多前端」的地方

**乱点 1：TUI 和 Web 的「提交一句话」不是同一个形状**

TUI / SDK：

```ts
submitPrompt(text: string, options?: { sessionId?, clientRequestId? }): Promise<void>
```

Web：

```ts
submitPrompt(input: SubmitPromptRequest): Promise<PromptAcceptedResponse>
```

同一个动词，参数一个是 `(字符串, 可选对象)`，一个是「整个对象」；返回一个是 `void`，一个是回执。  
**多前端统一首先卡在这里**，不是卡在有没有 `Op` 这个名字。

**乱点 2：命令侧没有「一张能原样记下的纸条」**

事件有 `type` 字段，能进日志。  
命令是 15 个函数，审计想记「刚才发生了什么」，只能：
- 给每个函数分别打日志，或
- 记 JSON-RPC 的 `{ method, params }`（仅 server 路径有）

TUI in-process 路径甚至不经过 RPC，审计缺口更大。

**乱点 3：三套「客户端」知识重复**

| 谁 | 接口 |
|---|---|
| TUI / run | `UiBackendClient` |
| SDK RPC 拆分 | `CoreAPI` + `SDKAPI`（几乎是 client 再抄一遍） |
| Web | `OhbabyWebClient`（手写，形状已漂移） |

这违反 DRY：**「UI 能对 backend 做什么」应该只有一份权威。** OpenCode 的做法是一份 HttpApi，生成所有客户端。

**乱点 4：关联 id 不完整**

Prompt 已有 `clientRequestId`（很好，审计刚需）。  
`compactSession` / `archiveSession` / `setPermission` / `abortRun` 没有统一的「这次操作的 id」。事件侧靠 type 能追，命令侧对不齐。

**乱点 5：写操作和读操作混在一个胖接口里**

`getSnapshot`、`listCommands` 是问询；`submitPrompt`、`abortRun` 是改变世界。  
审计只关心后者。混在一起，就很难规定「哪些必须记、哪些必须带 id」。Kun / OpenCode 用 HTTP：GET 是读，POST 是写，边界清楚。

---

## 建议：学优秀项目，但只抄和你动机匹配的部分

动机对齐后的学习清单：

| 学谁 | 学什么 | 不学什么 |
|------|--------|----------|
| **OpenCode** | 一份契约、多前端共用；本地只换运输（fetch） | 先上全套 OpenAPI 生成（可后置） |
| **Codex** | 内层可记录、外层对人友好（双层） | 不把 TUI 改成直接喂 `Op` |
| **Kimi** | fake-RPC 保边界；**transcript 才用 Op**（审计层单独） | 不为整齐再造一套 WS |
| **Kun** | 事件带 `seq`；写走 POST、读走 GET | 不把 TUI 也改成必须 HTTP |
| **Claude** | 控制命令用信封 + subtype，事件继续 union | 不改成 NDJSON 主协议 |
| **SpeedClaw** | 命令/事件都有 `id` 可关联 | 不砍具名方法 |

### 推荐改法（薄双层，分三步，可停）

**第一步（对齐你的三个动机，建议就做这些）**

在 `ohbaby-sdk` 增加**命令信封**，不改 TUI 调用习惯：

```ts
type UiCommandEnvelope = {
  id: string;           // 这次操作的 id，审计/重放用
  method: "submitPrompt" | "compactSession" | "abortRun" | ...;
  params: unknown;      // 就是那个具名方法的参数
  at: string;           // 时间
};
```

落地：
1. `UiBackendClient` 每个**写方法**内部先组信封，再执行。
2. in-process 和 server **共用**这个信封（server 的 JSON-RPC 本来就是 `{ method, params }`，对齐即可）。
3. 打一条结构化审计日志：信封进、对应 `UiEvent` 出（用 `id` 关联）。
4. **把 Web 的 `submitPrompt({...})` 收回到 SDK 的同一套参数/回执类型**——这是多前端统一的最大一块。TUI 可继续 `submitPrompt(text, opts)` 作为语法糖，底层同一信封。

学的是：Codex 双层、Kimi「审计用 Op」、OpenCode「一份契约」。  
**TUI 代码几乎不用改调用方式。**

**第二步（多前端真正统一）**

规定：**Web / TUI / `ohbaby run` / remote attach 都只依赖 `UiBackendClient`（或它的超集 `UiPromptQueueClient`），禁止再发明 `OhbabyWebClient` 这套平行接口。**

Web 的 HTTP 层变成「信封的一种运输」，就像 OpenCode 的 injected fetch：  
- TUI：内存直接调  
- Web：HTTP/SSE 运同一信封和同一 `UiEvent`

`CoreAPI` / `SDKAPI` 能并回 `UiBackendClient` 就并，少抄一份。

**第三步（有证据再做，现在不做）**

- 对外只留 `submit(envelope)`  
- 命令录像机 / 重放 UI  
- ACP 适配  

等第一步的信封真的被日志和 Web 用起来，再考虑。现在做 = YAGNI。

---

## 一张图把现状和目标放一起

```
现在：

  TUI  ──submitPrompt(text)──►  in-process 函数
  Web  ──submitPrompt({obj})─►  另一套 OhbabyWebClient ──HTTP──► server
  RPC  ──{ method, params }──►  第三种形状
  事件 ◄── UiEvent union ── 这条已经整齐


目标（薄双层）：

  人：TUI/Web 仍调用 submitPrompt / compactSession   （具名方法，好用）
           │
           ▼ 自动翻译（只在这一处）
  机器：UiCommandEnvelope { id, method, params }     （整齐、可审计、可转发）
           │
           ├─ in-process 执行
           ├─ HTTP/JSON-RPC 执行（Web / attach）
           └─ 审计日志原样落下
  回来仍是同一套 UiEvent（已经有了）
```

---

## SWE 一句话立场

- **要整齐**：统一的是「命令信封 + 事件 union」，不是「人只能 Submit」。
- **要审计**：给写操作统一 `id`，进出都能对上；学 Kimi 把 Op 放在记录层，而不是 UI API。
- **要多前端**：先消灭 Web 与 SDK 的接口漂移，比引入 31 个 Op 变体更值钱。
- **不要**：为了像 SpeedClaw，把已经能用的具名方法拆掉——那是货物崇拜，增加偶然复杂度。

如果你认这个方向，下一步可以按 `plan-code-improvement` 把「命令信封 + Web 客户端收回 SDK」写成 `docs/` 下的改造文档（先讨论范围和落点，再写 00–04）。你更想先定文档落点，还是先把「写操作清单 / 哪些必须带 id」列成一张表一起过？

## User

1.确认这样的方向！工作量较大建议分批进行实施规划 2.所以不要为了统一op增加复杂度，重要是把web和tui命令形状一致，并优化审计部分 3.做薄双层，同时把入站事件：TUI 和 Web 端统一 4.命令侧需要进行记录 5.客户端」知识重复问题重构，建议全部放在sdk契约中，你认为呢？ 6.关联 id 不完整也需要优化，统一关联的id 7.写操作和读操作混在一个胖接口里这也需要修改，crud操作分清楚边界 8.冗余规范/契约清理与旧代码删除 9.注意UiCommandEnvelope是tui/web一层“翻译”，保持单一职责kiss 10.基于swe原则来回顾一下，然后来和我按照plan-code-improvement从多角度进行讨论，完成后准备进行文档撰写(文档放置位置docs/也可以讨论一下)

## Assistant

方向已确认。先核对 TUI/Web 实际吃的事件形状、客户端重复面和文档落点，再按改造规划做多角度讨论。

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/client.ts","limit":120}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/wire.ts","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/architecture.md","limit":80}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/problem-lists","globPattern":"**/*"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/wire.ts","offset":80,"limit":80}
```

### Tool Ripgrep Raw Search

```
{"pattern":"type TuiEvent|UiEvent|subscribeEvents","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli/src/tui","glob":"**/*.{ts,tsx}","caseInsensitive":false,"headLimit":25,"multiline":false,"toolCallId":"call-0fbd32b7-8bd5-4dd3-aa7a-5f8070b549df-105\nfc_28f71b28-e70b-9e5b-8e6c-10120606001e_1","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/discussion-guide.md","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli/src/tui/store/snapshot.ts","offset":70,"limit":40}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/wire.ts","offset":200,"limit":50}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/analysis-dimensions.md","limit":80}
```

## Assistant

方向按你列的 1–9 收口。下面用 SWE 过一遍，再按改造规划把**已确认 / 建议批次 / 还差你拍板的几项**摊开。确认落点后就开始写文档。

---

## 先把「入站事件」对齐成同一句话

你说的「入站事件：TUI 和 Web 统一」，我按**前端收到的那条流**理解（agent → UI），不是再发明一套 Op。

现状其实已经「半统一」：

- **内核事件**两边都声称用 `UiEvent`（`ohbaby-sdk`）。
- **TUI 又加了一层** `TuiEvent = SdkUiEvent | 本地补丁`（`message.part.delta` 字段更严、`snapshot.replaced` 再写一遍）——见 `packages/ohbaby-cli/src/tui/store/snapshot.ts`。
- **Web 外包了一层运输信封** `WebSseEvent`：`hello` / `ui.event` / `resync-required` / `error`，里面的 `event` 才是 `UiEvent`——见 `apps/ohbaby-web/src/api/daemon/wire.ts`。

建议边界（KISS / SRP）：

| 该进 SDK | 不该进 SDK |
|----------|------------|
| `UiEvent` 本身，TUI/Web 消费同一份 | SSE 的 `hello` / `resync-required`（运输/连接态，只 Web 需要） |
| TUI 那些「补丁字段」能并回 `UiEvent` 就并回去 | 工作区切换、目录选择器（host 能力，不是会话契约） |

**运输信封 ≠ 业务事件。** 薄双层里：业务事件只有 `UiEvent`；Web 的 SSE 包装留在 server/web 适配器。

---

## SWE 回顾（对照你 10 条）

**复杂度：** 本质痛点是「同一件事三种说法 + 审计对不齐」。偶然复杂度是再做一个全民 `Submit(op)`。你选薄双层，是在砍偶然复杂度。

**YAGNI / KISS：** 不统一成 Op。Envelope 只在边界翻译，调用方仍写 `submitPrompt`。同意第 9 条——Envelope 不是第三套给业务用的 API。

**DRY：** 「UI 能对 backend 做什么」只应在 SDK 有一份权威。`CoreAPI`、`SDKAPI`、`OhbabyWebClient`、`TerminalClient` 是同一知识的副本。同意第 5 条进 SDK，但有一条护栏（见下）。

**ISP（接口隔离）+ 你第 7 条：** 胖 `UiBackendClient` 要拆，但建议拆成 **Query / Command**（读/写），不要机械拆成 REST 式 CRUD 四个接口。Agent 不是资源服务器：`submitPrompt` 不是 Create Row，`getSnapshot` 不是 Read Row。边界是「问世界」vs「改世界」。

**SRP：**  
- SDK：契约（类型 + 纯函数）  
- Envelope 翻译：适配器一层（in-process 与 HTTP 各一处，或共享一个纯函数 `toEnvelope`）  
- 审计：消费信封的记录器，不塞进 TUI 组件  

**DIP：** TUI/Web 依赖 SDK 抽象；实现（in-process / HTTP）依赖同一抽象。Web 不再自己定义平行 `OhbabyWebClient`。

**错误抽象 vs 重复：** 把「工作区列表 / 目录选择器 / SSE 重连」硬塞进 SDK，会让 TUI 依赖它用不到的方法（违反 ISP，也违反 SDK 的 G2 零业务/零 host）。**会话契约进 SDK；host 能力留在 server/web。**

**可逆性：** 加信封 + 拆接口 + 对齐参数 = 可逆。删旧客户端、改 Web 调用点 = 一批迁移，要分批、可兼容一段时间。

---

## 对你第 5 条的明确意见：全部放 SDK？「是，但只放会话契约」

**该进 `ohbaby-sdk` 的权威面：**

- 读：`getSnapshot`、`getContextWindowUsage`、`listCommands`、`getCurrentModel`、`probeModelContextWindow`
- 写：`submitPrompt`、`compact`、`archive`、`executeCommand`、permission/interaction 响应、`abort`、connect/search/permission 变更、prompt 队列那一组
- 事件：`UiEvent` + `subscribeEvents`
- 命令信封：`UiCommandEnvelope`（给翻译层和审计，不给页面当主 API）
- 关联 id：写操作入参带 `clientRequestId`（或统一 `commandId`），事件带回同一 id

**不该进 SDK 的（否则 SDK 变成桌面壳）：**

- `listWorkspaceScopes` / `openWorkspace` / 目录选择器
- `connect()` / `close()` / 连接五态
- `WebSseEvent` 的 hello/resync
- TUI 专有的渲染态（`commandNotices` 投影可以留在 TUI，源事件仍是 `UiEvent`）

Web 客户端应变为：**实现 SDK 的 Query+Command 接口** + **另持一个很窄的 `WorkspaceHostClient`（或 server 专有 API）**。这才是多前端统一，而不是把 Web 的所有方法都抬进 SDK。

`createRPC` / `CoreAPI` / `SDKAPI`：目标是并回同一套接口后删除重复类型；fake-RPC 若仍被测试/边界使用可留实现，但**不要再维护第二套方法表**。

---

## 第 6、7、8 条怎么落到设计上（避免做大）

**关联 id：** 不要每种操作一个新 id 体系。一条规则：

- 每次写操作生成 `clientRequestId`（已有 prompt 这条，推广到 compact/abort/archive/command/permission…）
- Envelope.`id` = 这个 id
- 由该操作引起的 `UiEvent` 带同一 `clientRequestId`（没有的就补；广播类如 `snapshot.replaced` 可空）
- 禁止再发明 `opId` / `commandId` / `traceId` 三套名字并存——先定一个权威名（建议就用已有的 `clientRequestId`）

**读/写拆分：**

```ts
interface UiQueryClient { getSnapshot(); listCommands(); ... subscribeEvents(); }
interface UiCommandClient { submitPrompt(); compactSession(); abortRun(); ... }
type UiBackendClient = UiQueryClient & UiCommandClient
```

TUI 仍拿到合集（方便）。审计只包 `UiCommandClient`。测试可以只 mock Query。这就是 ISP，不是上 CQRS 框架。

**冗余清理（第 8 条）必须单独一批：** 先新契约可用、两端切过去，再删 `OhbabyWebClient` 平行方法、`CoreAPI` 重复、`TuiEvent` 补丁、过时 JSON-RPC 方法名。不要第一批又改形状又删代码，回滚会很痛。

---

## 薄双层 + Envelope 的职责（第 9 条钉死）

```
TUI/Web 页面
    │  仍调用 submitPrompt(text, opts)   ← 人用的脸
    ▼
适配器（唯一翻译点）
    │  toEnvelope(method, params) → 记录审计 → 执行
    ▼
in-process 或 HTTP
    │
    ▼
UiEvent（同一份）→ TUI store / Web store
```

Envelope **不是** TUI 组件的依赖。页面不知道信封。这才 SRP。

---

## 分批（工作量大，必须切开）

建议四批，每批可独立合并、可停：

| 批次 | 目标 | 做什么 | 明确不做 |
|------|------|--------|----------|
| **improve-1 契约** | SDK 成为唯一会话契约 | 拆 Query/Command；统一写操作入参（含 `clientRequestId`）；定义 Envelope 类型与 `toEnvelope` 纯函数；`UiEvent` 补关联字段；TUI 补丁能并的并进 `UiEvent` | 不改 Web 页面行为；不删旧类型；不上 Op union |
| **improve-2 形状对齐** | TUI 与 Web **命令形状一致** | Web `submitPrompt` 等收到 SDK 同一签名/回执；Web 客户端实现 SDK 接口；SSE 仍运 `UiEvent` | 不强制 TUI 走 HTTP；workspace API 仍留 web/server |
| **improve-3 审计** | 写操作可记录、可关联 | in-process 与 server 在翻译点记 Envelope；事件用同一 id 对上；规定日志字段 | 不做重放 UI、不做命令录像机产品 |
| **improve-4 清理** | 删重复与死代码 | 删/废弃 `CoreAPI` 重复面、`OhbabyWebClient` 漂移方法、无用 TuiEvent 分支、过时 RPC 别名 | 不顺手做功能 |

improve-1 没有用户可见变化，风险最低，适合先做。  
你要的「命令形状一致 + 事件统一」在 1+2；「审计」在 3；「旧代码删除」在 4。符合「复杂度要用证据挣得」：每一批都有已存在的痛点，不是预防未来。

---

## 七维讨论（规划文档会按这个写 01）

1. **goals-duty：** SDK 已写「TUI/CLI/remote 共享协议」（G1/G4），代码却允许 Web 另立 client。改造是补职责，不是新发明。Host 能力不要写进 SDK duty。
2. **architecture：** 依赖应是 `ui → sdk ← agent/server`。现在 `ohbaby-web` 自己定义命令形状，依赖方向歪了。Envelope 只存在 adapter，避免 SDK 变成 runtime。
3. **data-model：** 权威实体：`UiSnapshot`、`UiEvent`、写操作入参、`UiCommandEnvelope`、`clientRequestId`。同名不同义（两套 `submitPrompt`）是 01 要列的第一问题。
4. **数据流：** 写：UI → 具名方法 → 信封 → 执行 → 事件。读：`getSnapshot` / 订阅。审计只挂写路径。
5. **用例：** 同一句 prompt 在 TUI 与 Web 的入参/回执一致；中断、压缩、归档可按 id 在日志里对上事件；刷新 Web 仍靠现有 SSE replay（不塞进 Envelope）。
6. **非功能：** 审计不能拖慢 TUI 热路径（同步内存记一条即可）；Envelope 序列化失败不能阻断发 prompt。
7. **测试：** SDK 契约测试（信封往返、id 贯穿）；TUI/Web 各一条「同一 submitPrompt 形状」；清理批用编译器保证旧符号消失。

**明确不做（整次改造）：** 全量 Op、砍具名方法、TUI 默认改 HTTP、ACP、命令重放产品、把 workspace picker 塞进会话契约。

---

## 文档放哪

议题核心是 **ohbaby-sdk 契约 + 两端适配**，不是某一个 runtime 子模块。

**推荐：**

`docs/ohbaby-sdk/2026-08-13-surface-contract-unification/`

理由：`docs/ohbaby-sdk/` 已有 goals-duty / architecture / data-model，这次会回头改这些权威文档；改造文档跟模块走，以后找得到。

其下按你确认的分批：

```
docs/ohbaby-sdk/2026-08-13-surface-contract-unification/
  README.md
  00-discussion.md          ← 整次改造的已确认决策
  improve-1/                ← 先写这一批的 01–04？还是四批规划都写在 02 里？
  ...
```

两种写法请你选：

- **A.** 一份 00–04 总规划，02 里写清 improve-1～4；每批实施时只看 02 对应节（改动面大但决策一处）。
- **B.** 总 00 + README，然后每批一个 `improve-N/` 自己的 01–04（更符合 skill 默认，文档多）。

我建议 **A 为主、improve-1 单独把「本批改动面」写细**：总决策不散，第一批又能直接开工。

备选：`docs/problem-lists/2026-08-13-surface-contract-unification/`（和 server 那次一样）。跨 sdk/cli/web/server，放 problem-lists 也成立；但权威模块文档在 sdk，我仍更倾向 `docs/ohbaby-sdk/`。

---

## 请你拍板的 5 件事（回完就写文档）

1. **文档落点：** `docs/ohbaby-sdk/2026-08-13-surface-contract-unification/` 可以吗？文档结构选 A 还是 B？
2. **「入站事件统一」：** 是否同意 = TUI/Web 都只消费 SDK 的 `UiEvent`；SSE `hello/resync` 不算业务事件、不进 SDK？
3. **SDK 边界：** 是否同意 workspace/目录选择器/连接态留在 web-server，不进 `UiBackendClient`？
4. **关联 id 名字：** 统一用现有 `clientRequestId`，还是改成更中性的 `commandId`？（改名迁移成本更高，我倾向沿用 `clientRequestId`。）
5. **第一批范围：** 是否就是 improve-1（只动 SDK 类型/拆接口/信封纯函数/事件补 id），TUI/Web 行为下一批再对齐？

你这 10 条里，和我有出入的只有第 5 条的范围：**会话契约进 SDK，host 能力不要进。** 其余我按已确认写入 00。

## User

1.建议文档落到docs/ohbaby-sdk/2026-08-13-surface-contract-unification/下，文档结构选择a，但是注意统一在improve-1中完善，improve-1其中内部分批，这属于一轮优化，而不是4轮。所以improve-1即可，内部分批次进行 2.同意 TUI/Web 都只消费 SDK 的 UiEvent；SSE hello/resync 不算业务事件、不进 SDK 3.同意 workspace/目录选择器/连接态留在 web-server，不进 UiBackendClient 4.用现有 clientRequestId 5.建议把你的实施步骤/批次按照improve-1内分批次进行 6.冗余清理单独一批确认，但是注意在实施前先和我明晰命名语义，改完后再来单独一批进行冗余清理 7.还有什么问题吗？准备把我们的讨论内容归类到discussion文档中，然后撰写文档，注意文档内容中文语义准确，不要说“黑话”，听不懂的中文，遵循中文语义，通俗易懂但不失专业性，完成后做文档自检和对齐！

## Assistant

按约定只做一轮 `improve-1`（内部分批），清理单独后置。先读撰写指南和现有文档风格，再落完整文档集。

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/discussion-guide.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/problem-analysis-guide.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/optimization-plan-guide.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/reference-projects-guide.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/test-acceptance-guide.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/document-self-check.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/test.md","limit":60}
```

### Tool Ripgrep Raw Search

```
{"pattern":"createRPC|CoreAPI","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent","glob":"*.{ts,tsx}","caseInsensitive":false,"headLimit":30,"multiline":false,"toolCallId":"call-fa32fdfa-4f8b-47f1-ba3e-faf2f59d47e2-117\nfc_e35218a3-c772-96a4-85dc-1fcfbd9e9763_1","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/architecture.md","offset":75}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent","globPattern":"**/test-blueprint/**"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/test-blueprint/SKILL.md","limit":40}
```

### Tool Read File V2

```
{}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/events.ts","offset":80,"limit":140}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/client.ts","limit":120}
```

### Tool Ripgrep Raw Search

```
{"pattern":"type TuiEvent|submitPrompt","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent","glob":"*.{ts,tsx}","caseInsensitive":false,"headLimit":40,"multiline":false,"toolCallId":"call-783236eb-96be-40b5-a54f-6c87d1cb1aff-14\nfc_c5976fc2-65a1-937d-9bbf-654706b34202_1","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/prompt.ts","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/wire.ts","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/rpc/types.ts","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/goals-duty.md","limit":80}
```

### Tool Ripgrep Raw Search

```
{"pattern":"submitPrompt|interface OhbabyWebClient","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon","caseInsensitive":false,"multiline":false,"toolCallId":"call-07a15e4a-2848-475c-ae88-851f61d62932-19\nfc_3997240b-7208-9b86-96cc-5f5bb76a9065_0","offset":0}
```

### Tool Ripgrep Raw Search

```
{"pattern":"type TuiEvent|TuiEvent =","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli/src/tui","caseInsensitive":false,"multiline":false,"toolCallId":"call-07a15e4a-2848-475c-ae88-851f61d62932-20\nfc_3997240b-7208-9b86-96cc-5f5bb76a9065_1","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/data-model.md","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/wire.ts","offset":80,"limit":100}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-cli/src/tui/store/snapshot.ts","offset":70,"limit":30}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/wire.ts","offset":180,"limit":70}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/client.ts","offset":49,"limit":80}
```

### Tool Read File V2

```
{}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs","globPattern":"**/README.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/SKILL.md","limit":40}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/mcp/improve-1/README.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/agents/improve-1/README.md","limit":80}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/learn-swe-before-after-implement/SKILL.md","limit":80}
```

## Assistant

开始撰写完整文档集：一轮 `improve-1`、内部分批，命名语义先写清供你确认。

### Tool Read File V2

```
{"path":"/Users/hansunwork26/.codex/skills/plan-code-improvement/references/analysis-dimensions.md","limit":80}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent","globPattern":"docs/ohbaby-sdk/*"}
```

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

## Assistant

正在做文档自检：核对交叉引用，并把难懂的术语改成更清楚的中文。

### Tool Ripgrep Raw Search

```
{"pattern":"cargo-cult|surface|YAGNI|ISP|Op 联合|具名|真源|additive|host","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification","caseInsensitive":false,"multiline":false,"toolCallId":"call-f8755774-9421-4970-93fb-86f5b8ef3c56-40\nfc_f0262bbe-3c9d-969e-93e6-bf13df5b3c62_0","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/dfd-interface.md","limit":40}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification","globPattern":"**/*"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/README.md","limit":15}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/03-reference-projects.md","limit":10}
```

### Tool Glob File Search

```
{"targetDirectory":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification","globPattern":"README.md"}
```

## Assistant

文档被分到了两处。按「落在该目录下、只做一轮 improve-1」收拢到 `improve-1/`，并修正用语。

### Tool Run Terminal Command V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Ripgrep Raw Search

```
{"pattern":"surface|additive|cargo-cult|具名|真源|宿主","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1","caseInsensitive":false,"multiline":false,"toolCallId":"call-dbf8c5af-d5bc-4c77-bfb2-ebc0ff587969-52\nfc_4bac1b1c-064b-9426-a781-c71894cce9d1_0","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/00-discussion.md","offset":135,"limit":20}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/README.md","limit":10}
```

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/03-reference-projects.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/00-discussion.md","offset":155,"limit":20}
```

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/02-optimization-plan-and-change-scope.md","offset":210,"limit":20}
```

### Tool Edit File V2

### Tool Edit File V2

### Tool Edit File V2

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/04-test-and-acceptance.md","offset":70,"limit":15}
```

### Tool Edit File V2

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/02-optimization-plan-and-change-scope.md","offset":30,"limit":25}
```

### Tool Edit File V2

### Tool Edit File V2

### Tool Read File V2

```
{}
```

## Assistant

文档已写完，本规划会话**没有改应用代码**。

落点：

- 议题目录：[docs/ohbaby-sdk/2026-08-13-surface-contract-unification/](docs/ohbaby-sdk/2026-08-13-surface-contract-unification/README.md)
- 本轮正文（一套 00–04）：[improve-1/](docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/README.md)

这是**一轮** improve-1：内部 A（契约）→ B（TUI/Web 形状对齐）→ C（审计记录）。冗余清理**不在本轮编码**，等契约落地后再单独开批。

---

**请先看命名表**：[00-discussion.md 第 3 节](docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/00-discussion.md)

这是你要求「实施前先对齐」的部分。核心约定：

| 名字 | 含义 |
|------|------|
| `clientRequestId` | 这一次写操作的关联编号；信封上的 `id` 就是它 |
| 命令信封 | 适配器把独立函数调用拍成 `{ id, method, params, at }`，页面不用手拼 |
| `UiEvent` | 业务事件；TUI/Web 只消费这个 |
| `hello` / `resync-required` | 运输层事件，不进 SDK |
| 工作区 / 选目录 / 连接态 | 留在 web-server |

`CoreAPI`、`OhbabyWebClient` 等旧名本轮**先保留**，清理批再删。

---

**还剩 5 个细节**（写在 00 第 8 节）。你审查时不反对，实施就按推荐做：

1. **`submitPrompt` 返回值**：统一返回已有的 `UiPromptReceipt`；TUI 可忽略。
2. **审计写哪**：测试用可注入记录器，生产打结构化日志；不做回放界面。
3. **TUI 的 `message.part.delta`**：后端真在推增量就升入 SDK，否则留在 TUI。
4. **`listCommands` / `probeModelContextWindow`**：归查询；`connectModel` 归命令。
5. **Web 的 `createSession` / `selectSession`**：**本轮默认不进 SDK**。批次 B 只要求写清 `abortSession` 和 `abortRun` 的对应关系。若你希望「新建/选择会话」也变成两端共用契约，请明确说，那会扩大批次 A。

第 5 条是文档自检时补上的，之前讨论里没拍板。

---

文档自检已做：00 的结论都能在 02 找到；01 的五条承重问题对应 A/B/C 和后续清理批；04 按批次挂了可执行验收项。和现有 `docs/ohbaby-sdk/` 的差距也写进了 01（文档承诺多前端共用，代码里 Web 另写了一套）——实施后再回写那些模块文档。

请先审 **00 命名表 + Q1–Q5**。点头后，另开会话按 02 实施即可。

## User

/calm-review 来派遣子代理把你写的文档审核一下

## Assistant

先框定在审什么，再派子代理对文档主张和代码对一下，避免只凭写得长就当它对。

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/00-discussion.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/02-optimization-plan-and-change-scope.md"}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk/2026-08-13-surface-contract-unification/improve-1/README.md"}
```

### Tool New agent

### Tool New agent

### Tool New agent

## Assistant

子代理的结论我不会直接当证据。先核对几处最承重的代码。

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess.ts","offset":2390,"limit":30}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/events.ts","offset":1,"limit":90}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts","offset":1,"limit":50}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/client.ts","offset":63,"limit":50}
```

### Tool Ripgrep Raw Search

```
{"pattern":"hello|resync-required","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src","glob":"*.{ts,tsx}","caseInsensitive":false,"multiline":false,"toolCallId":"call-d9f9f605-c5a5-4e7a-8b9e-ddf63f96d645-98\nfc_948719bd-80a5-9393-a7a3-3b376d0a6099_4","offset":0}
```

### Tool Ripgrep Raw Search

```
{"pattern":"status: UiPromptSubmissionStatus","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/prompt.ts","caseInsensitive":false,"multiline":false,"toolCallId":"call-d9f9f605-c5a5-4e7a-8b9e-ddf63f96d645-99\nfc_948719bd-80a5-9393-a7a3-3b376d0a6099_5","offset":0}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/prompt.ts","limit":30}
```

### Tool Read File V2

```
{"path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/client.ts","offset":385,"limit":20}
```

### Tool Ripgrep Raw Search

```
{"pattern":"export function|function reduce|UiEvent","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/api/daemon/eventReducer.ts","caseInsensitive":false,"headLimit":15,"multiline":false,"toolCallId":"call-589ae8c9-9a1b-4178-a674-5faa330f88bc-102\nfc_896e2c4d-d5ab-9be7-ab94-6c51c9019a4d_2","offset":0}
```

### Tool Ripgrep Raw Search

```
{"pattern":"Promise<void>|submit-and-wait|已提交","path":"/Users/hansunwork26/workspace/projects/code-cli/ohbaby-agent/docs/ohbaby-sdk","caseInsensitive":false,"multiline":false,"toolCallId":"call-589ae8c9-9a1b-4178-a674-5faa330f88bc-103\nfc_896e2c4d-d5ab-9be7-ab94-6c51c9019a4d_3","offset":0}
```

## Assistant

**模式：单轮。** 在审的是「要不要按这套 improve-1 文档去改代码」。文档本身能改、能删；但若按 Q1 把 `submitPrompt` 的返回值和**等待语义**一起改，会碰到 TUI 现有「提交并等到跑完」的契约，回滚面是 SDK + TUI + Web + 同进程适配器。所以下面不当成「写得全就对」。

子代理：[代码主张核对](58fe4456-2b5d-4bec-93a6-587ac7e8ecbb)、[文档内部一致性](844287c9-0421-4358-badc-6d22432bb2a6)、[信封是否多余](6aa35118-d612-4d26-8ae9-d1b49103b5ab)。承重事实我对照了 `ui-inprocess.ts`、`events.ts`、`client.ts`、`DaemonRpcRequest`、Web SSE 分支。

---

## 问题（请直接答，不要用「细节实施时再定」）

1. TUI 同进程现在是 `await submitPromptAndWait(...)`：`submitPrompt` 的 Promise 在**跑完**才结束。Web 是**接受即返回**回执。你要统一的是 TypeScript 签名，还是 Promise 何时结束？这两个不是一件事。答「TUI 可以忽略返回值」等于没答。

2. 接下来半年，谁会读批次 C 记下的那些信封？如果答案是「除了我们为它写的测试，没有人」，C 为什么在这一轮？

3. JSON-RPC 已经有 `DaemonRpcRequest { id, method, params }`，那个 `id` 是运输层随机 UUID，`clientRequestId` 在 params 里。新信封规定 `id === clientRequestId`。改完之后，一次 `submitPrompt` 还剩几个 id？各管什么？

4. 现在仓库里，有哪个文件必须只能看到查询、不能看到 `submitPrompt`？请给出路径。找不到的话，`UiQueryClient` / `UiCommandClient` 解决的是哪个现存问题？

5. `message.part.delta` 已经在 SDK 的 `UiEvent` 里，后端也在发，Web reducer 也在处理。00 的 Q3「要不要升入 SDK」还问什么？

---

## 结构化阅读

**最强反对意见：** 真问题是 Web 的 `submitPrompt({ text, clientRequestId })` 和 SDK 的 `submitPrompt(text, options?)` 对不上，再加上几处同名方法参数/返回值漂移。Web 已经把 SSE 的 `hello` / `resync-required` 拦在 client 里，业务层 `reduceUiEvent` 吃的就是 `UiEvent`。计划却把这件事做成：新拆两套接口、新公开信封类型、全写操作审计、再给事件补可选关联字段。更糟的是 Q1 把「返回 `UiPromptReceipt`」写成统一，但没写 Promise 何时结束——按字面做，要么 TUI 行为变了（现有 `await submitPrompt` 再断言 snapshot 的测试会假绿或假红），要么同一个 `UiPromptReceipt` 在 TUI 表示终态、在 Web 表示已接受。

**核对过的主张：**

| 文档怎么说 | 代码 |
|------------|------|
| 两边 `submitPrompt` 签名不同 | 属实。SDK `Promise<void>`；Web 对象参数 + `PromptAcceptedResponse` |
| TUI 完全靠事件、方法只表示已提交 | **不属实。** `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 里是 `submitPromptAndWait`。SDK 注释写明这是 legacy submit-and-wait。01 写成「TUI 完全靠事件」，02 再声称改回执「与 G4 兼容」，两头都不对 |
| `hello` 被业务层当协议 | **过述。** `client.ts` 里 `hello` 直接 return，`resync-required` 走 `resync()`；`eventReducer.ts` 只收 `UiEvent` |
| TUI 独有 `message.part.delta`，考虑升入 SDK | **错。** `events.ts` 已有该类型；TUI 是重复声明，且把 `messageId` 收成必填 |
| CoreAPI 几乎是拷贝 | 除 `subscribeEvents` 外是精确拷贝；Web client **不是**近拷贝，漂移比文档说的大（`getSnapshot` 还是同步的 `StoreSnapshot`） |
| 同进程适配器在 cli/server | **点名错了。** 真正实现是 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`，02 改动面表里没有这个包 |
| 需要新的命令信封才能审计 | JSON-RPC 已有 `DaemonRpcRequest`。同进程 `createRPC` 没有这条记录。缺的是同进程/REST 的日志，不是 SDK 再导出一种信封 |

**未核实、但压着方案的假设：** 有人需要 Query/Command 拆开；全写操作都要对账；可选的 `clientRequestId` 事件字段会被填上；清理批真的会发生。

**六个月后最像的失败故事：** 签名对齐做了大半；`UiCommandEnvelope` 和 `DaemonRpcRequest` 并存；`CoreAPI` 还在（清理后置）；Query/Command 只有一条类型测试在用；事件上的 `clientRequestId` 大部分仍是 `undefined`；`submitPrompt` 的回执在两端含义不同，下一个人不敢再动。原始痛点其实一个针对 Web client 的小 PR 就能打掉 80%。

**怎样会改变判断：**  
- 若你明确「TUI 继续等到跑完，Web 继续接受即返回，本轮只改 Web 的参数顺序去贴 SDK」——计划里 A/C 的大部分就该拿掉，剩下的成立。  
- 若你明确「TUI 也改成接受即返回，等待走 `waitForPrompt`」——那是行为变更，要单独写时序和回归，不能藏在 Q1 里。  
- 若你能指出真实的只读调用方、以及非测试的审计消费者——信封和拆分才有资格留在本轮。

**偏误（实际打中的）：**  
- **篇幅当质量：** 00–04 看起来像已经拍板，但 Q3 问的是已存在的类型，P3 修的是 Web 已经分开的运输层。  
- **假想的通用性：** 审计产品明确不做，却把可注入记录器写进发布门。  
- **锚在第一套架构：** 讨论从「要不要公开大联合命令」起，拒绝之后仍留下「边界信封」当主轴；更小的解「Web 对齐 SDK 签名」没有被当成主方案挑战过。  
- **沉没成本：** 文档已经写完，不等于 A→B→C 该原样实施。  
- **用 AI 自己的上一轮当证据：** 这套文档是同一条对话写的。参考项目只支撑「不要做页面级大联合命令」，撑不住「必须先有信封类型」。

---

## 结论：**Proceed after fixing X**

X 不是润色，是缩小范围并补上文档写丢的行为门：

1. **先冻结 `submitPrompt` 的时序**（接受即返回 vs 等到结束），再谈返回类型。现在的 Q1 不能当实施默认。
2. **本轮关键路径改成签名对齐**（Web `submitPrompt(text, options?)`、其它 01 已列出的同名方法、`getSnapshot` 不要占用 SDK 名字）。Query/Command 拆分、公开 `UiCommandEnvelope`、可注入审计器移出本轮；要对账就给 prompt 路径用已有 `clientRequestId`，日志可以是适配器里的一行对象，不必进 SDK 导出。
3. **改掉错误事实再实施：** Q3/`message.part.delta`；hello 并非业务层误用；点名 `ui-inprocess.ts`；补上 00 自己要求、02/04 却没写的 `abortSession` ↔ `abortRun`。

边界里仍然成立、我对过代码的部分：工作区/选目录不进 SDK；`hello`/`resync` 不进 `UiEvent`；公开 API 继续用独立函数；TUI 保持同进程；本轮不删 `CoreAPI`。这些该留。把它们和「新协议对象 + 新接口切分 + 审计批次」绑成一轮，没有被问题撑住。

答上面 5 问之后，我可以按你的答案把 00/02 该砍/该补的条目列成改文档清单。在那之前，不要按现在的 A→B→C 开工。