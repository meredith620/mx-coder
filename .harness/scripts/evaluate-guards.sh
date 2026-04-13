#!/bin/bash
# HARNESS METADATA
# type: script
# part-of: harness-architecture
# scope: guard-execution
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
#
# 熵防护规则执行引擎
# 解析并执行 .harness/guards/*.rule 文件中定义的规则

set -e

# 检测终端颜色支持
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
    ncolors=$(tput colors 2>/dev/null)
    if [ -n "$ncolors" ] && [ "$ncolors" -ge 8 ]; then
        RED=$(tput setaf 1)
        GREEN=$(tput setaf 2)
        YELLOW=$(tput setaf 3)
        BLUE=$(tput setaf 4)
        NC=$(tput sgr0)
        BOLD=$(tput bold)
    else
        RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""; BOLD=""
    fi
else
    RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""; BOLD=""
fi

echo "${BLUE}${BOLD}🛡️  熵防护规则执行引擎${NC}"
echo "========================"
echo ""

GUARDS_DIR=".harness/guards"
TOTAL_VIOLATIONS=0
TOTAL_WARNINGS=0

if [ ! -d "$GUARDS_DIR" ]; then
    echo -e "${RED}❌ 错误: $GUARDS_DIR 目录不存在${NC}"
    exit 1
fi

RULE_FILES=$(find "$GUARDS_DIR" -name "*.rule" 2>/dev/null)

if [ -z "$RULE_FILES" ]; then
    echo -e "${YELLOW}⚠️  未找到任何 .rule 文件${NC}"
    exit 0
fi

echo -e "${YELLOW}📋 检查 $(( $(echo "$RULE_FILES" | wc -l) )) 个熵防护规则...${NC}"
echo ""

# 获取变更的文件
CHANGED_FILES=$(git diff --cached --name-only 2>/dev/null || git diff --name-only 2>/dev/null || echo "")

for rule_file in $RULE_FILES; do
    rule_name=$(basename "$rule_file" .rule)
    echo -e "${BLUE}检查: $rule_name${NC}"

    case "$rule_name" in
        "protect-harness-files")
            # 检查是否修改了受保护的 Harness 文件
            protected_patterns=(
                "^AGENTS\.md"
                "^harness\.yaml"
                "^\.harness/"
            )

            for pattern in "${protected_patterns[@]}"; do
                if echo "$CHANGED_FILES" | grep -qE "$pattern"; then
                    echo -e "  ${YELLOW}⚠️  检测到受保护文件变更: $pattern${NC}"
                    echo -e "  请确认这是有意的 Harness 修改，而非意外变更"
                    TOTAL_WARNINGS=$((TOTAL_WARNINGS + 1))
                fi
            done
            ;;

        "enforce-layer-separation")
            # 检查 CLI/IPC 层是否直接 spawn Claude Code
            cli_files=$(find src/index.ts src/ipc/ -name "*.ts" 2>/dev/null || echo "")

            for cli_file in $cli_files; do
                if grep -q "child_process.*spawn\|spawn.*claude" "$cli_file" 2>/dev/null; then
                    echo -e "  ${RED}❌ 违规: $cli_file 包含直接进程 spawn${NC}"
                    echo -e "     CLI/IPC 层应通过 CLIPlugin 执行 Claude Code"
                    TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + 1))
                fi
                if grep -q "MattermostPlugin\|require.*mattermost" "$cli_file" 2>/dev/null; then
                    echo -e "  ${RED}❌ 违规: $cli_file 直接引用 IM Plugin 实现${NC}"
                    echo -e "     CLI/IPC 层应通过 IMPlugin 接口调用"
                    TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + 1))
                fi
            done

            # 检查 IM Plugin 是否直接访问 SessionRegistry
            im_files=$(find src/plugins/im/ -name "*.ts" 2>/dev/null || echo "")
            for im_file in $im_files; do
                if grep -q "SessionRegistry" "$im_file" 2>/dev/null; then
                    echo -e "  ${RED}❌ 违规: $im_file 包含 SessionRegistry 引用${NC}"
                    echo -e "     IM Plugin 应通过 daemon 间接调用 SessionRegistry"
                    TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + 1))
                fi
            done
            ;;

        "no-direct-sessions-modification")
            # 检查是否有直接修改 sessions.json 的模式
            suspicious_patterns=(
                "echo.*sessions\.json"
                "cat.*>.*sessions\.json"
                "tee.*sessions\.json"
                "vim.*sessions\.json"
                "vi.*sessions\.json"
            )

            # 白名单：测试脚本目录
            shell_files=$(find . -name "*.sh" -type f 2>/dev/null \
                | grep -v "^./\.harness/" \
                | grep -v "^./tests/" \
                | grep -v "^./e2e/" || echo "")

            for pattern in "${suspicious_patterns[@]}"; do
                for sh_file in $shell_files; do
                    if grep -qE "$pattern" "$sh_file" 2>/dev/null; then
                        echo -e "  ${RED}❌ 违规: $sh_file 包含直接 sessions.json 修改${NC}"
                        echo -e "     请通过 mm-coder 命令或 daemon IPC 修改"
                        TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + 1))
                    fi
                done
            done
            ;;

        "enforce-atomic-commits")
            # 检查提交消息是否符合规范
            if git rev-parse --verify HEAD >/dev/null 2>&1; then
                last_msg=$(git log -1 --format="%s" HEAD 2>/dev/null || echo "")

                # 检查是否包含 type(scope): 格式
                if ! echo "$last_msg" | grep -qE "^[a-z]+(\([a-z-]+\))?: "; then
                    echo -e "  ${YELLOW}⚠️  建议: 提交消息格式不符合 conventional commits${NC}"
                    echo -e "     建议格式: <type>(<scope>): <subject>"
                    TOTAL_WARNINGS=$((TOTAL_WARNINGS + 1))
                fi
            fi
            ;;

        "require-test-coverage")
            # 检查关键模块变更是否有对应测试
            critical_files=(
                "src/session-registry"
                "src/im-worker-manager"
                "src/approval-manager"
                "src/daemon"
            )

            for critical in "${critical_files[@]}"; do
                if echo "$CHANGED_FILES" | grep -qE "$critical\.ts"; then
                    # 检查是否有对应的测试文件
                    test_pattern="tests/(unit|integration)/$(basename $critical)"
                    if ! echo "$CHANGED_FILES" | grep -qE "$test_pattern"; then
                        echo -e "  ${YELLOW}⚠️  注意: 关键模块 $(basename $critical) 变更但无对应测试更新${NC}"
                        TOTAL_WARNINGS=$((TOTAL_WARNINGS + 1))
                    fi
                fi
            done
            ;;

        *)
            echo -e "  ${YELLOW}⚠️  未知规则类型，跳过${NC}"
            ;;
    esac

    echo ""
done

# 汇总结果
echo "========================"
echo -e "${BLUE}📊 检查结果汇总${NC}"
echo ""

if [ $TOTAL_VIOLATIONS -gt 0 ]; then
    echo -e "${RED}❌ 发现 $TOTAL_VIOLATIONS 个违规${NC}"
    echo -e "${RED}   请修复上述问题后再提交${NC}"
    exit 1
elif [ $TOTAL_WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}⚠️  发现 $TOTAL_WARNINGS 个警告${NC}"
    echo -e "${YELLOW}   建议检查，但不影响提交${NC}"
    exit 0
else
    echo -e "${GREEN}✅ 所有熵防护规则检查通过${NC}"
    exit 0
fi
