#!/usr/bin/env bash
# ============================================
# Wyckoff Trading Agent — 阿里云 ECS 部署脚本
# ============================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()  { echo -e "${RED}[ERR]${NC}   $*"; }

# --- 检查前置条件 ---
check_prereqs() {
  local missing=()

  command -v docker >/dev/null 2>&1 || missing+=("docker")
  command -v docker compose >/dev/null 2>&1 && {
    DOCKER_COMPOSE="docker compose"
  } || command -v docker-compose >/dev/null 2>&1 && {
    DOCKER_COMPOSE="docker-compose"
  } || missing+=("docker compose / docker-compose")

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "缺少依赖: ${missing[*]}"
    echo ""
    echo "阿里云 ECS 安装 Docker:"
    echo "  curl -fsSL https://get.docker.com | sh"
    echo "  systemctl enable docker && systemctl start docker"
    exit 1
  fi
}

# --- 检查环境变量 ---
check_env() {
  if [[ ! -f "$SCRIPT_DIR/.env.production" ]]; then
    err ".env.production 不存在"
    echo "  请复制模板并填入真实值:"
    echo "  cp deploy/.env.production deploy/.env.production.real"
    echo "  编辑 deploy/.env.production.real 后重试"
    exit 1
  fi

  # 检查必填项
  source "$SCRIPT_DIR/.env.production"
  local missing_vars=()
  [[ -z "${SUPABASE_URL:-}" ]]      && missing_vars+=("SUPABASE_URL")
  [[ -z "${SUPABASE_ANON_KEY:-}" ]] && missing_vars+=("SUPABASE_ANON_KEY")

  if [[ ${#missing_vars[@]} -gt 0 ]]; then
    err "缺少必填环境变量: ${missing_vars[*]}"
    exit 1
  fi
  log "环境变量检查通过 ✓"
}

# --- 构建 ---
build() {
  log "构建 Docker 镜像..."
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f deploy/docker-compose.yml build --no-cache
  log "构建完成 ✓"
}

# --- 启动 ---
start() {
  log "启动服务..."
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f deploy/docker-compose.yml up -d

  echo ""
  log "服务已启动，检查状态..."
  sleep 3
  $DOCKER_COMPOSE -f deploy/docker-compose.yml ps

  echo ""
  log "API 健康检查:"
  curl -sf http://localhost/api/health && echo "" || warn "健康检查失败，请查看日志"
}

# --- 停止 ---
stop() {
  log "停止服务..."
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f deploy/docker-compose.yml down
  log "已停止"
}

# --- 重启 ---
restart() {
  stop
  start
}

# --- 查看日志 ---
logs() {
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f deploy/docker-compose.yml logs -f --tail=100 "${@:-}"
}

# --- 状态 ---
status() {
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f deploy/docker-compose.yml ps
}

# --- 清理 ---
clean() {
  warn "将删除所有容器、镜像和数据卷"
  read -rp "确认? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    cd "$PROJECT_DIR"
    $DOCKER_COMPOSE -f deploy/docker-compose.yml down -v --rmi all
    log "清理完成"
  else
    log "取消"
  fi
}

# --- 用法 ---
usage() {
  cat <<EOF
用法: $0 <命令>

命令:
  build     构建 Docker 镜像
  start     启动服务 (docker compose up -d)
  stop      停止服务
  restart   重启服务
  logs      查看日志 (可选: logs api | logs agent | logs nginx)
  status    查看服务状态
  clean     清理全部容器/镜像/数据卷 (需确认)
  all       构建 + 启动 (首次部署)

示例:
  # 首次在 ECS 上部署
  $0 all

  # 更新代码后重新部署
  git pull && $0 build && $0 restart

  # 查看 Agent 日志
  $0 logs agent

  # 配置 HTTPS 后:
  # 1. 将 SSL 证书放入 deploy/ssl/
  # 2. 取消 nginx.conf 中 443 部分的注释
  # 3. docker compose restart nginx
EOF
}

# --- 主入口 ---
main() {
  check_prereqs

  case "${1:-}" in
    build)   check_env; build ;;
    start)   check_env; start ;;
    stop)    stop ;;
    restart) check_env; restart ;;
    logs)    shift; logs "$@" ;;
    status)  status ;;
    clean)   clean ;;
    all)     check_env; build; start ;;
    *)       usage; exit 1 ;;
  esac
}

main "$@"
