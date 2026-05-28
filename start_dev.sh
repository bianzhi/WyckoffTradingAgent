#!/bin/bash
# Wyckoff Trading Agent - 启动开发服务
# 用法: bash start_dev.sh

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$ROOT_DIR/web"

echo "🚀 启动 WyckoffTradingAgent 开发服务..."

# 启动 Vite 前端
echo "  📦 启动 Vite 前端 (localhost:5173)..."
cd "$WEB_DIR/apps/web"
npx vite --host &
VITE_PID=$!

# 启动 Wrangler API
echo "  🔌 启动 API 后端 (localhost:8787)..."
cd "$WEB_DIR/apps/api"
npx wrangler dev &
WRANGLER_PID=$!

echo ""
echo "⏳ 等待服务就绪..."
sleep 5

# 验证
echo ""
if curl -s -o /dev/null -w "" http://localhost:5173/ 2>/dev/null; then
    echo "✅ 前端: http://localhost:5173/"
else
    echo "⚠️  前端可能尚未就绪，请稍后重试"
fi

if curl -s -o /dev/null http://localhost:8787/ 2>/dev/null; then
    echo "✅ API:   http://localhost:8787"
else
    echo "⚠️  API 可能尚未就绪，请稍后重试"
fi

echo ""
echo "按 Ctrl+C 停止所有服务"
wait
