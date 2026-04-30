#!/bin/bash
#
# Claude Code 原生命令支持度验证脚本
#
# 支持本地或远程执行验证
#
# 用法：
#   ./scripts/verify-native-commands.sh              # 使用远程 (默认)
#   ./scripts/verify-native-commands.sh --local      # 使用本地
#   ./scripts/verify-native-commands.sh --remote 10.10.10.88  # 指定远程主机
#   CLAUDE_CODE_LOCAL=1 ./scripts/verify-native-commands.sh  # 环境变量方式
#
set -e

# 默认值
MODE="${CLAUDE_CODE_MODE:-remote}"  # remote 或 local
REMOTE_HOST="${REMOTE_HOST:-10.10.10.88}"
NVM_SOURCE="source ~/.nvm/nvm.sh"

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --local)
            MODE="local"
            shift
            ;;
        --remote)
            MODE="remote"
            REMOTE_HOST="$2"
            shift 2
            ;;
        --help|-h)
            echo "用法: $0 [--local] [--remote <host>]"
            echo "  --local    使用本地 Claude Code"
            echo "  --remote   使用远程 Claude Code (默认: 10.10.10.88)"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            exit 1
            ;;
    esac
done

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=========================================="
echo "Claude Code 原生命令支持度验证"
echo "=========================================="
echo "执行模式: $MODE"
if [[ "$MODE" == "remote" ]]; then
    echo "远程主机: $REMOTE_HOST"
fi
echo ""

# ============================================================
# 执行命令的函数
# ============================================================
run_command() {
    local cmd="$1"

    if [[ "$MODE" == "local" ]]; then
        printf '%s\n' "$cmd" | claude -p 2>&1
    else
        ssh -o ConnectTimeout=10 -o BatchMode=yes "$REMOTE_HOST" "${NVM_SOURCE} && cd /tmp && printf '${cmd}\n' | claude -p 2>&1"
    fi
}

# 检查 Claude Code 是否可用
echo "检查 Claude Code 环境..."
if [[ "$MODE" == "local" ]]; then
    if ! command -v claude &> /dev/null; then
        echo -e "${RED}错误: 本地未找到 claude 命令${NC}"
        exit 1
    fi
    version=$(claude --version 2>&1)
    echo -e "${GREEN}本地 Claude Code: $version${NC}"
else
    # 检查远程 claude - 需要先加载 nvm
    if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$REMOTE_HOST" "${NVM_SOURCE} && which claude" &>/dev/null; then
        echo -e "${RED}错误: 远程主机未找到 claude 命令${NC}"
        exit 1
    fi
    version=$(ssh -o ConnectTimeout=10 "$REMOTE_HOST" "${NVM_SOURCE} && claude --version" 2>&1)
    echo -e "${GREEN}远程 Claude Code: $version${NC}"
fi
echo ""

# ============================================================
# 测试命令列表
# ============================================================
# 格式: "命令|预期结果(success/fail)"
declare -a COMMANDS=(
    "/cost|success"
    "/context|success"
    "/batch|success"
    "/loop|success"
    "/review|success"
    "/help|fail"
    "/model|fail"
    "/effort|fail"
    "/skills|fail"
    "/plan|fail"
    "/status|fail"
    "/diff|fail"
    "/memory|fail"
    "/doctor|fail"
    "/recap|fail"
    "/btw|fail"
)

# 结果计数
total=0
passed=0
failed=0
skipped=0

echo "开始验证..."
echo ""

for entry in "${COMMANDS[@]}"; do
    IFS='|' read -r cmd expected <<< "$entry"
    total=$((total + 1))

    echo -n "[$total] Testing $cmd ... "

    # 执行命令
    result=$(run_command "$cmd" || true)

    # 判断结果
    if [[ "$expected" == "success" ]]; then
        if [[ -z "$result" ]] || [[ "$result" == *"Unknown skill"* ]]; then
            echo -e "${YELLOW}UNEXPECTED${NC}"
            echo "    Expected success, got: ${result:0:80}"
            failed=$((failed + 1))
        else
            echo -e "${GREEN}PASS${NC}"
            passed=$((passed + 1))
        fi
    else  # expected fail
        if [[ "$result" == *"Unknown skill"* ]] || [[ "$result" == *"isn't available"* ]] || [[ "$result" == *"not available"* ]]; then
            echo -e "${GREEN}PASS${NC}"
            passed=$((passed + 1))
        elif [[ "$result" == *"I can't invoke"* ]]; then
            # 交互式命令有响应也算通过
            echo -e "${GREEN}PASS${NC} (interactive)"
            passed=$((passed + 1))
        elif [[ -z "$result" ]]; then
            # 无输出可能是后台命令，跳过
            echo -e "${YELLOW}SKIP${NC} (no output - may be background)"
            skipped=$((skipped + 1))
        else
            echo -e "${YELLOW}UNEXPECTED${NC}"
            echo "    Expected fail, got: ${result:0:80}"
            failed=$((failed + 1))
        fi
    fi
done

echo ""
echo "=========================================="
echo "验证结果汇总"
echo "=========================================="
echo -e "总计: $total  ${GREEN}通过: $passed${NC}  ${RED}失败: $failed${NC}  ${YELLOW}跳过: $skipped${NC}"
echo ""

if [[ $failed -eq 0 ]]; then
    echo -e "${GREEN}所有验证通过！${NC}"
    exit 0
else
    echo -e "${RED}有 $failed 项验证失败${NC}"
    exit 1
fi
