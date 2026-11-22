# 讨论记录与已确认要点

> 2026-11-21 开始与用户逐项讨论，每确认一项就更新本文。
>
> 术语：本文的"sidecar"指 App 随安装包携带、由 Electron 主进程拉起的 ohbaby 运行时子进程；"壳"指 Electron 本身，只负责窗口、启动 sidecar 和更新。

## 1. 已确认：桌面框架用 Electron（2026-11-21）

| 决策项 | 结论 |
|---|---|
| 桌面框架 | Electron，不用 Tauri |
| 打包与更新工具 | electron-builder 和 electron-updater |
| 目标平台与分发 | macOS、Windows、Linux 各自发布独立安装包，具体架构和格式见第 6 节。现有的 CLI 安装命令只负责 TUI 和 Web，不下载 App（2026-11-21 用户补充） |

理由：

- 整个技术栈是 Node 和 React。Tauri 同样需要带一个 Node sidecar，包体小的优势基本没有了。
- Tauri 使用系统 WebView（macOS 的 WKWebView、Windows 的 WebView2），不同平台渲染不一致；Electron 自带 Chromium，表现一致。
- 参考项目中，opencode 从 Tauri 迁到了 Electron（提交 `5cf235fa6c`、`da0f81d36f`，后者的说明是"simplify distribution"）。ZCode 和 deepseek-harness 也都用 Electron，三者都用 electron-builder 和 electron-updater。
- 代价是安装包较大。

## 2. 已确认：App 与 Web 的关系（2026-11-21）

一句话概括：**App 窗口显示的就是 ohbaby-web 页面，和浏览器里看到的一样，后端是 App 在后台拉起的 `ohbaby serve`。**

```
ohbaby App（Electron 窗口）
  显示 ohbaby-web 页面，和浏览器里看到的一样
  多一层桌面桥 window.ohbabyDesktop：
  第一版只有原生选目录（浏览器里没有就照旧）
                        │
                        │ HTTP / SSE（和浏览器相同）
                        ▼
        sidecar：ohbaby serve（App 安装包自带）  ◄── 浏览器里的 Web 也连这里
                        │
                        ▼
                ~/.ohbaby（和 TUI 共用数据）
```

### 2.1 参考项目怎么同时支持 Web 和 App

| 项目 | 界面代码 | App 窗口怎么连后端 | 浏览器能否连 App 的后端 |
|---|---|---|---|
| deepseek-harness | App 和 `dsh web` 用同一份构建产物（`apps/web`） | 自定义协议 `dsh-app://app/`：静态文件从安装包读，接口由主进程转发到本机后台（`apps/desktop/src/main.ts:797-812`）。后台是用 `ELECTRON_RUN_AS_NODE` 拉起的子进程，跑的就是 `dsh web` 的服务端代码，端口随机（`apps/desktop-host/src/index.ts:49-55`） | 推测可以（需 token，未证实） |
| ZCode | 界面组件共用（`@zcode/ui`），Web 和 App 各有一个入口 | 不开 HTTP 端口，窗口和后台之间用 MessagePort 通信（`packages/desktop/src/main/desktopHostProcess.ts:732-744`）；Web 版另有独立的 HTTP 入口 | 不能，只能经云端中转远程控制 |
| kimi-code | 桌面端 `apps/desktop`（2026-11-20 进入仓库）把界面打进安装包，用自定义协议 `app://` 加载，并通过 `?kimi_desktop=1`、`window.kimiDesktop` 启用桌面功能（`src/main/app/protocol.ts:61-81`） | 默认在 Electron 主进程内直接启动服务端，端口随机（`src/main/server/embedded-server.ts`）；也可以配置连接外部服务。服务地址和 token 通过页面地址的参数传给界面 | 推测可以连外部服务（未证实） |
| opencode | 界面打进安装包，用 `oc://` 协议加载 | 渲染进程通过 HTTP 访问 sidecar，主进程注入鉴权 | 可以，Web、TUI、桌面端连同一个服务 |

共同点：都复用同一套界面代码，都用一个桌面桥（`window.dshDesktop`、`window.kimiDesktop`、`window.zcode`）提供桌面专属功能，页面检测到桥就用，检测不到就按浏览器模式运行。

后端放在哪里各不相同：deepseek-harness 和 opencode 放在子进程，kimi-code 放在 Electron 主进程内，ZCode 放在 utilityProcess。窗口加载界面的方式则比较一致：开 HTTP 服务的三家（deepseek-harness、kimi-code、opencode）都用自定义协议加载打进安装包的界面，页面地址固定不变。我们第一版不这样做，理由和后备方案见 2.3。

ZCode 的私有通道不适合我们：Web 和 App 已确定共用一个 daemon，App 走私有通道后浏览器就连不上了。

### 2.2 后端以 sidecar 运行

运行时作为独立子进程运行，不放进 Electron 主进程：

- App 的 sidecar 和 CLI 是同一套代码、同一个版本，App 启动的 daemon 和 `ohbaby serve` 起的完全一样，Web 和 TUI（`--remote-port`）都能连。
- `@lydell/node-pty` 是原生模块，放进 Electron 主进程要按 Electron 的 ABI 重新编译；放在 sidecar 里可以避开。
- 后端崩溃不会带崩界面。

sidecar 使用 Node SEA 独立可执行文件，这是脚本安装议题预留给 App 的方案。需要先做探针，确认 SEA 能正常加载 node-pty、koffi 的 `.node` 文件，以及 ripgrep 和 Web 静态资源。

参考：opencode 把 CLI 二进制作为 extraResources 打进安装包，`afterPack` 检查架构和版本文件，启动时复制到 `userData/cli/<版本>-<架构>/` 后运行，保留正在运行的那个版本，避免更新时删掉仍在使用的二进制。

### 2.3 窗口直接加载 daemon 地址

第一版窗口直接打开 daemon 的地址（`http://127.0.0.1:<端口>`）：

- 界面版本永远和运行时一致。
- 页面和服务同源，现有的 token 注入直接可用，不需要做 CORS。
- 壳只自带一个"启动中/启动失败"页面。

已知代价：daemon 默认端口是 4096，被占用时会改用随机端口。端口一变，页面地址（origin）就变了，浏览器按地址保存的本地数据（如未发送的草稿、界面偏好）会读不到。如果 4096 长期被别的程序占着，每次启动都会换端口，本地数据每次都会丢。4096 被占用的情况不多，第一版接受这个代价。

这和参考项目的主流做法不同（见 2.1）。第一版仍选直接加载，是因为现有的 token 注入和同源访问直接可用，壳里不用写协议处理和请求转发。

后备方案：真成为问题时（例如有用户反馈 4096 长期被占用），改用 deepseek-harness 的自定义协议，让页面地址固定不变。改动只在 Electron 这一层，Web 代码不用动。opencode 也用自定义协议（`oc://`），由主进程给发往 sidecar 的请求注入鉴权，渲染进程只知道服务地址。

### 2.4 桌面桥（2026-11-22 确认内容）

Electron 的 preload 脚本向页面暴露 `window.ohbabyDesktop`，只放浏览器做不到的功能。ohbaby-web 检测到它就使用，检测不到就保持现有行为。

第一版只放一个方法 `pickDirectory()`：

| 功能 | 第一版 |
|---|---|
| 选目录 | App 里调用 `pickDirectory()`，由主进程打开系统的选文件夹窗口（`dialog.showOpenDialog`），返回选中的路径，取消时返回空。浏览器里保持现有的页面内选择器（`apps/ohbaby-web/src/ui/workspace/directory-picker/DirectoryPickerDialog.tsx`，向 daemon 要目录列表），现有代码不删。App 和 daemon 在同一台机器上，选出来的路径 daemon 直接可用 |
| 系统通知 | 不放。Web 目前没有通知功能，以后要加时再进桥 |
| 拖文件进窗口取路径 | 不放。Web 目前不支持拖拽，以后要做时参照两家的 `getPathForFile`（Electron 的 `webUtils`） |
| 更新提示 | 不放。由主进程直接弹系统对话框 |

参考：deepseek-harness 有两套选择器，`ui-directory-picker-browse` 在页面里浏览服务端目录（和我们现有的一样），`ui-directory-picker-native` 检测到 `__DSH_DIRECTORY_PICKER__` 就调用系统对话框，没有就退回页面内选择器（`packages/client/ui-directory-picker-native/src/client/index.ts`）。opencode 由主进程调用 `dialog.showOpenDialog`（`packages/desktop/src/main/files/index.ts:77`）。

## 3. 必须处理的 Electron 问题

| 问题 | 参考项目做法 | 建议 |
|---|---|---|
| macOS 从程序坞或 Finder 启动的 App 拿不到 shell 的 PATH | opencode、deepseek-harness、kimi-code 都用登录交互 shell 读取环境变量（opencode 是 `$SHELL -ilc "env -0"`，kimi-code 是 `-l -i -c` 执行 node 打印 JSON，见 `apps/desktop/src/main/system/shell-env.ts:108-116`），设几秒超时，再合并进 `process.env`。opencode 还合并系统 CA 证书，并把回环地址加进 `NO_PROXY`（`packages/desktop/src/main/service/shell-env.ts`、`lifecycle/environment.ts`） | 必须做，否则 agent 执行 bash 时找不到 git、node |
| 内嵌二进制的签名 | opencode 在 CI 中由内向外逐个签名 Mach-O，开启 hardened runtime。CLI 使用单独的 entitlements，允许 JIT、关闭库验证（`.github/release/sign-desktop-macos.sh`） | SEA 需要单独签名，加载 node-pty 的 `.node` 文件需要关闭库验证 |
| 芯片架构 | opencode 和 deepseek-harness 都按 arm64、x64 分别打包，不做 universal | 每个平台只出一种架构，见第 6 节 |
| 单实例 | 都使用 `requestSingleInstanceLock`，再次启动时聚焦已有窗口 | 第一版就做 |
| 外部链接 | 不处理时，点击页面里的外部链接会在 App 内新开一个 Electron 窗口 | 主进程拦截新窗口请求（`setWindowOpenHandler`），交给系统浏览器打开 |
| 安全设置 | opencode 和 deepseek-harness 都开启 `contextIsolation` 和 `sandbox`；opencode 用 `will-navigate` 把非本应用地址交给系统浏览器（`packages/desktop/src/main/windows/security.ts`）；deepseek-harness 只在页面来自自己的协议时才暴露完整的桥（`apps/desktop/src/preload-app.ts:128`） | 照做：窗口只允许停留在 daemon 地址上，桌面桥只暴露给 daemon 地址的页面 |
| Ubuntu 24.04 的沙箱限制 | 三个参考项目中都没有找到相关处理 | 凭印象，新版 Ubuntu 的 AppArmor 会限制 Electron 的沙箱，配置不当时 App 无法启动。未核实，需要在 Ubuntu 24.04 上实测 deb 包 |
| 卸载 | 未查 | 卸载 App 不删除 `~/.ohbaby`，和 CLI 卸载的规则一致（脚本安装议题 5.4 节），会话和配置都保留，TUI 和 Web 照常可用 |

## 4. 已确认：代码签名（2026-11-21）

用户目前没有 Apple 开发者账号，也没有 Windows 代码签名证书。

| 决策项 | 结论 |
|---|---|
| 内测阶段 | 三个平台都打不签名的包。macOS 上自己安装时在系统设置里放行一次 |
| CI 结构 | 参照 opencode：先打出未签名的包，再交给单独的签名步骤。签名条件具备后接上这一步，打包流程本身不用改 |
| macOS | 公开发布前以个人身份申请 Apple 开发者计划。macOS 上不签名就用不了自动更新，只能手动下载新版 |
| Windows | 先发未签名版，再申请 SignPath Foundation 的开源免费签名；不通过再买 Certum 的开源代码签名证书（见 4.1） |
| Linux | 不需要签名 |

依据（2026-11-21 查阅官方页面）：

- [Apple Developer Program](https://developer.apple.com/programs/enroll/)：个人可以加入，需要开启双重认证的 Apple 账号、真实姓名和地址，证书上显示的开发者是本人姓名；年费 99 美元，按当地货币定价。组织身份需要邓白氏编码（D-U-N-S）、域名邮箱和官网，目前没有必要。
- [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)（原 Trusted Signing，opencode 在用）：个人开发者只限美国和加拿大，组织也只限十几个国家和地区，不含中国大陆，因此不采用。
- [SignPath Foundation](https://signpath.org/)：为开源项目免费签名，证书挂在 SignPath Foundation 名下，私钥在其硬件中，会核验安装包是从仓库构建的。申请条件见 4.1。

以下两点凭经验判断，尚未核实：向证书机构购买的普通代码签名证书，私钥必须放在硬件密钥或云端 HSM 中，接 CI 较麻烦；新发布的程序即使签了名，在下载量积累前 SmartScreen 仍可能提示。

### 4.1 申请清单（2026-11-21 整理，用户自行申请）

**macOS：现在就可以申请，审核需要几天。**

1. 给 Apple 账号开启双重认证。
2. 在 Mac 或 iPhone 上的 Apple Developer App 里，或者在网页上，以个人身份加入 Apple Developer Program。姓名填身份证件上的法定姓名，不能填昵称，否则审核会延迟。网页付款要用本人的信用卡，否则会被要求提供带照片的身份证件。年费 99 美元，按当地货币定价；在 App 里加入是自动续费的订阅。
3. 审核通过后，在开发者网站的 Certificates 页面创建 **Developer ID Application** 证书（App Store 以外分发用的就是这一种），导出成带密码的 `.p12` 文件。
4. 在 App Store Connect 创建一个 API 密钥，用来做公证。记下 Key ID 和 Issuer ID，`.p8` 文件只能下载一次。
5. 把以上材料存进 GitHub 仓库的 Actions secrets，不要发到聊天或提交进仓库。secret 名称参照 opencode（`.github/workflows/release.yml`）：`APPLE_SIGNING_CERTIFICATE`（`.p12` 的 base64）及其密码、`APPLE_NOTARY_KEY`、`APPLE_NOTARY_KEY_ID`、`APPLE_NOTARY_ISSUER_ID`。opencode 用 `xcrun notarytool submit --key --key-id --issuer` 做公证（`.github/release/sign-desktop-macos.sh:65`）。

第 3、4 步中，证书类型和 API 密钥的具体操作凭经验整理，申请时以 Apple 页面为准。

**Windows：等第一个未签名的 Windows 版发布后再申请。**

[SignPath Foundation 的条件](https://signpath.org/terms)里有几条和我们直接相关：

| 条件 | 我们的情况 |
|---|---|
| 项目已经以待签名的形式发布过 | 要先发布未签名的 Windows 安装包，所以现在还不能申请 |
| 可执行程序要有可核实的声誉（库和组件不要求） | 仓库目前 4 个 star、0 个 fork，**有被拒的风险**。SignPath 明确说接受与否由他们决定，不接受申诉 |
| 所有组件使用 OSI 认可的开源协议，不含专有代码 | ohbaby 是 MIT 协议。Electron、Node、ripgrep 等依赖都是开源的，申请前再过一遍依赖清单 |
| 项目主页和下载页写明"Code signing policy"，包括固定文案"Free code signing provided by SignPath.io, certificate by SignPath Foundation"、团队角色和隐私说明 | 要在 README 里加一节。ohbaby 只把数据发给用户自己配置的模型服务，可以用官方给的那句"不会向其他网络系统传输信息，除非用户明确要求" |
| 团队成员在 GitHub 和 SignPath 上都开启多因素认证；每次签名都要人工批准；安装包必须能证明是从仓库源码构建的 | 签名要从 GitHub Actions 发起，发版时多一步人工批准 |
| 提供卸载方式 | NSIS 安装程序自带卸载 |

备选：[Certum 的开源代码签名证书](https://shop.certum.eu/open-source-code-signing.html)，签发给个人，证书上显示"Open Source Developer"加本人姓名，套装（含加密卡和读卡器）售价 69 欧元，需要提交身份证明材料。私钥在实体加密卡里，签名只能在插着卡的电脑上做，CI 打出未签名的包后要下载到本机签名，再重新计算 `latest.yml` 并上传。Certum 是否有可以接入 CI 的云端版本，没有核实。

| 顺序 | 做法 |
|---|---|
| 1 | 第一个公开版先发未签名的 Windows 安装包。用户安装时 SmartScreen 会拦一下，点"更多信息"→"仍要运行"即可 |
| 2 | 在 README 加上 Code signing policy，然后提交 SignPath 申请（[signpath.org/apply](https://signpath.org/apply)） |
| 3 | SignPath 拒绝的话，买 Certum 的证书，在本机签名 |

## 5. 已确认：自动更新（2026-11-21）

| 决策项 | 结论 |
|---|---|
| 下载源 | GitHub Releases。electron-updater 配置 `provider: github`，读取它生成的 `latest.yml`（Windows）、`latest-mac.yml`、`latest-linux.yml` |
| 发布方式 | App 安装包作为附件传到每个版本的 GitHub Release；CLI 继续发 npm。两者版本号相同，在同一条流程里发布 |
| 渠道 | 第一版只做稳定版，不做 beta 或预览版 |
| 下载时机 | 发现新版本先提示，用户确认后再下载，下载完提示重启 |
| 重启时的 daemon | 按[多客户端议题第 7 节](../../2026-11-21-app-multi-client/improve-1/00-discussion.md)处理：App 拉起的 daemon 跟着 App 关闭，还有其他连接时先弹窗提示。新版 App 启动后拉起新版 daemon |
| 未签名的 macOS | 无法自动安装。内测阶段只提示"有新版本"，点击后打开 Release 页面手动下载 |
| Windows、Linux | Windows 未签名时应能自动更新。Linux 只出 deb（第 6 节），先只提示新版本、打开 Release 页面；electron-updater 新版本是否支持 deb 自动安装，实现时再看。这两条凭经验判断，实现时核实 |
| 国内网络 | 不另做镜像，沿用脚本安装议题"不为国内网络做过多兼容"的决定 |
| Release 必须带齐 App 附件（2026-11-22 审查后补充） | electron-updater 的 github provider 读取最新的正式 Release。只要有一次 Release 没带 App 附件（例如只发 CLI 的补丁版，或附件还没传完），App 检查更新时就找不到 `latest-mac.yml` 等清单而报错。因此 App 上线后，每个 GitHub Release 都必须带齐三个平台的安装包和 `latest*.yml`，不再单独只发 CLI；CI 先建草稿 Release，附件全部传完后再正式发布。v0.1.16 到 v0.1.18 的 Release 都没有附件，App 第一个版本之前的这些 Release 不受影响 |

理由：

- 参考项目都有自己的服务器或存储：opencode 上传到 `opencode.ai/files`，由 CI 在签名后计算更新清单（`.github/release/publish-desktop.sh`）；deepseek-harness 用腾讯云 COS，先传带版本号的安装包，最后才替换 `stable.yml`；ZCode 先请求自家服务端的 manifest 接口，再从 CDN 下载，可以按设备灰度。我们没有自己的服务器。
- 仓库本来就公开在 GitHub 上，每次发版都在发 Release（目前没有附件），加上附件即可。
- 安装包有一两百 MB，不适合放进 npm 包。
- "先提示、确认后下载"参照 opencode（`packages/gui-plugins/src/updater/platform.ts` 中 `autoDownload = false`）。

以后如果有了自己的服务器，electron-updater 可以改用 `generic` 指向任意 HTTP 地址，只改配置和 CI，App 代码不用动。ZCode 式的按设备灰度到那时再考虑。

## 6. 已确认：平台与发布顺序（2026-11-21）

| 平台 | 架构 | 安装包格式 |
|---|---|---|
| macOS | 只出 arm64（Apple 芯片），不支持 Intel 机型 | dmg，另附 electron-updater 自动更新要用的 zip |
| Windows | 只出 x64 | NSIS 安装程序（.exe） |
| Linux | 只适配 Ubuntu（x64） | deb |

这比 CLI 支持的 6 个平台少（脚本安装议题 5.6 节）。不支持的机器继续用 CLI 的 TUI 和 Web。

| 阶段 | 做什么 |
|---|---|
| 1. 在 macOS 上跑通 | 在开发机上做通整条链路：SEA 探针、sidecar、窗口、退出处理、版本不一致弹窗。最大的技术风险（SEA 能否加载原生模块）在这一步暴露 |
| 2. 建发版 CI | 新建 release 工作流，三个平台各用一台对应系统的机器打不签名的包，再做冒烟测试：启动 App，确认能连上 sidecar。签名步骤留好位置 |
| 3. 第一个公开版 | 三个平台一起发布。macOS 接上签名和公证；Windows 第一版不签名，发布后再申请 SignPath（见 4.1）。Apple 账号的申请与前两步同时进行 |

为什么要新建发版 CI：现有 `ci.yml` 在三个系统上只跑测试，发版是在本机手动 `npm publish`。CLI 是纯 JS 包，在一台机器上打完处处可用；App 的 SEA 可执行文件和原生模块要按"系统 + 架构"分别打包。opencode 也是每个目标平台用一台对应的 CI 机器打包（`.github/workflows/release.yml` 的 `build-desktop` 矩阵）。

## 7. 已确认：其他（2026-11-22）

| 决策项 | 结论 |
|---|---|
| 深链接 | 以后再做。deepseek-harness 注册了 `dsh://open`，opencode 注册了 `opencode://`，我们目前没有用得上的场景，以后加一个协议注册即可 |
| 关窗口 | 按各平台习惯：macOS 关掉窗口后 App 留在程序坞，daemon 继续运行，按 Cmd+Q 才退出；Windows 和 Linux 关掉最后一个窗口就退出。真正退出时套用[多客户端议题第 7 节](../../2026-11-21-app-multi-client/improve-1/00-discussion.md)的规则。参照 deepseek-harness（`apps/desktop/src/main.ts:1497`）和 opencode（`packages/desktop/src/main/lifecycle/machine.ts:100`），两者在 `window-all-closed` 时，只有非 macOS 平台才退出 |
| 托盘、开机自启 | 第一版都不做。deepseek-harness 和 ZCode 做了托盘，但 ZCode 的注释提到，在没有托盘支持的 GNOME 桌面上 `new Tray()` 不报错也不显示（`packages/desktop/src/main/desktopTraySupport.ts:8`），而 Ubuntu 默认就是 GNOME |
| 代码位置 | `apps/ohbaby-desktop`，npm 包名 `ohbaby-desktop`，和 `apps/ohbaby-web` 并列 |

代码位置的命名理由：

- `apps/` 下的每个目录都是一个应用，Web 也是。叫 `ohbaby-app` 等于"应用目录下的 ohbaby 应用"，说不清是哪一个。
- 参考项目都叫 desktop：opencode 是 `packages/desktop`，deepseek-harness 是 `apps/desktop`，ZCode 是 `packages/desktop`，kimi-code 是 `apps/desktop`。opencode 另有一个 `packages/app`，装的是 Web 和桌面端共用的界面代码，由 `packages/desktop` 依赖。可见"app"这个词很容易被理解成别的东西。
- 加 `ohbaby-` 前缀，和仓库现有的 `ohbaby-web`、`ohbaby-cli` 等保持一致。
- 讨论和文档里继续叫"App 端"，用户看到的产品名仍是 ohbaby，目录名只给开发者看。
