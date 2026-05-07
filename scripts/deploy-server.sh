#!/bin/bash
# ============================================================
# 润石 PoliShit 后端部署脚本
# 目标服务器: 47.99.63.56 (runshi.top)
# 使用方式: ssh root@47.99.63.56 后在服务器上执行
# ============================================================
set -euo pipefail

echo "====== 1. 安装系统依赖 ======"
apt update -y
apt install -y curl nginx certbot python3-certbot-nginx

# 安装 Node.js 20.x
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
echo "Node: $(node -v), npm: $(npm -v)"

echo "====== 2. 创建应用目录 ======"
mkdir -p /opt/runshi/server
mkdir -p /opt/runshi/data
mkdir -p /opt/runshi/keys
mkdir -p /var/www/runshi.top/downloads

echo "====== 3. 配置 Nginx ======"
cat > /etc/nginx/sites-available/runshi.top << 'NGINX'
server {
    listen 80;
    server_name runshi.top www.runshi.top;

    # 静态网站
    root /var/www/runshi.top;
    index index.html;

    # 下载文件 — 大文件直接由 Nginx 提供
    location /downloads/ {
        autoindex off;
        add_header Content-Disposition "attachment";
    }

    # API 反代到 Node.js 后端
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # 支付回调和结账页面也走后端
    location /pay/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 管理后台
    location /admin {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/runshi.top /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "✅ Nginx 已配置"

echo "====== 4. 配置 systemd 服务 ======"
cat > /etc/systemd/system/runshi.service << 'SERVICE'
[Unit]
Description=RunShi PoliShit Commercial Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/runshi/server
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable runshi
echo "✅ systemd 服务已配置"

echo ""
echo "======================================"
echo "  部署框架已就绪！"
echo ""
echo "  接下来需要你从本地上传文件："
echo ""
echo "  # 1. 上传后端代码"
echo "  scp -r server/* root@47.99.63.56:/opt/runshi/server/"
echo "  scp .env root@47.99.63.56:/opt/runshi/server/.env"
echo ""
echo "  # 2. 上传网站文件"
echo "  scp -r docs/* root@47.99.63.56:/var/www/runshi.top/"
echo ""
echo "  # 3. 上传安装包"
echo "  scp dist/*.dmg root@47.99.63.56:/var/www/runshi.top/downloads/"
echo "  scp dist/*.exe root@47.99.63.56:/var/www/runshi.top/downloads/"
echo ""
echo "  # 4. 在服务器上安装依赖并启动"
echo "  ssh root@47.99.63.56"
echo "  cd /opt/runshi/server && npm install"
echo "  systemctl start runshi"
echo ""
echo "  # 5. 备案通过后配置 HTTPS"
echo "  certbot --nginx -d runshi.top -d www.runshi.top"
echo "======================================"
