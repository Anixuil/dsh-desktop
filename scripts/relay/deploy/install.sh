#!/usr/bin/env bash
# dsh-desktop-relay — JD Cloud server installer.
#
#   sudo bash install.sh remote.example.com
#
# Installs the relay under /opt/dsh-relay with a generated RELAY_SECRET,
# a systemd unit listening on 127.0.0.1:8080, and a Caddyfile that serves
# *.<domain> over HTTPS with a manually installed wildcard certificate
# (acme.sh + JD Cloud DNS API; see the notes printed at the end).
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "用法: sudo bash install.sh remote.example.com" >&2
  exit 1
fi

command -v node >/dev/null || { echo "缺少 Node.js 20+。Ubuntu/Debian: sudo apt install -y nodejs npm" >&2; exit 1; }
command -v openssl >/dev/null || { echo "缺少 openssl" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR=/opt/dsh-relay

echo "== 停止旧实例并复制文件 =="
systemctl stop dsh-relay 2>/dev/null || true
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" /etc/dsh-relay/tls
cp -r "$SRC/index.js" "$SRC/lib" "$SRC/agent-demo.mjs" "$SRC/package.json" "$SRC/node_modules" "$INSTALL_DIR/"

echo "== 生成 RELAY_SECRET（PC 端连接需要，务必保存）=="
if [ ! -f /etc/dsh-relay.env ]; then
  SECRET="$(openssl rand -hex 32)"
  printf 'RELAY_SECRET=%s\n' "$SECRET" > /etc/dsh-relay.env
  chmod 600 /etc/dsh-relay.env
  echo "RELAY_SECRET=$SECRET"
else
  echo "(已存在 /etc/dsh-relay.env，沿用旧 secret)"
fi

echo "== 安装 systemd 服务 =="
cat > /etc/systemd/system/dsh-relay.service <<'EOF'
[Unit]
Description=dsh-desktop relay
After=network.target

[Service]
EnvironmentFile=/etc/dsh-relay.env
ExecStart=/usr/bin/node /opt/dsh-relay/index.js --port 8080 --host 127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now dsh-relay
sleep 1
curl -fsS http://127.0.0.1:8080/healthz >/dev/null && echo "relay 已启动，healthz ok"

echo "== 写入 Caddyfile（证书文件由 acme.sh 提供）=="
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
*.${DOMAIN}, ${DOMAIN} {
    tls /etc/dsh-relay/tls/fullchain.pem /etc/dsh-relay/tls/key.pem
    reverse_proxy 127.0.0.1:8080
}
EOF
if command -v caddy >/dev/null; then
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "caddy 已重载"
else
  echo "未检测到 caddy，稍后安装: sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt update && sudo apt install -y caddy"
fi

cat <<EOF

== 剩余步骤（域名 DNS 服务商 + 京东云控制台 + 服务器）==
1. DNS 解析：在域名的 DNS 服务商（如华为云"云解析服务 DNS"）为 ${DOMAIN} 添加记录
    主机记录 *    类型 A    值 <京东云服务器公网IP>
2. 京东云安全组：放行 TCP 80、443（caddy 需要 80 做证书签发/续期，443 是入口）
3. 泛域名证书（acme.sh + 域名服务商 DNS API；华为云用 dns_huaweicloud）：
     curl https://get.acme.sh | sh -s email=you@example.com
     # 华为云：控制台"我的凭证 -> 访问密钥"创建 AK/SK
     export HUAWEICLOUD_ACCESS_KEY_ID="华为云AK" HUAWEICLOUD_SECRET_ACCESS_KEY="华为云SK"
     ~/.acme.sh/acme.sh --issue -d ${DOMAIN} -d '*.${DOMAIN}' --dns dns_huaweicloud
     ~/.acme.sh/acme.sh --install-cert -d ${DOMAIN} \
       --fullchain-file /etc/dsh-relay/tls/fullchain.pem \
       --key-file /etc/dsh-relay/tls/key.pem \
       --reloadcmd "systemctl reload caddy"
   （变量名以 acme.sh 脚本头部注释为准：~/.acme.sh/dnsapi/dns_huaweicloud.sh；
     若报 400/region 错误，参考其 issue 或加 export HUAWEICLOUD_REGION="cn-north-4"）
4. 验证 relay：浏览器开 https://test.${DOMAIN}/ 应显示 relay 欢迎页
5. PC 端（本机试跑）：
     cd scripts/relay
     \$env:RELAY_URL="wss://${DOMAIN}"; \$env:RELAY_SECRET="<上面的 secret>"; \$env:DEVICE_ID="my-pc"
     node agent-demo.mjs
6. 手机（4G/5G）打开 https://my-pc.${DOMAIN}/ —— 就是你 PC 上的 dsh 界面
EOF
