# DSH Desktop

**DeepSeek Harness 的 Windows 桌面客户端**（第三方社区项目）。

把命令行版 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 变成真正的桌面应用：**安装即用，零环境要求**——内置 Node.js 运行时与 dsh 内核，用户不需要安装 Node、不需要碰终端，双击打开就是完整界面。

> 鲸鱼图标取自 `@deepseek-ai/dsh` 官方 favicon，其版权归 DeepSeek 所有。
> 本项目与 DeepSeek 官方无关，MIT 协议开源；仓库不含 dsh 运行时本体
> （构建时通过脚本从 npm 官方源下载）。

## ✨ 特性

- **装完即用**：NSIS 安装包内置 Node 便携版 + dsh 内核 + WebView2 壳，目标机器零依赖
- **壳核分离**：以子进程方式运行官方 `dsh web`，主窗口直接承载 DSH 原生界面；命令行版的会话、配置、插件生态全部共享（默认 `~/.dsh`）
- **API Key 管理**：设置页输入即校验，Key 存入 Windows 凭据管理器并同步给 DSH
- **额度实时监控**：调用官方 `GET /user/balance` 显示总余额/充值/赠送余额；
  保存时、每 60 秒、托盘手动、**以及每轮对话结束后**（桥接插件监听 `agent/status`）自动刷新
- **内核自动更新**：官方 dsh 发布新版本自动检测（npm 官方源），一键更新、
  更新完自动重启服务立即生效；新内核 60 秒健康验证，**起不来自动回滚旧版**
- **壳自动更新检测**：配置 GitHub 仓库后，启动即查 + 每 6 小时复查（[配置教程](#壳自动更新)）
- **桌面体验**：系统托盘（余额/打开/设置/退出）、关闭窗口最小化到托盘、
  单实例锁、崩溃自动重启、日志落盘、开机自启

## 📦 安装

1. 到 [Releases](https://github.com/Anixuil/dsh-desktop/releases) 下载 `DSH Desktop_*.exe`；
2. 双击安装（用户级安装，无需管理员）；
3. 打开应用。**首次启动约 1 分钟**（解压内置运行时，界面有进度提示），之后秒开。

> 提示：若命令行版 DSH 正在运行（占用 3080 端口），桌面版会自动接入该实例并共享会话；
> 想要「对话后实时刷新余额」，请先退出命令行 DSH，让桌面版自托管内核。

## 🚀 使用

| 操作 | 入口 |
|---|---|
| 配置 API Key / 查看余额 | 托盘右键 →「设置 / API Key」 |
| 检查更新 / 更新 dsh 内核 | 设置页「自动更新」卡片 |
| 开机自启 | 设置页勾选 |
| 打开日志 | 设置页「诊断」或 `%APPDATA%\com.anixuil.dshdesktop\logs\dsh.log` |
| 退出（停止内核） | 托盘右键 →「退出」（关闭窗口只是最小化） |

## ⚙️ 工作原理

```
DSH Desktop（Tauri 2 壳，Windows）
├─ 进程管理：spawn 内置 node + dsh web → 健康检查 → 主窗口加载 127.0.0.1:3080
├─ 桥接插件 dsh-desktop-bridge（--patch 注入 dsh）
│   ├─ 对话结束（agent/status→idle）→ 通知壳刷新余额
│   └─ 接收壳下发的 API Key → 写入 DSH credentials
├─ 更新：dsh 内核（npm 官方源 + 健康验证 + 自动回滚）｜壳（GitHub Releases 检测）
└─ 托盘 / 单实例 / 日志 / 自启
```

- 端口：dsh web `3080`；壳监听 `38657`（对话结束通知）；桥接插件 `38658`（Key 写入/心跳）
- 数据：`DSH_HOME` 默认 `~/.dsh`，与命令行版完全共享

## 🔄 壳自动更新

1. 用 [gh](https://cli.github.com/) 发布安装包：
   `gh release create v0.1.0 "安装包路径" --repo 你的账号/你的仓库`
2. 配置更新源（二选一）：
   - `%APPDATA%\com.anixuil.dshdesktop\config.json` 写入 `{"updateRepo": "账号/仓库"}`
   - 或设环境变量 `DSH_DESKTOP_UPDATE_REPO=账号/仓库`
3. 重启应用。检测到新 tag 时设置页会提示"应用有新版 x → y"。

以后发版：改 `tauri.conf.json` 的 version → `npm run build` → 用 gh 发对应 tag 的 Release。

## 🛠 从源码构建

要求：Windows 10/11 x64、Node.js ≥ 20、pnpm/npm、Rust（MSVC 工具链）、Visual Studio 2022 C++ 工具。

```powershell
npm install
node scripts/fetch-runtime.mjs        # 组装 Node 便携版 + dsh 内核
node scripts/make-runtime-archive.mjs # 打包运行时归档
npm run dev                           # 开发运行
npm run build                         # 产出 NSIS 安装包
```

完整构建说明（含环境细节与发布清单）见 [`docs/BUILDING.md`](docs/BUILDING.md)。

## 📁 项目结构

| 路径 | 内容 |
|---|---|
| `src-tauri/src/lib.rs` | 壳全部逻辑（进程/健康检查/余额/托盘/更新/自启） |
| `ui/` | 启动页与设置页（纯静态，无构建步骤） |
| `scripts/bridge/` | `dsh-desktop-bridge` Cordis 插件（`--patch` 注入 dsh） |
| `scripts/fetch-runtime.mjs` | 下载/组装运行时 |
| `scripts/make-runtime-archive.mjs` | 打包运行时单归档（安装提速） |
| `scripts/make-whale-icon.mjs` 等 | 图标提取与光栅化 |

## ⚠️ 已知限制

- 安装包未做代码签名（SmartScreen 可能提示"未知发布者"，点"仍要运行"即可）
- 壳更新目前是"检测 + 引导下载"，未做应用内一键安装
- 仅支持 Windows；macOS/Linux 待规划

## 📄 许可证

[MIT](LICENSE) © 2026 Anixuil

DeepSeek、DeepSeek Harness 及其鲸鱼标志归 DeepSeek 所有；本项目为独立社区项目。
