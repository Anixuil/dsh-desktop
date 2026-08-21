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

# 2. 组装运行时（Node 便携版 + dsh + 桥接插件 + 内置识图插件 + 插件市场）
#    dsh 版本号可指定，默认 0.1.0-rc.6；latest 取最新
node scripts/fetch-runtime.mjs 0.1.0-rc.6

# 2b. 打包运行时归档（发布构建前必做；安装器只装归档，安装完成后后台预热）
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

1. 同步修改 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 的版本。
2. 首次配置 updater 时运行 `npx --no-install tauri signer generate -w "$env:USERPROFILE\.tauri\dsh-desktop-updater.key"`，交互输入密码；私钥与密码不得进入仓库或日志，公钥写入 `tauri.conf.json`。
3. 在 GitHub Actions 配置 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
4. 本地运行 `npm run verify:release -- --tag=v<版本>`、`npm run test:plugins`、`cargo test --manifest-path src-tauri/Cargo.toml` 与 `npm run check`。
5. 创建 `v*` tag 后，Windows Release workflow 会再次校验三个版本入口、线上最新版本和 npm latest，重建运行时/插件并发布普通 setup.exe、签名 updater artifact、`.sig` 与 `latest.json`。

workflow 会在工作树版本仍等于线上 latest、tag 与配置不一致，或内置 dsh 低于构建时 npm latest 时失败。`0.2.1` 是 updater 引导版本，不应从 0.2.0 内部直接安装；0.2.0 用户需要手动覆盖 setup.exe 一次。

## 运行时布局与更新机制

```
runtime/
├─ runtime-archive.tar.gz   安装包内置的单归档（node/ + dsh/）
├─ plugins-src/             桌面插件规范副本（每个 dsh 更新后恢复到新树）
│  ├─ dsh-desktop-bridge/   壳↔DSH 桥（turn-end 通知、凭据写入、用量看板）
│  ├─ dsh-desktop-session-manager/  会话管理插件（列表/删除/恢复归档）
│  ├─ dsh-desktop-change-history/   变更历史插件（AI 文件改动 diff 查看/回滚）
│  ├─ dsh-vision-any/       内置识图插件（第三方，固定 commit；.pin 记版本）
│  ├─ dshmarket/            内置插件市场（第三方，固定 npm 发布版）
│  └─ js-yaml/、argparse/、undici/  插件市场的生产依赖
├─ version.json             记录 node/dsh/vision 版本
├─ node/、dsh/              首启解压产物（gitignore）
└─ .update-backup.json      dsh 更新后的待验证记录（回滚依据）
```

`node/` 与 `dsh/` 默认解压到安装目录下的 `runtime/`。安装器完成资源复制后会以
隐藏模式启动一次桌面端，后台预热归档；用户在预热结束后首次打开即可直接进入正常冷
启动。若用户立刻打开，单实例窗口会复用同一预热任务，不会重复解压。预热被中断或
失败时，普通启动会自动安全重试。

解压先落到相邻的暂存目录，校验 Node 与 dsh 入口后才切换到正式目录；并写入与归档
大小/修改时间绑定的 `.runtime-ready.json`。新安装包携带不同归档时会自动重新准备。
当安装目录对当前用户不可写
（驱动器根目录 ACL、企业策略或安全软件拦截，首启会报 “拒绝访问 (os error 5)
when creating dir …\runtime\node”），壳会自动改解压到
`%LOCALAPPDATA%\com.anixuil.dshdesktop\runtime\`（探测方式是实际创建一个目录）；
归档与 `plugins-src/` 始终从安装目录读取，卸载时两条路径都会清理。

### 内置识图插件（dsh-vision-any）

- 构建时从 `codeload.github.com/tianmingwan/dsh-vision-any` 下载**固定 commit**
  的 tarball（pin 在 `fetch-runtime.mjs` 的 `VISION_PLUGIN`）；升级插件 = 同步改
  pin 与 version 后重跑 `fetch-runtime`；
- 离线/CI 环境可用 `DSH_DESKTOP_VISION_TARBALL=<本地 tgz>` 跳过下载；
- 运行时挂载：壳把包部署到 `$DSH_HOME/profiles/node_modules/` 并把包名写入
  `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`（等价于
  `dsh plugin --profile web add`，但无需 pnpm/网络；用户手动安装的同名包优先于内置版）；
- 插件配置在 `~/.config/dsh-vision-any/config.json`（用户目录），不在安装包内。

### 内置插件市场（dshmarket）

- 构建时从 npm 安装固定发布版 `dshmarket@1.15.0`，连同其生产依赖复制到
  `runtime/plugins-src/`；
- 启动时壳将其追加到 web profile 的 `dsh.profile.bundles`，效果等价于
  `dsh plugin --profile web add dshmarket`；用户可在「设置 → Plugin Market」中
  浏览并安装社区插件；若已存在用户安装的同名包则复用且不覆盖；
- 版本更新时改 `fetch-runtime.mjs` 中的 `MARKET_PLUGIN.version` 后重新组装运行时。

dsh 内核更新流程：重新读取 npm 官方 metadata，严格比较 SemVer 并校验包名、HTTPS tarball 与 SHA-512 → 下载 npm tarball → 解包到暂存 → 恢复桌面插件（plugins-src/，旧装
为 bridge-src/ 则按旧目录恢复桥接插件）→ 校验 manifest → 旧目录改名备份（保留！）→
新目录就位 → 写 `.update-backup.json` → 自动重启子进程 → 60 秒健康验证：

- 自托管且健康 → 删除备份、清理状态；
- 起不来 → 自动回滚旧版 + 重启（应用重启后也会继续验证）；
- 端口被外部实例占用（接管模式）→ 保留备份，下次自托管启动再验证。

桌面壳通过固定的 GitHub `latest.json` endpoint 与编译内置公钥执行签名更新。NSIS `/UPDATE` 模式保留 runtime；若用户已安装的 dsh 比安装包内置版本更新，只替换 Node、壳资源与桌面自有插件，不降级 dsh。完整卸载仍按用户选择清理安装目录 runtime 与本地 fallback。

## 桌面插件代码组织

三个桌面插件都在 `scripts/<dir>/` 下维护，随安装器整体内置（用户无需单独安装任何插件）：

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
  fixture、两个宿主端路由/事务冒烟，以及 vision-any 叠加层一致性/图片路由
  防护（`scripts/test-vision-any.mjs`）；
- 新插件接入：在 `scripts/bridge.patch.yml` 加一行、`fetch-runtime.mjs` 的
  `desktopPlugins` 加一项、`src-tauri/src/lib.rs` 的 `DESKTOP_PLUGINS` 加一
  名即可（Rust 侧同步与更新恢复都是按清单通用处理的）；
- 内置**第三方 bundle 型**插件（如 dsh-vision-any、dshmarket）走另一条路：
  `fetch-runtime.mjs` 下载或安装后放入 `plugins-src/`，Rust 侧统一部署并写入
  web profile 的 `bundles`，不需要 `--patch` 行。首次部署会记录为桌面版管理；
  若目录在首次启动前已存在，则视为用户管理并永久复用、不覆盖；
- 识图插件的**桌面本地叠加层**在 `scripts/vision-any/`（客户端模块源码 + 宿主
  全文件补丁 + build 脚本），由 `scripts/sync-vision-any.mjs` 叠加到抓取下来的
  插件包并镜像进 `runtime/dsh`——`fetch-runtime.mjs` 第 [4/4] 步后自动执行，
  `npm run build:plugins` 也包含该步。桌面本地功能（聊天内图片卡片 + 点击灯箱
  预览 + `/vision-any/images/*` 图片路由）都在这个叠加层里维护。

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
| `DSH_DESKTOP_UPDATE_REPO` | 已弃用，仅为旧配置兼容保留；不能改变生产签名更新源 |
| `VOLC_ACCESS_KEY` / `VOLC_SECRET_KEY` | 火山引擎费用中心 OpenAPI 余额查询的账户 AccessKey/SecretKey（也接受 `VOLCENGINE_*`；`VOLC_REGION` 覆盖地域默认 `cn-north-1`） |

## 验证清单（发版前）

- [ ] 全新目录模拟安装：只留归档 → 启动 → 首启解压 → 界面可用
- [ ] 端口占用场景：外部实例在 3080 → 应用接管不卡死
- [ ] Key 输入 → 余额显示；对话结束 → 余额刷新（自托管模式）
- [ ] dsh 更新：一键更新 → 自动重启生效 → 健康验证通过（备份被清理）
- [ ] 破坏性更新模拟：替换为启动即崩的内核 → 60 秒后自动回滚 → 服务恢复
- [ ] 0.2.0 → 0.2.1 手动覆盖：配置、快捷方式和更高版本 dsh 均保留
- [ ] 0.2.1 → 测试版 0.2.2：应用内下载、签名校验、安装、重启、版本生效
- [ ] 活跃任务期间两类更新均不可执行，任务完成后按钮自动恢复
- [ ] Release 含 setup.exe、签名更新包、`.sig`、`latest.json`，且存在 `windows-x86_64` 平台键
- [ ] 托盘余额、关闭最小化、退出清理子进程
- [ ] 启动页：垂直居中、鲸鱼动效、解压/启动两阶段进度条、失败重试
- [ ] DSH 左下角余额组件：宽栏显示余额、窄栏显示鲸鱼图标；点击弹出
      余额与用量面板（余额/模型分布/近 14 天/最近会话）；面板刷新按钮
- [ ] 桥接端点：`GET /desktop/balance` 代理壳余额、`GET /desktop/usage`
      聚合 projcache 用量（Key 登记时间过滤）、壳 38657 `/balance`/`/refresh`
- [ ] 单元测试：`cargo test`（更新机制、vision bundle 挂载等全过）
