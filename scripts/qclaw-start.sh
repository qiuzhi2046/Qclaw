#!/usr/bin/env bash
# ============================================================
#  Qclaw 一键启动脚本
#  用法:  qclaw          — 启动开发模式 (默认)
#         qclaw dev      — 启动开发模式 (前台)
#         qclaw bg       — 后台启动并隐藏终端
#         qclaw stop     — 停止后台运行的服务
#         qclaw status   — 查看后台服务状态
#         qclaw log      — 查看后台运行日志
#         qclaw build    — 构建应用
#         qclaw test     — 运行测试
#         qclaw install  — 安装 / 更新依赖
#         qclaw update   — 从上游仓库拉取最新代码
#         qclaw help     — 显示帮助
# ============================================================

set -euo pipefail

# ── 颜色定义 ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

QCLAW_DIR="/Users/techdou/Project/Qclaw"
QCLAW_PID_FILE="$QCLAW_DIR/.qclaw-dev.pid"
QCLAW_LOG_FILE="$QCLAW_DIR/.qclaw-dev.log"

# ── 工具函数 ──────────────────────────────────────────────
info()    { echo -e "${CYAN}[Qclaw]${NC} $*"; }
success() { echo -e "${GREEN}[Qclaw ✔]${NC} $*"; }
warn()    { echo -e "${YELLOW}[Qclaw ⚠]${NC} $*"; }
error()   { echo -e "${RED}[Qclaw ✘]${NC} $*"; exit 1; }

banner() {
  echo -e "${BOLD}${CYAN}"
  echo "  ╔═══════════════════════════════════╗"
  echo "  ║          🐾  Qclaw  v2.2.0        ║"
  echo "  ║     OpenClaw Desktop Wizard       ║"
  echo "  ╚═══════════════════════════════════╝"
  echo -e "${NC}"
}

# ── 前置检查 ──────────────────────────────────────────────
check_prerequisites() {
  # 检查项目目录
  if [ ! -d "$QCLAW_DIR" ]; then
    error "项目目录不存在: $QCLAW_DIR"
  fi

  # 检查 Node.js
  if ! command -v node &>/dev/null; then
    error "未找到 Node.js，请先安装: https://nodejs.org/"
  fi

  # 检查 npm
  if ! command -v npm &>/dev/null; then
    error "未找到 npm，请先安装 Node.js"
  fi

  local node_ver
  node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$node_ver" -lt 18 ]; then
    warn "Node.js 版本建议 >= 18，当前: $(node -v)"
  fi
}

# ── 依赖检查 ──────────────────────────────────────────────
ensure_deps() {
  if [ ! -d "$QCLAW_DIR/node_modules" ]; then
    warn "未检测到 node_modules，正在安装依赖..."
    cd "$QCLAW_DIR" && npm install
    success "依赖安装完成"
  fi
}

# ── 命令: dev ─────────────────────────────────────────────
cmd_dev() {
  banner
  check_prerequisites
  ensure_deps
  info "正在启动开发服务器 (前台模式)..."
  echo ""
  cd "$QCLAW_DIR" && npm run dev
}

# ── 命令: bg (后台启动) ───────────────────────────────────
cmd_bg() {
  banner
  check_prerequisites
  ensure_deps

  # 检查是否已经有后台进程在运行
  if [ -f "$QCLAW_PID_FILE" ]; then
    local existing_pid
    existing_pid=$(cat "$QCLAW_PID_FILE")
    if kill -0 "$existing_pid" 2>/dev/null; then
      warn "Qclaw 已在后台运行 (PID: $existing_pid)"
      info "使用 'qclaw stop' 停止，或 'qclaw log' 查看日志"
      return 0
    else
      # PID 文件存在但进程已死，清理
      rm -f "$QCLAW_PID_FILE"
    fi
  fi

  info "正在后台启动开发服务器..."

  # 后台启动 npm run dev，日志输出到文件
  cd "$QCLAW_DIR"
  nohup npm run dev > "$QCLAW_LOG_FILE" 2>&1 &
  local bg_pid=$!
  echo "$bg_pid" > "$QCLAW_PID_FILE"

  # 等待一小段时间确认进程启动成功
  sleep 2
  if kill -0 "$bg_pid" 2>/dev/null; then
    success "Qclaw 已在后台启动 (PID: $bg_pid)"
    info "日志文件: $QCLAW_LOG_FILE"
    echo ""
    echo -e "  ${BOLD}常用命令:${NC}"
    echo -e "    ${GREEN}qclaw status${NC}  查看运行状态"
    echo -e "    ${GREEN}qclaw log${NC}     查看实时日志"
    echo -e "    ${GREEN}qclaw stop${NC}    停止后台服务"
    echo ""

    # macOS: 隐藏当前终端窗口
    if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
      info "正在隐藏终端窗口..."
      sleep 1
      osascript -e 'tell application "Terminal" to set miniaturized of front window to true' 2>/dev/null || true
    elif [ "$TERM_PROGRAM" = "iTerm.app" ]; then
      info "正在隐藏终端窗口..."
      sleep 1
      osascript -e 'tell application "iTerm2" to tell current window to miniaturize' 2>/dev/null || true
    fi
  else
    rm -f "$QCLAW_PID_FILE"
    error "后台启动失败，请查看日志: $QCLAW_LOG_FILE"
  fi
}

# ── 命令: stop (停止后台服务) ─────────────────────────────
cmd_stop() {
  banner
  if [ ! -f "$QCLAW_PID_FILE" ]; then
    warn "没有找到正在运行的 Qclaw 后台进程"
    return 0
  fi

  local pid
  pid=$(cat "$QCLAW_PID_FILE")

  if kill -0 "$pid" 2>/dev/null; then
    info "正在停止 Qclaw 后台进程 (PID: $pid)..."
    # 先发 SIGTERM，等待优雅退出
    kill "$pid" 2>/dev/null
    # 等待进程结束（最多 10 秒）
    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
      sleep 1
      count=$((count + 1))
    done
    # 如果还没退出，强制终止
    if kill -0 "$pid" 2>/dev/null; then
      warn "进程未响应，强制终止..."
      kill -9 "$pid" 2>/dev/null || true
    fi
    success "Qclaw 后台进程已停止"
  else
    warn "进程 (PID: $pid) 已不存在"
  fi

  rm -f "$QCLAW_PID_FILE"
}

# ── 命令: status (查看状态) ───────────────────────────────
cmd_status() {
  banner
  if [ ! -f "$QCLAW_PID_FILE" ]; then
    echo -e "  ${YELLOW}状态:${NC} 未运行"
    return 0
  fi

  local pid
  pid=$(cat "$QCLAW_PID_FILE")

  if kill -0 "$pid" 2>/dev/null; then
    echo -e "  ${GREEN}状态:${NC} 运行中"
    echo -e "  ${CYAN}PID:${NC}  $pid"
    echo -e "  ${CYAN}日志:${NC} $QCLAW_LOG_FILE"
  else
    echo -e "  ${YELLOW}状态:${NC} 已停止 (残留 PID 文件已清理)"
    rm -f "$QCLAW_PID_FILE"
  fi
}

# ── 命令: log (查看日志) ──────────────────────────────────
cmd_log() {
  if [ ! -f "$QCLAW_LOG_FILE" ]; then
    warn "没有找到日志文件"
    return 0
  fi

  info "实时日志 (Ctrl+C 退出):"
  echo "─────────────────────────────────────────"
  tail -f "$QCLAW_LOG_FILE"
}

# ── 命令: build ───────────────────────────────────────────
cmd_build() {
  banner
  check_prerequisites
  ensure_deps
  info "正在构建应用..."
  cd "$QCLAW_DIR" && npm run build
  success "构建完成！输出目录: $QCLAW_DIR/release"
}

# ── 命令: test ────────────────────────────────────────────
cmd_test() {
  banner
  check_prerequisites
  ensure_deps
  info "正在运行测试..."
  cd "$QCLAW_DIR" && npm test
}

# ── 命令: install ─────────────────────────────────────────
cmd_install() {
  banner
  check_prerequisites
  info "正在安装/更新依赖..."
  cd "$QCLAW_DIR" && npm install
  success "依赖安装完成"
}

# ── 命令: update ──────────────────────────────────────────
cmd_update() {
  banner
  check_prerequisites
  info "正在从上游仓库拉取最新代码..."
  cd "$QCLAW_DIR"

  # 检查是否有未提交的修改
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    warn "检测到本地修改，正在暂存..."
    git stash push -m "qclaw-auto-stash-$(date +%Y%m%d%H%M%S)" --include-untracked
    local stashed=true
  fi

  # 确保 upstream 远程存在
  if ! git remote get-url upstream &>/dev/null; then
    info "添加上游仓库..."
    git remote add upstream https://github.com/qiuzhi2046/Qclaw.git
  fi

  git fetch upstream
  git merge upstream/main --no-edit
  success "代码更新完成"

  # 恢复暂存
  if [ "${stashed:-}" = true ]; then
    info "正在恢复本地修改..."
    git stash pop
    success "本地修改已恢复"
  fi

  # 更新依赖
  info "正在同步依赖..."
  npm install
  success "全部更新完成！"
}

# ── 命令: help ────────────────────────────────────────────
cmd_help() {
  banner
  echo -e "  ${BOLD}用法:${NC}  qclaw [命令]"
  echo ""
  echo -e "  ${BOLD}启动命令:${NC}"
  echo -e "    ${GREEN}dev${NC}       启动开发模式 - 前台运行 ${YELLOW}(默认)${NC}"
  echo -e "    ${GREEN}bg${NC}        后台启动并隐藏终端 🐾"
  echo -e "    ${GREEN}stop${NC}      停止后台运行的服务"
  echo -e "    ${GREEN}status${NC}    查看后台服务状态"
  echo -e "    ${GREEN}log${NC}       查看后台运行日志"
  echo ""
  echo -e "  ${BOLD}开发命令:${NC}"
  echo -e "    ${GREEN}build${NC}     构建生产包"
  echo -e "    ${GREEN}test${NC}      运行测试"
  echo -e "    ${GREEN}install${NC}   安装/更新依赖"
  echo -e "    ${GREEN}update${NC}    从上游仓库同步最新代码"
  echo -e "    ${GREEN}help${NC}      显示本帮助信息"
  echo ""
  echo -e "  ${BOLD}示例:${NC}"
  echo -e "    qclaw            # 前台启动开发服务器"
  echo -e "    qclaw bg         # 后台启动，隐藏终端"
  echo -e "    qclaw stop       # 停止后台服务"
  echo -e "    qclaw log        # 查看实时日志"
  echo -e "    qclaw build      # 构建应用"
  echo ""
}

# ── 主入口 ────────────────────────────────────────────────
main() {
  local cmd="${1:-dev}"

  case "$cmd" in
    dev)      cmd_dev      ;;
    bg)       cmd_bg       ;;
    stop)     cmd_stop     ;;
    status)   cmd_status   ;;
    log)      cmd_log      ;;
    build)    cmd_build    ;;
    test)     cmd_test     ;;
    install)  cmd_install  ;;
    update)   cmd_update   ;;
    help|-h|--help) cmd_help ;;
    *)
      error "未知命令: $cmd (使用 'qclaw help' 查看帮助)"
      ;;
  esac
}

main "$@"
