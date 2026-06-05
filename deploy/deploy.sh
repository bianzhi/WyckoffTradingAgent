#!/usr/bin/env bash
# ============================================
# Wyckoff Trading Agent — 一键构建+启动
# 用法: bash deploy/deploy.sh              (增量构建)
#       bash deploy/deploy.sh --clean      (全量重建)
# ============================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.production"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)]${NC} $*"; }

# ── 前置检查 ──
command -v docker >/dev/null 2>&1 || { err "缺少 docker"; exit 1; }
if ! docker compose version >/dev/null 2>&1; then
  err "缺少 docker compose 插件"; exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  err ".env.production 不存在: $ENV_FILE"
  exit 1
fi

# ── 构建参数 ──
BUILD_ARGS=()
if [[ "${1:-}" == "--clean" ]]; then
  BUILD_ARGS=(--no-cache)
  log "模式: 全量重建 (--no-cache)"
else
  log "模式: 增量构建"
fi

# ── 构建全部镜像 ──
log "构建 agent ..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build "${BUILD_ARGS[@]}" agent

log "构建 nginx (前端) ..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build "${BUILD_ARGS[@]}" nginx

log "构建 api ..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build "${BUILD_ARGS[@]}" api

# ── 启动全部服务 ──
log "启动所有服务..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate

# ── 等待就绪 ──
log "等待 agent 就绪..."
for i in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" ps 2>/dev/null | grep -q "wyckoff-api.*healthy"; then
    log "全部服务已就绪 ✓"
    break
  fi
  sleep 2
done

# ── 清理 ──
docker image prune -f 2>/dev/null || true

echo ""
log "容器状态:"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "访问: http://$(hostname -I 2>/dev/null | awk '{print $1}' || hostname):8901/"
