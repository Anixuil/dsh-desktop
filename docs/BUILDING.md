# 构建指南（开发者）

本文档记录完整构建流程、本仓库开发环境特有的注意事项，以及发布清单。

## 环境要求

- Windows 10/11 x64
- Node.js ≥ 20（开发机）
- Rust stable（MSVC 工具链）+ Visual Studio 2022 C++ 构建工具
- pnpm / npm

## 标准构建流程

```powershell
# 1. 前端依赖（tauri CLI）
npm install --cache .npm-cache

# 2. 组装运行时（Node 便携版 + dsh + 桥接插件 + 内置识图插件）
#    dsh 版本号可指定，默认 0.1.0-rc.6；latest 取最新
node scripts/fetch-runtime.mjs 0.1.0-rc.6

# 2b. 打包运行时归档（发布构建前必做；安装器只装归档，首启解压）
node scripts/make-runtime-archive.mjs

# 3. 图标（首次；如需重新提取官方鲸鱼图标）
node scripts/make-whale-icon.mjs
node scripts/rasterize-whale.mjs
npx --no-install tauri icon src-tauri/icons/icon.png

# 4. 开发运行 / 打包（NSIS 安装器）
npm run dev     # 开发模式（runtime/ 直接使用解压形态）
npm run build   # 产出 src-tauri/target/release/bundle/nsis/*.exe
```

## 发布清单

1. 改 `src-tauri/tauri.conf.json` 与 `package.json` 的 version（保持一致）；
2. `node scripts/make-runtime-archive.mjs`（运行时归档必须与代码同步更新）；
3. `npm run build`；
4. `gh release create v<版本> "安装包路径" --repo 账号/仓库`（tag 去掉 v 后必须等于 version）；
5. 用户端自动检测（启动后 60 秒首查 + 每 6 小时复查）。

## 运行时布局与更新机制

```
runtime/
├─ runtime-archive.tar.gz   安装包内置的单归档（node/ + dsh/）
├─ plugins-src/             桌面插件规范副本（每个 dsh 更新后恢复到新树）
│  ├─ dsh-desktop-bridge/   壳↔DSH 桥（turn-end 通知、凭据写入、用量看板）
│  ├─ dsh-desktop-session-manager/  会话管理插件（列表/删除/恢复归档）
│  └─ dsh-vision-any/       内置识图插件（第三方，固定 commit；.pin 记版本）
├─ version.json             记录 node/dsh/vision 版本
├─ node/、dsh/              首启解压产物（gitignore）
└─ .update-backup.json      dsh 更新后的待验证记录（回滚依据）
```

### 内置识图插件（dsh-vision-any）

- 构建时从 `codeload.github.com/tianmingwan/dsh-vision-any` 下载**固定 commit**
  的 tarball（pin 在 `fetch-runtime.mjs` 的 `VISION_PLUGIN`）；升级插件 = 同步改
  pin 与 version 后重跑 `fetch-runtime`；
- 离线/CI 环境可用 `DSH_DESKTOP_VISION_TARBALL=<本地 tgz>` 跳过下载；
- 运行时挂载：壳把包部署到 `$DSH_HOME/profiles/node_modules/` 并把包名写入
  `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`（等价于
  `dsh plugin --profile web add`，但无需 pnpm/网络；用户手动安装的同名包优先于内置版）；
- 插件配置在 `~/.config/dsh-vision-any/config.json`（用户目录），不在安装包内。

dsh 内核更新流程：下载 npm tarball → 解包到暂存 → 恢复桌面插件（plugins-src/，旧装
为 bridge-src/ 则按旧目录恢复桥接插件）→ 校验 manifest → 旧目录改名备份（保留！）→
新目录就位 → 写 `.update-backup.json` → 自动重启子进程 → 60 秒健康验证：

- 自托管且健康 → 删除备份、清理状态；
- 起不来 → 自动回滚旧版 + 重启（应用重启后也会继续验证）；
- 端口被外部实例占用（接管模式）→ 保留备份，下次自托管启动再验证。

## 桌面插件代码组织

两个插件都在 `scripts/<dir>/` 下维护，随安装器整体内置（用户无需单独安装任何插件）：

```
scripts/<插件>/
├─ package.json    dsh.client 声明（客户端模块发现的钥匙）+ exports["./client"]
├─ index.js        宿主 Cordis 插件入口（只做接线）
├─ lib/*.js        宿主端模块（可独立导入、单测）
├─ src/*.js        客户端模块化源码（React 组件按职责拆文件）
├─ build.mjs       调用共享零依赖 bundler 产出 client.js（生成物，勿手改）
└─ client.js       生成的单文件客户端 bundle（部署产物）
```

- 打包：`npm run build:plugins`（`scripts/lib/build-client-bundle.mjs` 是共享 bundler）；
- 测试：`npm run test:plugins`——客户端冒烟（两个包）、bridge 新旧 bundle
  渲染等价性（fixture 在 `scripts/test-fixtures/`）、bridge 纯视图多状态
  fixture、两个宿主端路由/事务冒烟；
- 新插件接入：在 `scripts/bridge.patch.yml` 加一行、`fetch-runtime.mjs` 的
  `desktopPlugins` 加一项、`src-tauri/src/lib.rs` 的 `DESKTOP_PLUGINS` 加一
  名即可（Rust 侧同步与更新恢复都是按清单通用处理的）；
- 内置**第三方 bundle 型**插件（如 dsh-vision-any）走另一条路：`fetch-runtime.mjs`
  下载源码放 `plugins-src/`，Rust 侧 `VISION_PLUGIN` + `ensure_web_profile_vision_bundle`
  负责部署与 bundles 写入，不需要 `--patch` 行。

## 本仓库开发环境特有的注意事项

以下内容仅适用于本项目当前的受限开发环境（沙箱），普通机器可忽略：

1. **crates.io 镜像**：环境内 schannel 无法访问系统证书库，需先启动
   `node scripts/cargo-mirror.mjs`（纯 HTTP 镜像，端口 8900），并把
   `.cargo-home/config.toml` 的 source 替换随 `CARGO_HOME` 重定向。
2. **路径重定向**：构建/运行需将 `CARGO_HOME`、`TMP/TEMP`、`LOCALAPPDATA`
   （NSIS 工具下载）、WebView2 数据目录（`DSH_DESKTOP_WEBVIEW_DATA_DIR`）
   指到工作区内。
3. **cargo 指纹库陷阱**：并发 cargo 构建会破坏指纹库（"Finished in 5s 但产物
   是旧的"）。异常时对 `src-tauri/src/lib.rs` 执行
   `(Get-Item ...).LastWriteTime = Get-Date` 强制重编。
4. **GUI 进程测试**：release 是 GUI 子系统，PowerShell `&` 不等待；
   用 `Start-Process -PassThru` + `Wait-Process` 保持任务存活，否则进程树
   清理会杀掉应用。
5. **Windows verbatim 路径**：tauri `resource_dir()` 返回 `\\?\` 前缀路径，
   Node CJS 加载器无法处理（`EISDIR lstat 'E:'`）——`strip_verbatim()` 已剥离。

## 环境变量逃生舱（便携/调试用）

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_CONFIG_DIR` | 覆盖应用数据目录（config/logs/patch） |
| `DSH_DESKTOP_WEBVIEW_DATA_DIR` | 覆盖 WebView2 数据目录 |
| `DSH_DESKTOP_DSH_HOME` | 覆盖传给 dsh 的 `DSH_HOME` |
| `DSH_DESKTOP_DSH_PORT` | 覆盖 dsh web 端口（默认 3080） |
| `DSH_DESKTOP_UPDATE_REPO` | 壳更新检测的 GitHub 仓库（`账号/仓库`） |

## 验证清单（发版前）

- [ ] 全新目录模拟安装：只留归档 → 启动 → 首启解压 → 界面可用
- [ ] 端口占用场景：外部实例在 3080 → 应用接管不卡死
- [ ] Key 输入 → 余额显示；对话结束 → 余额刷新（自托管模式）
- [ ] dsh 更新：一键更新 → 自动重启生效 → 健康验证通过（备份被清理）
- [ ] 破坏性更新模拟：替换为启动即崩的内核 → 60 秒后自动回滚 → 服务恢复
- [ ] 托盘余额、关闭最小化、退出清理子进程
- [ ] 启动页：垂直居中、鲸鱼动效、解压/启动两阶段进度条、失败重试
- [ ] DSH 左下角余额组件：宽栏显示余额、窄栏显示鲸鱼图标；点击弹出
      余额与用量面板（余额/模型分布/近 14 天/最近会话）；面板刷新按钮
- [ ] 桥接端点：`GET /desktop/balance` 代理壳余额、`GET /desktop/usage`
      聚合 projcache 用量（Key 登记时间过滤）、壳 38657 `/balance`/`/refresh`
- [ ] 单元测试：`cargo test`（更新机制、vision bundle 挂载等全过）
