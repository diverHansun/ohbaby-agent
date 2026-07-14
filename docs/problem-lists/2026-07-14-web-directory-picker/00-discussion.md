# 讨论记录与已确认决策

> 记录日期：2026-07-14。
>
> 本文冻结已经确认的结论；实现不得把被否决的 PowerShell picker 作为 fallback 重新加入。

## 1. 产品目标

用户从项目 rail 的 `+` 或空状态的 “Open project” 打开页面内目录树，在 daemon 可访问的本地文件系统中浏览并选择项目目录。整个过程不弹出 PowerShell、CMD、系统文件对话框或路径文本输入。

## 2. 已确认决策

| 决策项 | 结论 |
|---|---|
| 产品形态 | 保持 `ohbaby serve` 的浏览器 + Node daemon，不引入 Electron |
| 参考产品 | 学习 OpenCode **Web** 路径，而不是 Electron Desktop 的 `dialog.showOpenDialog` |
| 目录范围 | daemon 所在机器全部本地可访问路径；Windows 从全部逻辑盘符根目录开始 |
| 浏览方式 | 页面内目录树，只列目录；逐级浏览，不做全盘递归搜索 |
| 打开项目 | 用户确认目录后调用既有 `POST /v1/scopes/open`，由 `resolveWorkspaceScope()` 决定 Git root 或 canonical directory |
| 取消 | 关闭对话框不请求 open、不改变当前项目、不显示错误 |
| `windowsHide` | 保持后台子进程默认 `true`；目录树不执行系统 picker 子进程 |
| 现有临时改动 | 撤销未提交的 Windows `windowsHide: false` workaround |

## 3. 安全边界

“允许全部路径”只表示 loopback daemon 所在机器中，用户可从所有可访问的盘符根目录浏览；它**不**表示允许 LAN 或远程客户端枚举文件系统。

因此所有目录浏览端点必须同时满足：

1. Bearer token 鉴权；
2. daemon host 为明确的 loopback IP 字面量（`127.0.0.0/8`、`::1`；不接受可能解析到其他接口的 hostname，包括 `localhost`）；
3. 只返回目录元数据（名称、绝对路径、是否可进入），不返回文件条目或内容；
4. 每次请求只枚举一个目录的直接子目录；
5. `EACCES`、`ENOENT`、无效路径和非目录必须转换为结构化响应，不泄露堆栈。

非 loopback host 的响应为 `403 DIRECTORY_BROWSER_LOOPBACK_ONLY`。这与既有 scope open/hide 的授权语义保持一致，但新增端点不得依赖浏览器 CORS 作为安全控制。

## 4. 体验边界

- 根列表在 Windows 显示逻辑盘符根目录；其他平台显示 `/`。
- 当前目录提供面包屑和“返回上级”；目录树不读取文件，也不在初始打开时遍历整盘。
- 目录不可读时显示可理解错误，已选项目保持不变。
- 用户可选择当前目录，即使它不是 Git root；服务端仍按既有规则规范化。
- 目录项应稳定按名称排序，目录多时可在后续批次增加搜索/分页；本批不实现。

## 5. 非目标

- 不提供任意路径文本粘贴入口。
- 不模拟操作系统文件资源管理器，也不实现文件预览。
- 不改变 workspace registry 的 visible/hidden 语义。
- 不改变 remote/LAN serve 的当前安全模型；其目录浏览明确禁用。
