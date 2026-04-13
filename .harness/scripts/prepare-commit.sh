#!/bin/bash
# HARNESS METADATA
# type: script
# part-of: harness-architecture
# scope: git-workflow
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
#
# 原子提交辅助脚本
# 帮助开发者规划和执行原子提交

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🎯 原子提交辅助工具${NC}"
echo "===================="
echo ""

echo -e "${YELLOW}📋 当前变更文件:${NC}"
git status --short
echo ""

declare -A DOMAINS
declare -A FILES

DOMAINS=(
    ["harness"]="Harness架构"
    ["source"]="源代码"
    ["tests"]="测试代码"
    ["docs"]="文档"
    ["config"]="配置"
    ["scripts"]="脚本"
    ["other"]="其他"
)

while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    file=$(echo "$line" | sed 's/^.. //')

    if [[ "$file" =~ ^\.harness/ ]] || [[ "$file" == "AGENTS.md" ]] || [[ "$file" == "harness.yaml" ]]; then
        FILES["harness"]+="$file\n"
    elif [[ "$file" =~ ^src/ ]]; then
        FILES["source"]+="$file\n"
    elif [[ "$file" =~ ^tests/ ]] || [[ "$file" =~ ^e2e/ ]]; then
        FILES["tests"]+="$file\n"
    elif [[ "$file" =~ \.md$ ]] || [[ "$file" =~ ^docs/ ]]; then
        FILES["docs"]+="$file\n"
    elif [[ "$file" =~ \.json$ ]] || [[ "$file" =~ \.yaml$ ]] || [[ "$file" =~ ^config/ ]]; then
        FILES["config"]+="$file\n"
    else
        FILES["other"]+="$file\n"
    fi
done < <(git status --porcelain)

for key in harness source tests docs config other; do
    if [[ -n "${FILES[$key]}" ]]; then
        echo -e "\n${GREEN}[${DOMAINS[$key]}]${NC}"
        echo -e "${FILES[$key]}" | sed '/^$/d' | sed 's/^/  /'
    fi
done

echo ""
echo -e "${YELLOW}💡 建议的原子提交拆分:${NC}"
echo ""

COMMIT_COUNT=0

if [[ -n "${FILES["harness"]}" ]]; then
    COMMIT_COUNT=$((COMMIT_COUNT + 1))
    echo -e "${BLUE}提交 $COMMIT_COUNT: Harness 架构${NC}"
    echo "  git add .harness/ AGENTS.md harness.yaml"
    echo "  git commit -m \"harness: adapt to mm-coder TypeScript project\""
    echo ""
fi

if [[ -n "${FILES["source"]}" ]]; then
    COMMIT_COUNT=$((COMMIT_COUNT + 1))
    echo -e "${BLUE}提交 $COMMIT_COUNT: 源代码变更${NC}"
    echo "  git add src/"
    echo "  git commit -m \"<type>(<scope>): <description>\""
    echo ""
fi

if [[ -n "${FILES["tests"]}" ]]; then
    COMMIT_COUNT=$((COMMIT_COUNT + 1))
    echo -e "${BLUE}提交 $COMMIT_COUNT: 测试代码${NC}"
    echo "  git add tests/ e2e/"
    echo "  git commit -m \"test(<scope>): add tests for feature X\""
    echo ""
fi

if [[ -n "${FILES["docs"]}" ]]; then
    COMMIT_COUNT=$((COMMIT_COUNT + 1))
    echo -e "${BLUE}提交 $COMMIT_COUNT: 文档更新${NC}"
    echo "  git add docs/ *.md"
    echo "  git commit -m \"docs(<scope>): update documentation\""
    echo ""
fi

echo ""
echo -e "${YELLOW}🚀 下一步操作:${NC}"
echo ""
echo "1) 按建议拆分提交 (推荐)"
echo "2) 查看当前变更详情"
echo "3) 直接提交所有 (不推荐)"
echo "4) 取消"
echo ""
read -p "选择 [1-4]: " choice

case $choice in
    1)
        echo ""
        echo -e "${GREEN}请手动执行上述建议的 git add 和 git commit 命令${NC}"
        echo "或使用 git add -p 进行补丁级别的精选提交"
        ;;
    2)
        echo ""
        git diff --cached --stat
        ;;
    3)
        echo ""
        echo -e "${YELLOW}⚠️  警告: 您选择了非原子提交${NC}"
        read -p "请说明为什么需要合并提交: " reason
        git commit -m "WIP: $reason"
        echo -e "${GREEN}已提交，但建议未来遵循原子提交原则${NC}"
        ;;
    4)
        echo "取消操作"
        exit 0
        ;;
    *)
        echo "无效选择"
        exit 1
        ;;
esac
