# dsh-desktop-relay

公网中继：让手机浏览器（PWA）在**非局域网**下访问运行在 PC 上的 dsh-desktop，进行对话和任务执行。手机和 PC 都只发起出站连接，任何网络（家用 NAT、公司网络、4G/5G）零配置穿透。

```
手机浏览器  ──https/wss──▶  京东云服务器（relay + caddy）  ◀──wss 出站长连──  PC (dsh-desktop)
https://<deviceId>.remote.example.com/                        /agent?deviceId=<deviceId>
```

relay **不理解 dsh 协议**：它把 HTTP 交换和 WS 流作为不透明帧转发，因此 dsh 运行时升级对 relay 零影响。手机端打开的正是 dsh-desktop 现有的 Web UI，无二次开发。

## 快速开始（本地验证）

```powershell
# 依赖：ws@8.21（纯 JS 包；无网络时从 runtime\dsh\node_modules\ws 复制）
Copy-Item -Recurse runtime/dsh/node_modules/ws scripts/relay/node_modules/ws
$env:RELAY_SECRET = "换成至少8位的随机串"
node scripts/relay/index.js --port 8080
```

冒烟测试（模拟 agent + 手机侧 HTTP/WS 全链路）：

```powershell
node scripts/test-relay.mjs        # 已并入 npm run test:plugins
```

本地端到端验证（relay + agent-demo + 本机正在运行的 dsh web 3080）：

```powershell
# 终端 1：起 relay
$env:RELAY_SECRET="test-secret-12345"; node scripts/relay/index.js --port 8081
# 终端 2：起 PC 端 agent（把请求转发到本机 3080）
$env:RELAY_URL="ws://127.0.0.1:8081"; $env:RELAY_SECRET="test-secret-12345"
$env:DEVICE_ID="my-pc"; node scripts/relay/agent-demo.mjs
# 终端 3：模拟手机（子域名路由）
curl.exe -H "Host: my-pc.remote.example.com" -H "Authorization: Bearer test-secret-12345" http://127.0.0.1:8081/
#   期望：返回 dsh 首页 HTML（含 window.__DSH_BOOT__）
```

## 帧协议

Agent 与 relay 之间每帧一条 JSON（WS 文本消息）。`id` 由 relay 分配，单调递增；同帧类型见 `lib/frames.js`。

**relay → agent**

| 帧 | 字段 | 含义 |
|---|---|---|
| `ping` | | 心跳请求，回 `pong` |
| `req` | `id, method, path, headers, body(base64\|null)` | 手机的一次 HTTP 请求 |
| `ws-open` | `id` | 手机要一条 WS 流；agent 连本地 dsh 后回 `ws-ready` |
| `ws-data` | `id, data(base64), binary` | 手机 → 本地 WS |
| `ws-close` | `id, code, reason` | 手机关了 WS，agent 应关闭本地 WS |

**agent → relay**

| 帧 | 字段 | 含义 |
|---|---|---|
| `pong` | | 心跳应答 |
| `res` | `id, status, headers, body(base64\|null)` | 完整响应（无 body = 仅响应头，随后流式） |
| `chunk` | `id, data(base64)` | 流式分片 |
| `end` | `id` | 流式结束 |
| `err` | `id, message` | 本地请求失败，relay 回 502 |
| `ws-ready` | `id` | 本地 WS 已建好，开始双向管道 |
| `ws-data` | `id, data(base64), binary` | 本地 WS → 手机 |
| `ws-close` | `id, code, reason` | 本地 WS 关闭 |

## Agent 端实现约定（PC 侧 relay-client）

产品实现已存在：`scripts/relay-client/`（`dsh-desktop-relay-client`），由 dsh-desktop 壳作为伴生进程管理（设置窗口 → 远程访问卡片，填入中继地址/密钥/设备名即可；状态经 `127.0.0.1:38659/ping` 上报）。`agent-demo.mjs` 是同协议的独立验证脚本，仅用于无壳环境手工测试。

1. 持 `deviceId`（`[a-z0-9][a-z0-9_-]{0,61}[a-z0-9]`，本机持久化）+ `RELAY_SECRET`；
2. 连 `wss://<relay>/agent?deviceId=<id>`，`Authorization: Bearer <secret>`；
3. 收到 `req` → `fetch('http://127.0.0.1:3080' + path, { method, headers, body })` → 流式回 `res`/`chunk`/`end`（响应流立即转发，不缓冲）；本地失败回 `err`；
4. 收到 `ws-open` → 对 `ws://127.0.0.1:3080` 发起 upgrade → 成功回 `ws-ready` 并双向管道 `ws-data`；
5. 收到 `ping` 立即回 `pong`；断线指数退避重连；被挤下线（close 4000）提示"另一处已连接"。

请求体上限 1 MiB（413）；透传模式下请求以 loopback 到达 dsh，天然通过 browser-trust fence，无需 `--trusted-host`。协议帧常量在 `relay/lib/frames.js` 与 `relay-client/lib/frames.js` 双份镜像（部署单元独立），`test-relay-client.mjs` 强制二者一致。

## 京东云部署

前置：已备案域名（子域名不需要单独备案）、安全组放行 80/443（22 管理口可选）。

```bash
# 1. Node 20+ 与代码
mkdir -p /opt/dsh-relay && cd /opt/dsh-relay
#    上传 scripts/relay/（index.js、lib/、package.json），然后：
npm install --omit=dev        # 或从 runtime 复制 ws 到 node_modules/

# 2. 密钥（至少 16 字节随机串，务必换掉）
openssl rand -hex 32          # 记为 RELAY_SECRET

# 3. systemd 守护：/etc/systemd/system/dsh-relay.service
#    [Service] Environment=RELAY_SECRET=<上一步输出>
#    ExecStart=/usr/bin/node /opt/dsh-relay/index.js --port 8080 --host 127.0.0.1
#    Restart=always ; systemctl enable --now dsh-relay

# 4. caddy 反代 + 泛域名证书（先在域名的 DNS 服务商处加 *.remote 的 A 记录到本机 IP；
#    证书用 acme.sh + 该服务商的 DNS API 签发，华为云为 dns_huaweicloud，京东云为 dns_jd）
#    Caddyfile:
#      *.remote.example.com { reverse_proxy 127.0.0.1:8080 }
#    remote.example.com { respond "dsh-desktop-relay" 200 }
```

手机访问：`https://<deviceId>.remote.example.com/`（`deviceId` 见 PC 端设置面板，Phase 2 起提供扫码入口）。

## 产品身份流程（注册 + 配对码 + 手机令牌）

原型阶段的"单一共享 secret"已升级为按设备身份：

```
PC 首次保存配置   POST /register {deviceId}            -> {deviceSecret}（自动，用户无感知）
PC 设置页点按钮    POST /pairing {deviceId} (Bearer deviceSecret) -> {code}（6 位，5 分钟）
PC 设置长期码      POST /persistent-pairing {deviceId, code} (Bearer deviceSecret) -> {enabled}（可清空关闭）
手机登录页输码     POST /pair {code}                    -> {deviceId, phoneToken}（长期）
手机后续访问       设备子域名 + phoneToken（cookie 或 Bearer）
```

- `RELAY_SECRET` 保留为**管理员密钥**：可连接/访问任何设备（旧部署无缝兼容，也可用于排障）。
- 设备身份持久化在 relay 工作目录的 `relay-state.json`（只存哈希，不存明文；定期备份该文件即可迁移设备）。
- 可选：设置 `RELAY_REGISTER_SECRET` 环境变量后，`/register` 需要持有该值（防止开放注册被滥用）；不设则开放注册。
- **升级提醒**：桌面端“保存长期码”依赖 `/persistent-pairing`。若界面显示 HTTP 404，说明线上 relay 仍是旧版本；请重新打包并部署本目录的最新 `index.js` 与 `lib/`，然后重启 `dsh-relay` 服务。

## 原型阶段已知限制

- **无端到端加密**：对话内容经 relay 转发，日志需最小化；E2E 加密列入后续。
- **路径前缀模式**（`/d/<deviceId>/...`）下页面内的绝对路径资源会错位；**请使用 Host 子域名模式**，前缀模式仅作调试与状态查询。
- 无限流、无审计（产品化前补齐）。
- 长期授权设备数量不限；Relay 按设备限制同时活跃的手机会话数，默认 3 个。可通过 `RELAY_MAX_CONCURRENT_VIEWERS` 调整（1–64），空闲会话默认 5 分钟回收，可通过 `RELAY_VIEWER_IDLE_TIMEOUT`（毫秒）调整。
- 手机端离线通知依赖 Web Push（后续里程碑）。

## 测试

`scripts/test-relay.mjs` 覆盖：healthz、鉴权拦截、登录 + Cookie、注册/配对码/手机令牌全流程（含单次有效与未授权拒绝）、离线 503、完整/流式 HTTP 转发、WS 桥接与关闭镜像、状态端点（前缀 + 子域名）、子域名路由、重复 agent 挤下线（4000）、断连转离线。
