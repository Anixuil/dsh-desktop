# dsh-vision-any 桌面叠加层（scripts/vision-any）

内置识图插件 `dsh-vision-any`（上游 `tianmingwan/dsh-vision-any`，固定 commit，
见 `scripts/fetch-runtime.mjs` 的 `VISION_PLUGIN.pin`）由 fetch-runtime 下载到
`runtime/plugins-src/dsh-vision-any`。本目录存放**桌面本地**的补充/补丁，并通过
`scripts/sync-vision-any.mjs` 叠加到抓取下来的插件包上（fetch-runtime 的第
[4/4] 步之后也会自动调用它）。

## 布局

| 路径 | 说明 |
| --- | --- |
| `src/*` | web 客户端模块源码（CommonJS，被 `build.mjs` 打成单文件 bundle） |
| `client.js` | 由 `build.mjs` 生成的客户端 bundle（生成物，勿手改） |
| `build.mjs` | 用共享零依赖打包器把 `src/` 打成 `client.js` |
| `overlay/index.js` | 宿主插件入口的全文件补丁（上游同名文件替换） |
| `overlay/lib/routes.js` | 宿主路由全文件补丁：`/vision-any/settings` + `/vision-any/images/*` |

## 桌面本地功能：聊天内图片预览

上游行为：粘贴图片被保存到临时目录，消息文本替换为
`[Image #N auto-saved to <path>]` 提示（纯文本模型也能处理）。

桌面叠加行为（本目录）：

1. **宿主**（`overlay/lib/routes.js`）：新增同源 GET 路由
   `/vision-any/images/{imageN}/{16位哈希}.{ext}`，把存储的图片以正确的
   content-type 流式返回（内容寻址文件名 → 不可变缓存头）。路径段均为严格
   正则，无路径穿越风险。
2. **客户端**（`src/preview.js`）：把渲染出来的提示文本节点替换为图片卡片
   （图片 URL 完全由提示里的保存路径推导，历史消息同样生效），点击卡片打开
   全屏灯箱预览（Esc / 点击遮罩 / 关闭按钮均可关闭）。React 重渲染时由
   MutationObserver 重新转换。模型可见的提示文本保持不变。
3. 图片已被 LRU/过期清扫时，卡片显示「图片已过期或不可用」占位。

## 同步流程

```powershell
# 只改插件时：
node scripts/vision-any/build.mjs          # 重新打 client.js
node scripts/sync-vision-any.mjs --no-build # 叠加到 runtime 两处副本

# 或一次完成（npm run build:plugins 已包含）：
node scripts/sync-vision-any.mjs
```

重启桌面应用后，Rust 侧 `ensure_runtime_files` 会把
`runtime/plugins-src/dsh-vision-any` 重新部署进 web profile。

`scripts/test-vision-any.mjs` 校验：叠加源 ↔ `plugins-src` 副本 ↔
`runtime/dsh` 镜像三处字节一致，以及路径解析 / 路由防护 / bundle 标记。
