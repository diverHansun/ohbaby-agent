# tools 模块 test.md

本文档说明如何验证 `tools` 模块在真实协作环境中的可信性。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试覆盖以下职责：

| 职责 | 验证目标 |
|------|----------|
| 参数验证 | Zod Schema 正确验证参数 |
| 文件读取 | read 工具正确读取各类文件 |
| 文件写入 | write 工具正确创建和写入文件 |
| 文件编辑 | edit 工具正确替换文本 |
| 文件搜索 | glob 工具正确匹配文件 |
| 内容搜索 | grep 工具正确搜索内容 |
| 目录列表 | list 工具正确列出目录 |
| 命令执行 | bash 工具正确执行命令 |
| 网络请求 | web_fetch/web_search 正确获取数据 |
| 输出截断 | 超出限制时正确截断并提示 |

### 不在测试范围

以下内容不在本模块测试范围内：

- 权限检查（ToolScheduler/Policy 职责）
- 并发控制（ToolScheduler 职责）
- 工具注册和调度（ToolScheduler 职责）
- 状态管理（ToolScheduler 职责）

---

## 二、Critical Scenarios（关键场景）

### 2.1 read 工具

**场景 1：读取普通文本文件**
- 前置条件：存在文本文件
- 操作：调用 read({ file_path: '/path/to/file.txt' })
- 预期结果：返回带行号的文件内容

**场景 2：读取文件指定范围**
- 前置条件：存在超过 100 行的文件
- 操作：调用 read({ file_path, offset: 50, limit: 20 })
- 预期结果：返回第 50-69 行内容

**场景 3：读取 UTF-8 BOM / CRLF 文本**
- 前置条件：存在带 UTF-8 BOM 与 CRLF 的文本文件
- 操作：调用 read({ file_path, offset: 1, limit: 2 })
- 预期结果：输出不包含 BOM，metadata.encoding = 'utf8'，metadata.lineEnding = 'CRLF'

**场景 4：读取空文件**
- 前置条件：存在空文本文件
- 操作：调用 read({ file_path })
- 预期结果：output 为空字符串，metadata.lineCount = 0，metadata.hasMore = false

**场景 5：读取不存在的文件**
- 前置条件：文件不存在
- 操作：调用 read({ file_path: '/nonexistent' })
- 预期结果：返回 FileNotFoundError

**场景 6：读取二进制文件**
- 前置条件：存在二进制文件（如 .exe）
- 操作：调用 read({ file_path: '/path/to/binary' })
- 预期结果：返回 BinaryFileError

**场景 7：读取超出行数限制**
- 前置条件：存在超过 2000 行的文件
- 操作：调用 read({ file_path })
- 预期结果：返回前 2000 行，metadata.truncated = true

**场景 8：读取超大文件**
- 前置条件：文本文件超过 1MB
- 操作：调用 read({ file_path })
- 预期结果：拒绝读取，返回文件过大错误

### 2.2 write 工具

**场景 9：创建新文件**
- 前置条件：文件不存在
- 操作：调用 write({ file_path, content })
- 预期结果：创建文件，metadata.created = true

**场景 10：覆盖现有文件必须携带 mtime**
- 前置条件：文件已存在
- 操作：调用 write({ file_path, content })
- 预期结果：缺少 expected_mtime_ms 时拒绝覆盖，文件内容不变

**场景 10.1：mtime 匹配时覆盖现有文件**
- 前置条件：先通过 read 或 stat 获取文件 mtimeMs
- 操作：调用 write({ file_path, content, expected_mtime_ms })
- 预期结果：覆盖文件内容，保留既有 UTF-8 BOM，原子写入成功

**场景 10.2：dry_run 预览写入**
- 前置条件：文件可存在或不存在
- 操作：调用 write({ file_path, content, expected_mtime_ms?, dry_run: true })
- 预期结果：返回 Unified Diff，文件内容与目录结构不变

**场景 11：创建文件到不存在的目录**
- 前置条件：目录不存在
- 操作：调用 write({ file_path: '/new/dir/file.txt', content })
- 预期结果：创建目录并创建文件

**场景 11.1：工作区内绝对路径写入**
- 前置条件：传入的绝对路径位于 workspace 内
- 操作：调用 write({ file_path: absolutePath, content })
- 预期结果：创建父目录并写入成功；workspace 外绝对路径仍拒绝

### 2.3 edit 工具

**场景 12：精确替换文本**
- 前置条件：文件包含目标文本
- 操作：调用 edit({ file_path, old_string, new_string })
- 预期结果：替换成功，返回 diff

**场景 13：替换所有匹配**
- 前置条件：文件包含多处目标文本
- 操作：调用 edit({ file_path, old_string, new_string, replace_all: true })
- 预期结果：替换所有匹配，metadata.replacementCount > 1

**场景 14：未找到匹配文本**
- 前置条件：文件不包含目标文本
- 操作：调用 edit({ file_path, old_string, new_string })
- 预期结果：返回 NoMatchFoundError

**场景 14.1：内容已变化**
- 前置条件：文件内容已被外部程序改写，旧的 old_string 不再存在
- 操作：调用 edit({ file_path, old_string, new_string })
- 预期结果：拒绝修改，提示 old_string 未找到，文件内容不变

**场景 14.2：连续编辑**
- 前置条件：文件包含两个不同目标文本
- 操作：连续调用两次 edit，中间不调用 read
- 预期结果：两次都基于当前文件内容执行成功

**场景 14.3：dry_run 预览编辑**
- 前置条件：文件包含唯一目标文本
- 操作：调用 edit({ file_path, old_string, new_string, dry_run: true })
- 预期结果：返回 Unified Diff，文件内容不变

**场景 15：多处匹配但未开启 replace_all**
- 前置条件：文件包含多处目标文本
- 操作：调用 edit({ file_path, old_string, new_string })
- 预期结果：拒绝修改，并提示开启 replace_all

**场景 15.1：CRLF 保留**
- 前置条件：文件使用 CRLF 换行
- 操作：调用 edit({ file_path, old_string, new_string })
- 预期结果：替换成功后仍使用 CRLF

**场景 15.2：有限 fuzzy 匹配**
- 前置条件：文件内容与 old_string 仅存在行首尾空白、整体缩进差异，或候选片段内连续空格/Tab/换行数量差异
- 操作：调用 edit({ file_path, old_string, new_string })
- 预期结果：唯一 fuzzy 匹配时替换成功；多个 fuzzy 候选时拒绝并要求更多上下文；空白敏感编辑需使用更精确 old_string

**场景 15.3：同文件并发编辑**
- 前置条件：两个 edit 同时修改同一文件不同位置
- 操作：并发调用 edit
- 预期结果：文件级锁串行化读写，最终两处修改都保留

### 2.4 glob 工具

**场景 16：简单模式匹配**
- 前置条件：存在 .ts 文件
- 操作：调用 glob({ pattern: '**/*.ts' })
- 预期结果：返回所有 .ts 文件

**场景 17：指定路径搜索**
- 前置条件：src 目录下有文件
- 操作：调用 glob({ pattern: '*.ts', path: './src' })
- 预期结果：只返回 src 目录下的 .ts 文件

**场景 18：结果数量超限**
- 前置条件：匹配文件超过 100 个
- 操作：调用 glob({ pattern: '**/*' })
- 预期结果：返回 100 个文件，metadata.truncated = true

### 2.5 grep 工具

**场景 19：简单正则搜索**
- 前置条件：文件包含目标文本
- 操作：调用 grep({ pattern: 'function\\s+\\w+' })
- 预期结果：返回匹配行（文件:行号:内容）

**场景 20：指定文件类型搜索**
- 前置条件：存在多种类型文件
- 操作：调用 grep({ pattern: 'TODO', include: '*.ts' })
- 预期结果：只搜索 .ts 文件

**场景 21：无匹配结果**
- 前置条件：无匹配内容
- 操作：调用 grep({ pattern: 'nonexistent_pattern_xyz' })
- 预期结果：返回空结果，matchCount = 0

### 2.6 list 工具

**场景 22：列出当前目录**
- 前置条件：当前目录有文件
- 操作：调用 list({})
- 预期结果：返回树形结构

**场景 23：使用自定义忽略模式**
- 前置条件：存在 node_modules 目录
- 操作：调用 list({ ignore: ['node_modules'] })
- 预期结果：不包含 node_modules

### 2.7 bash 工具

**场景 24：执行简单命令**
- 前置条件：无
- 操作：调用 bash({ command: 'echo hello', description: 'test' })
- 预期结果：返回 "hello"，exitCode = 0

**场景 25：命令执行失败**
- 前置条件：无
- 操作：调用 bash({ command: 'exit 1', description: 'test' })
- 预期结果：exitCode = 1

**场景 26：命令超时**
- 前置条件：无
- 操作：调用 bash({ command: 'sleep 10', description: 'test', timeout: 1000 })
- 预期结果：返回 TimeoutError

**场景 27：输出超出限制**
- 前置条件：无
- 操作：执行输出超过 30000 字符的命令
- 预期结果：输出被截断，metadata.truncated = true

**场景 28：命令被取消**
- 前置条件：无
- 操作：执行命令后立即 signal.abort()
- 预期结果：命令被终止

### 2.8 web_fetch 工具

**场景 29：获取网页内容**
- 前置条件：URL 可访问
- 操作：调用 web_fetch({ url: 'https://example.com' })
- 预期结果：返回网页内容

**场景 30：HTML 转 Markdown**
- 前置条件：URL 返回 HTML
- 操作：调用 web_fetch({ url, format: 'markdown' })
- 预期结果：返回 Markdown 格式内容

**场景 31：请求超时**
- 前置条件：URL 响应慢
- 操作：调用 web_fetch({ url, timeout: 100 })
- 预期结果：返回 TimeoutError

**场景 32：响应过大**
- 前置条件：URL 返回超过 5MB
- 操作：调用 web_fetch({ url })
- 预期结果：返回错误

### 2.9 todo 工具

**场景 33：写入待办事项**
- 前置条件：无
- 操作：调用 todo_write({ todos: [...] })
- 预期结果：原子替换当前 session 列表并返回格式化结果；最多 10 项、单项最多 100 个 Unicode 字符、允许多个 in_progress

**场景 34：读取待办事项**
- 前置条件：已写入待办
- 操作：调用 todo_read({})
- 预期结果：返回当前 scope 待办列表，不修改状态、不发布更新事件

**场景 35：恢复与清空边界**
- 前置条件：历史中同时存在成功、失败和空数组 todo_write
- 操作：resume session 后读取 Todo
- 预期结果：只恢复最后一次成功完成写入；成功空数组保持为空，不复活旧值

**场景 36：Todo UI 与 transcript**
- 前置条件：run 中写入 10 项 Todo
- 操作：分别使用 Web 和 TUI 消费 snapshot/event
- 预期结果：Web 全量限高滚动；TUI 紧凑 5 项并可 Ctrl+T 展开；两个工具均不进入 transcript

Todo 的完整自动化与真实浏览器/TUI 进程验收见 [`todo-list/test.md`](./todo-list/test.md) 与 [`todo-list/improve-1/04-test-and-acceptance.md`](./todo-list/improve-1/04-test-and-acceptance.md)。

---

## 三、Integration Points（集成点测试）

### 3.1 与文件系统集成

**验证重点**：
- 文件读写操作正确
- 路径解析正确
- 权限错误正确捕获

**失败处理预期**：
- 文件不存在返回明确错误
- 权限不足返回明确错误

### 3.2 与 Shell 集成

**验证重点**：
- 命令正确执行
- 输出正确捕获
- 进程正确终止

**失败处理预期**：
- 命令失败返回退出码
- 超时正确处理

### 3.3 与网络集成

**验证重点**：
- HTTP 请求正确发送
- 响应正确处理
- 超时正确处理

**失败处理预期**：
- 网络错误返回明确错误
- 超时返回明确错误

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**适用场景**：
- 参数验证逻辑
- 输出截断逻辑
- 二进制检测逻辑
- 路径处理逻辑

**策略**：
- 使用模拟文件系统
- 覆盖边界情况

### 4.2 集成测试

**适用场景**：
- 实际文件操作
- 实际命令执行
- 实际网络请求

**策略**：
- 使用临时目录
- 使用测试服务器
- 设置合理超时

### 4.3 性能测试

**适用场景**：
- 大文件读取
- 大量匹配搜索
- 长时间命令执行

**策略**：
- 验证截断正确工作
- 验证超时正确工作

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 每个工具都有测试场景覆盖
- [x] 错误场景有测试覆盖
- [x] 边界情况（截断、超时）有测试覆盖
- [x] 场景来源于 goals-duty.md 和 dfd-interface.md
