# 上榜清单（dsh 插件榜收录）

社区榜单（[Oh-My-DSH](https://github.com/like-study1/Oh-My-DSH)、
[awesome-dsh-plugin TOP100](https://github.com/bruc3van/awesome-dsh-plugin/blob/main/TOP100.md)、
[dsh-recommend](https://github.com/zp-home/dsh-recommend) 等）自动爬取 GitHub 上带
`dsh-plugin` topic 的公开仓库并按 star 排序。要上榜只需完成下面的仓库侧设置
（一次性），之后排名全靠 star。

## 一次性设置

1. **Topics**：仓库主页 → About 右侧 ⚙️ → Topics，添加：
   - `dsh-plugin`（**必加**，所有榜单的收录来源）
   - `dsh`、`deepseek`、`deepseek-harness`
   - `tauri`、`desktop`、`windows`
2. **About / Description**：一句话卖点 + 指向 Releases：
   `DeepSeek Harness 的 Windows 桌面客户端：安装即用、零环境要求，内置 Node 与 dsh 内核`
3. **Website**（可选）：填 Releases 页或仓库主页。
4. **Social preview 图**：仓库设置 → Social preview，上传 1280×640 的图
   （可放 `docs/og.png`）。被收录、被转发到 V2EX/小红书时展示更醒目。
5. **Releases**：确认最新安装包挂在 Releases 下（README 安装步骤已指向 Releases）。

## 一键命令（已装 GitHub CLI）

```powershell
gh repo edit Anixuil/dsh-desktop `
  --add-topic dsh-plugin --add-topic dsh --add-topic deepseek `
  --add-topic deepseek-harness --add-topic tauri --add-topic desktop --add-topic windows `
  --description "DeepSeek Harness 的 Windows 桌面客户端：安装即用、零环境要求，内置 Node 与 dsh 内核" `
  --homepage "https://github.com/Anixuil/dsh-desktop/releases"
```

## 验证收录

1. 打上 topic 后打开 <https://github.com/topics/dsh-plugin>，确认能搜到自己；
2. 榜单爬虫自动同步（Oh-My-DSH 每 8 小时，其他 fork 有每小时/每日的），
   最晚一天内出现；
3. 排名 = star 数。想冲榜：发 Release、发推广帖（V2EX / 小红书 / dsh 讨论区）、
   README 放截图。

## 每次发版顺手做的

- [ ] 更新 README 特性列表（新功能是推广素材）
- [ ] 更新 `docs/screenshots/*.png`（界面有变化时）
- [ ] 检查 About 描述与 Website 链接是否过时
