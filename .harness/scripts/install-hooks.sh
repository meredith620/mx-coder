#!/bin/bash
# HARNESS METADATA
# type: script
# part-of: harness-architecture
# scope: git-integration
# managed-by: harness-system
# do-not-modify-manually: 如需修改请遵循 harness-evolution.spec.md
# version: 1.0
# created: 2026-04-01
#
# Git Hook 安装脚本
# 将 Harness 脚本链接为 git hooks

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🪝  Git Hook 安装脚本${NC}"
echo "======================"
echo ""

# 检查是否在 git 仓库中
if [ ! -d ".git" ]; then
    echo -e "${RED}❌ 错误: 当前目录不是 Git 仓库${NC}"
    exit 1
fi

# 确保 hooks 目录存在
mkdir -p .git/hooks

# 需要链接的 hooks（只包含实际的 git hooks）
HOOKS=(
    "pre-commit:.harness/scripts/pre-commit.sh"
)

echo -e "${YELLOW}安装 Git Hooks...${NC}"
echo ""

# 安装每个 hook
for hook_def in "${HOOKS[@]}"; do
    hook_name="${hook_def%%:*}"
    hook_script="${hook_def#*:}"
    
    if [ ! -f "$hook_script" ]; then
        echo -e "${RED}❌ 错误: $hook_script 不存在${NC}"
        continue
    fi
    
    # 检查是否已存在
    if [ -f ".git/hooks/$hook_name" ]; then
        if grep -q "harness" .git/hooks/$hook_name 2>/dev/null; then
            echo -e "${GREEN}✓ $hook_name hook 已存在且为 Harness hook${NC}"
        else
            echo -e "${YELLOW}⚠️  $hook_name hook 已存在，备份为 $hook_name.orig${NC}"
            mv .git/hooks/$hook_name .git/hooks/$hook_name.orig
        fi
    fi
    
    echo -e "链接 $hook_script → .git/hooks/$hook_name"
    ln -sf ../../$hook_script .git/hooks/$hook_name
    chmod +x .git/hooks/$hook_name
done

echo ""
echo -e "${GREEN}✅ Git Hooks 安装完成！${NC}"
echo ""

# 验证安装
echo "验证安装..."
for hook_def in "${HOOKS[@]}"; do
    hook_name="${hook_def%%:*}"
    if [ -L ".git/hooks/$hook_name" ]; then
        target=$(readlink .git/hooks/$hook_name)
        echo -e "  ${GREEN}✓${NC} $hook_name → $target"
    else
        echo -e "  ${RED}✗${NC} $hook_name 链接失败"
    fi
done

echo ""
echo -e "${BLUE}💡 提示:${NC}"
echo "  - 提交时会自动运行 pre-commit.sh 中的检查"
echo "  - 如需卸载，运行: rm .git/hooks/pre-commit"
echo "  - 如需临时跳过 hook，运行: git commit --no-verify"
echo ""

# 询问是否运行验证
read -p "是否现在运行架构验证? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    ./.harness/scripts/validate-arch.sh
fi
