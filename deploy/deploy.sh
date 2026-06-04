#!/usr/bin/env bash
# ============================================
# Wyckoff Trading Agent — ECS 一键部署脚本
# ============================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)]${NC} $*"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)]${NC} $*"; }

# ── 检查前置条件 ──────────────────────────────────────
check_prereqs() {
  local missing=()
  command -v docker >/dev/null 2>&1 || missing+=("docker")
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  else
    missing+=("docker compose")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "缺少依赖: ${missing[*]}"
    echo "  安装 Docker: curl -fsSL https://get.docker.com | sh"
    exit 1
  fi
}

ENV_FILE="$SCRIPT_DIR/.env.production"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

# ── 检查环境变量 ──────────────────────────────────────
check_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    warn ".env.production 不存在，将使用默认值"
    return 0
  fi
  log "环境变量: $ENV_FILE ✓"
}

# ── git pull + 构建 agent + 启动 ───────────────────────
update() {
  local clean_flag="${1:-}"

  cd "$PROJECT_DIR"

  log "拉取最新代码..."
  if ! git branch --set-upstream-to=origin/main main 2>/dev/null; then
    git checkout -b main 2>/dev/null || true
    git branch --set-upstream-to=origin/main main 2>/dev/null || true
  fi

  if ! git pull origin main; then
    err "git pull 失败，检查网络或 GitCode 仓库状态"
    exit 1
  fi

  echo ""
  log "本次更新内容:"
  git --no-pager log --oneline -5
  echo ""

  local build_args=()
  if [[ "$clean_flag" == "--clean" ]]; then
    build_args=(--no-cache)
    warn "使用 --no-cache 全量重建"
  else
    log "使用 Docker 层缓存加速构建（仅变更文件重新构建）"
  fi

  read -r -p "确认部署以上更新？[Y/n] " answer
  answer="${answer:-Y}"
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    warn "已取消"
    exit 0
  fi

  log "构建 agent 容器..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build "${build_args[@]}" agent

  log "启动 agent..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d agent

  log "等待健康检查..."
  for i in $(seq 1 30); do
    if $DOCKER_COMPOSE -f "$COMPOSE_FILE" ps agent 2>/dev/null | grep -q "healthy"; then
      log "agent 已就绪 ✓"
      break
    fi
    sleep 2
  done

  log "清理旧镜像..."
  docker image prune -f 2>/dev/null || true

  echo ""
  log "完成。容器状态:"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" ps
}

# ── 其他命令 ──────────────────────────────────────────
build() {
  cd "$PROJECT_DIR"
  local args=()
  [[ "${1:-}" == "--clean" ]] && args=(--no-cache)
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build "${args[@]}" agent
}

start_all() {
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
  sleep 3
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" ps
}

stop_all() {
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" down
}

restart_agent() {
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart agent
}

logs() {
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" logs -f --tail=100 "${@:-}"
}

status() {
  cd "$PROJECT_DIR"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" ps
}

# ── 用法 ──────────────────────────────────────────────
usage() {
  cat <<EOF
用法: $0 <命令>

命令:
  update         拉取代码 + 构建 agent + 启动（日常更新，默认用缓存）
  update --clean 同上，但强制 --no-cache 全量重建（依赖变更时用）
  build          仅构建 agent 镜像（默认缓存）
  build --clean  仅构建 agent 镜像（全量重建）
  start          启动全部服务
  stop           停止全部服务
  restart        重启 agent
  logs           查看日志（可指定服务名: logs agent）
  status         查看容器状态

示例:
  bash deploy/deploy.sh update           # 日常更新（快，利用缓存）
  bash deploy/deploy.sh update --clean   # 依赖变更后全量重建
EOF
}

# ── 主入口 ────────────────────────────────────────────
main() {
  check_prereqs

  case "${1:-}" in
    update)  check_env; update ;;
    build)   check_env; build ;;
    start)   check_env; start_all ;;
    stop)    stop_all ;;
    restart) check_env; restart_agent ;;
    logs)    shift; logs "$@" ;;
    status)  status ;;
    *)       usage; exit 1 ;;
  esac
}

main "$@"
